import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrismaWorkflowPersistence } from "../../persistence/prisma/index.js";
import { createPostgresClient } from "../utils/postgres-client.js";

const databaseUrl = process.env.DATABASE_URL;
const sqlPath = (file: string) =>
  fileURLToPath(new URL(`../../../sql/${file}`, import.meta.url));
const enqueue = sqlPath("enqueue.sql");
const schemaUpgrade = sqlPath("tenant-attribution.sql");
const newSignature =
  "workflow_engine_enqueue(text, text, text, jsonb, jsonb, integer, text, text, jsonb)";

describe.skipIf(!databaseUrl)("tenant attribution PostgreSQL upgrade", () => {
  let admin: Client;
  let schema: string;
  let other: string;

  beforeEach(async () => {
    const id = crypto.randomUUID().replaceAll("-", "");
    schema = `tenant_upgrade_${id}`;
    other = `tenant_other_${id}`;
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(
      `CREATE SCHEMA "${schema}"; CREATE SCHEMA "${other}"; SET search_path TO "${schema}", public`,
    );
  });

  afterEach(async () => {
    try {
      await admin.query(
        `DROP SCHEMA IF EXISTS "${schema}", "${other}" CASCADE`,
      );
    } finally {
      await admin.end();
    }
  });

  async function psqlWith(
    { stop = true, searchPath = schema },
    ...args: string[]
  ) {
    const url = new URL(databaseUrl!);
    const password = decodeURIComponent(url.password);
    url.password = "";
    try {
      const { stderr } = await promisify(execFile)(
        "psql",
        [
          "-X",
          ...(stop ? ["-v", "ON_ERROR_STOP=1"] : []),
          "-v",
          "VERBOSITY=verbose",
          "--dbname",
          url.toString(),
          ...args,
        ],
        {
          timeout: 10_000,
          env: {
            ...process.env,
            PGPASSWORD: password,
            PGOPTIONS: `-c search_path=${searchPath}`,
          },
        },
      );
      return { code: 0, stderr };
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      if (typeof failure.code !== "number") throw error;
      return { code: failure.code, stderr: failure.stderr };
    }
  }
  const psql = (...args: string[]) => psqlWith({}, ...args);

  // A migration tool that sends the file as one query, or each statement
  // as a prepared statement; the second only accepts a single statement.
  async function viaClient(prepared: boolean) {
    const text = await readFile(enqueue, "utf8");
    try {
      await admin.query(prepared ? { name: "install-enqueue", text } : text);
      return { code: 0, stderr: "" };
    } catch (error) {
      return { code: 1, stderr: String((error as { code?: string }).code) };
    }
  }

  async function engineTables(target: string) {
    await admin.query(`
      CREATE TABLE "${target}".workflow_runs (LIKE public.workflow_runs INCLUDING ALL);
      CREATE TABLE "${target}".idempotency_keys (LIKE public.idempotency_keys INCLUDING ALL);
      CREATE TABLE "${target}".outbox_events (LIKE public.outbox_events INCLUDING ALL);
    `);
  }

  // The released seven-argument signature, by default owned by another role
  // with a restricted ACL. The schema's default privileges would add a grant
  // to any function created later.
  async function releasedFunction(target: string, restricted = true) {
    const fn = `"${target}".workflow_engine_enqueue(text, text, text, jsonb, jsonb, integer, text)`;
    await admin.query(`
      CREATE FUNCTION "${target}".workflow_engine_enqueue(text, text, text, jsonb,
        jsonb DEFAULT '{}', integer DEFAULT 5, text DEFAULT NULL)
      RETURNS text LANGUAGE SQL RETURN 'old';
      ${
        restricted
          ? `REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC;
             GRANT EXECUTE ON FUNCTION ${fn} TO pg_monitor WITH GRANT OPTION;
             ALTER FUNCTION ${fn} OWNER TO pg_read_all_settings;`
          : ""
      }
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${target}"
        GRANT EXECUTE ON FUNCTIONS TO pg_read_all_stats;
    `);
  }

  async function installed() {
    const { rows } = await admin.query(
      `SELECT n.nspname AS schema, p.pronargs AS args,
              p.proowner::regrole::text AS owner, p.proacl::text[] AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'workflow_engine_enqueue' AND n.nspname IN ($1, $2)
        ORDER BY n.nspname, p.pronargs`,
      [schema, other],
    );
    return rows;
  }

  const wrapper =
    () => `CREATE FUNCTION enqueue_order(k text) RETURNS text LANGUAGE SQL
    RETURN "${schema}".workflow_engine_enqueue(k, 'orders', 'Orders', '{}', '{}', 5, NULL)`;

  it.each([
    [
      "the alpha.21 command, psql -f",
      () => psqlWith({ stop: false }, "-f", enqueue),
      0,
    ],
    ["psql -v ON_ERROR_STOP=1 -f", () => psql("-f", enqueue), 3],
    [
      "psql --single-transaction -f",
      () => psqlWith({ stop: false }, "--single-transaction", "-f", enqueue),
      0,
    ],
    [
      "the documented psql command",
      () => psql("--single-transaction", "-f", enqueue),
      3,
    ],
    ["one query holding the whole file", () => viaClient(false), 1],
    ["one prepared statement", () => viaClient(true), 1],
  ] as const)("installs atomically through %s, keeping the old owner and ACL", async (_style, run, failureCode) => {
    await engineTables(schema);
    await releasedFunction(schema);
    await admin.query(wrapper());
    const before = await installed();
    expect(before).toEqual([
      {
        schema,
        args: 7,
        owner: "pg_read_all_settings",
        acl: [
          "pg_read_all_settings=X/pg_read_all_settings",
          "pg_monitor=X*/pg_read_all_settings",
        ],
      },
    ]);

    // A tracked dependent fails the install and leaves the old function.
    expect(await run()).toMatchObject({
      code: failureCode,
      stderr: expect.stringContaining("2BP01"),
    });
    expect(await installed()).toEqual(before);
    expect((await admin.query("SELECT enqueue_order('k') AS id")).rows).toEqual(
      [{ id: "old" }],
    );

    await admin.query("DROP FUNCTION enqueue_order(text)");
    // The second pass re-runs a completed install.
    for (const _rerun of [1, 2]) {
      expect(await run()).toMatchObject({
        code: 0,
        stderr: expect.not.stringContaining("ERROR"),
      });
      expect(await installed()).toEqual([{ ...before[0], args: 9 }]);
    }
    const {
      rows: [created],
    } = await admin.query(
      `SELECT "${schema}".workflow_engine_enqueue('k', 'wf', 'Workflow', '{}') AS id`,
    );
    expect(
      (await admin.query(`SELECT id FROM "${schema}".workflow_runs`)).rows,
    ).toEqual([created]);
  });

  it("replaces the function around recreated wrappers in one transaction", async () => {
    await engineTables(schema);
    await releasedFunction(schema);
    await admin.query(wrapper());
    const before = await installed();
    const dir = await mkdtemp(join(tmpdir(), "enqueue-upgrade-"));
    const upgrade = (after: string) =>
      psql(
        "--single-transaction",
        "-c",
        "SET LOCAL lock_timeout = '500ms'",
        "-f",
        join(dir, "before-enqueue.sql"),
        "-f",
        enqueue,
        "-f",
        join(dir, after),
      );
    try {
      await writeFile(
        join(dir, "before-enqueue.sql"),
        "DROP FUNCTION enqueue_order(text);\n",
      );
      await writeFile(join(dir, "after-enqueue.sql"), `${wrapper()};\n`);
      await writeFile(join(dir, "broken.sql"), `${wrapper()};\nSELECT 1/0;\n`);

      expect(await upgrade("broken.sql")).toMatchObject({
        code: 3,
        stderr: expect.stringContaining("22012"),
      });
      expect(await installed()).toEqual(before);
      expect(
        (await admin.query("SELECT enqueue_order('k') AS id")).rows,
      ).toEqual([{ id: "old" }]);

      expect(await upgrade("after-enqueue.sql")).toMatchObject({ code: 0 });
      expect(await installed()).toEqual([{ ...before[0], args: 9 }]);
      const {
        rows: [created],
      } = await admin.query("SELECT enqueue_order($1) AS id", [
        `upgrade-${schema}`,
      ]);
      expect((await admin.query("SELECT id FROM workflow_runs")).rows).toEqual([
        created,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("installs beside the tables the search path finds and leaves another schema's function alone", async () => {
    await engineTables(schema);
    await engineTables(other);
    await releasedFunction(other);
    const [untouched] = await installed();

    expect(
      await psqlWith(
        { searchPath: `${schema},${other}` },
        "--single-transaction",
        "-f",
        enqueue,
      ),
    ).toMatchObject({ code: 0 });
    expect(await installed()).toEqual([
      untouched,
      expect.objectContaining({ schema, args: 9, acl: null }),
    ]);
    expect(
      (
        await admin.query(
          `SELECT "${other}".workflow_engine_enqueue('k', 'wf', 'Workflow', '{}') AS id`,
        )
      ).rows,
    ).toEqual([{ id: "old" }]);

    // The new function writes its own schema's tables whatever the caller's
    // search path.
    await admin.query(`SET search_path TO "${other}", "${schema}"`);
    const {
      rows: [created],
    } = await admin.query(
      `SELECT "${schema}".workflow_engine_enqueue('k', 'wf', 'Workflow', '{}') AS id`,
    );
    expect(
      (await admin.query(`SELECT id FROM "${schema}".workflow_runs`)).rows,
    ).toEqual([created]);
    expect(
      (await admin.query(`SELECT id FROM "${other}".workflow_runs`)).rows,
    ).toEqual([]);
  });

  it("replaces the engine schema's function in place when an earlier schema on the search path has no tables", async () => {
    await engineTables(schema);
    await releasedFunction(schema);
    const before = await installed();

    expect(await psqlWith({ searchPath: other }, "-f", enqueue)).toMatchObject({
      code: 3,
      stderr: expect.stringContaining("42P01"),
    });
    expect(await installed()).toEqual(before);

    expect(
      await psqlWith({ searchPath: `${other},${schema}` }, "-f", enqueue),
    ).toMatchObject({ code: 0 });
    expect(await installed()).toEqual([{ ...before[0], args: 9 }]);
  });

  it("copies a default ACL on upgrade instead of the schema's default privileges", async () => {
    await engineTables(schema);
    await releasedFunction(schema, false);
    const [{ owner }] = await installed();

    expect(await psql("-f", enqueue)).toMatchObject({ code: 0 });
    expect(await installed()).toEqual([
      { schema, args: 9, owner, acl: [`=X/${owner}`, `${owner}=X/${owner}`] },
    ]);
  });

  it("keeps the default ACL on a fresh install and commits the documented REVOKE and GRANT with it", async () => {
    await engineTables(schema);
    await engineTables(other);
    expect(
      await psql("--single-transaction", "-f", enqueue, "-c", "SELECT 1/0"),
    ).toMatchObject({ code: 1, stderr: expect.stringContaining("22012") });
    expect(await installed()).toEqual([]);
    expect(await psql("--single-transaction", "-f", enqueue)).toMatchObject({
      code: 0,
    });
    expect(await installed()).toEqual([
      expect.objectContaining({ schema, args: 9, acl: null }),
    ]);

    const restricted = (role: string) =>
      psqlWith(
        { searchPath: other },
        "--single-transaction",
        "-f",
        enqueue,
        "-c",
        `REVOKE EXECUTE ON FUNCTION ${newSignature} FROM PUBLIC`,
        "-c",
        `GRANT EXECUTE ON FUNCTION ${newSignature} TO ${role}`,
      );
    expect(await restricted("missing_enqueue_role")).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("42704"),
    });
    expect(await installed()).toHaveLength(1);
    expect(await restricted("pg_monitor")).toMatchObject({ code: 0 });
    const { owner, acl } = (await installed()).find(
      (fn) => fn.schema === other,
    );
    expect(acl).toEqual([`${owner}=X/${owner}`, `pg_monitor=X/${owner}`]);
  });

  it.skipIf(process.env.PRISMA_MAJOR !== "6")(
    "lets a cache-disabled Prisma 6 claim finish while an AI table reader blocks its ALTER",
    async () => {
      await admin.query(`
        CREATE TYPE "Status" AS ENUM ('PENDING', 'RUNNING');
        CREATE TABLE workflow_runs (LIKE public.workflow_runs INCLUDING DEFAULTS);
        ALTER TABLE workflow_runs DROP COLUMN "tenantId", DROP COLUMN labels,
          ALTER COLUMN status DROP DEFAULT,
          ALTER COLUMN status TYPE "Status" USING status::text::"Status",
          ALTER COLUMN status SET DEFAULT 'PENDING';
        CREATE TABLE ai_calls (LIKE public.ai_calls INCLUDING DEFAULTS);
        ALTER TABLE ai_calls DROP COLUMN "workflowRunId", DROP COLUMN "tenantId",
          DROP COLUMN labels, DROP COLUMN "textExpiresAt";
        CREATE TABLE idempotency_keys (LIKE public.idempotency_keys INCLUDING DEFAULTS);
        ALTER TABLE idempotency_keys DROP COLUMN "workflowRunId";
      `);
      const url = new URL(databaseUrl!);
      url.searchParams.set("schema", schema);
      url.searchParams.set("connection_limit", "1");
      url.searchParams.set("statement_cache_size", "0");
      const prisma = createPostgresClient(url.toString());
      const persistence = createPrismaWorkflowPersistence(prisma, {
        definitionVersioning: false,
      });
      const claim = () =>
        persistence.withTransaction((tx) => tx.claimNextPendingRun());
      try {
        await expect(claim()).resolves.toBeNull();
        await admin.query("BEGIN; SELECT count(*) FROM ai_calls");
        try {
          // Keep the AI read transaction open until the unrelated run claim
          // and the migration's bounded lock attempt both settle.
          const [upgrade, claimResult] = await Promise.all([
            psql("-f", schemaUpgrade),
            claim(),
          ]);
          expect(upgrade).toMatchObject({
            code: 3,
            stderr: expect.stringContaining("55P03"),
          });
          expect(claimResult).toBeNull();
          const { rows } = await admin.query(
            "SELECT attname FROM pg_attribute WHERE attrelid = 'workflow_runs'::regclass AND attname IN ('tenantId', 'labels') ORDER BY attname",
          );
          expect(rows).toEqual([
            { attname: "labels" },
            { attname: "tenantId" },
          ]);
        } finally {
          await admin.query("ROLLBACK");
        }
        // A failed concurrent build reserves the name even though the
        // index cannot serve reads. Detect that case before reporting success.
        await admin.query(`
          INSERT INTO workflow_runs (
            id, "updatedAt", "workflowId", "workflowName", "workflowType", input, status, "tenantId"
          ) VALUES
            ('one', now(), 'wf', 'Workflow', 'wf', '{}', 'RUNNING', 'tenant-a'),
            ('two', now(), 'wf', 'Workflow', 'wf', '{}', 'RUNNING', 'tenant-a')
        `);
        expect(
          await psql(
            "-c",
            'CREATE UNIQUE INDEX CONCURRENTLY "workflow_runs_tenantId_createdAt_id_idx" ON workflow_runs ("tenantId")',
          ),
        ).toMatchObject({
          code: 1,
          stderr: expect.stringContaining("23505"),
        });
        expect(await psql("-f", schemaUpgrade)).toMatchObject({
          code: 3,
          stderr: expect.stringContaining("is missing or invalid"),
        });
        await admin.query(
          'DROP INDEX CONCURRENTLY "workflow_runs_tenantId_createdAt_id_idx"',
        );
        expect(await psql("-f", schemaUpgrade)).toMatchObject({ code: 0 });
        expect(await psql("-f", schemaUpgrade)).toMatchObject({ code: 0 });
        await expect(claim()).resolves.toBeNull();
      } finally {
        await prisma.$disconnect();
      }
    },
  );
});
