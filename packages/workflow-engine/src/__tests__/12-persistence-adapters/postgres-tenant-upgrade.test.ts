import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
// The file as alpha.21 shipped it, the baseline for upgrades and behaviour.
const released = fileURLToPath(
  new URL("./released-enqueue-alpha.21.sql", import.meta.url),
);
const seven =
  "workflow_engine_enqueue(text, text, text, jsonb, jsonb, integer, text)";
const nine =
  "workflow_engine_enqueue(text, text, text, jsonb, jsonb, integer, text, text, jsonb)";

describe.skipIf(!databaseUrl)("tenant attribution PostgreSQL upgrade", () => {
  let admin: Client;
  let id: string;
  let schemas: string[];
  let schema: string;

  async function newSchema() {
    const name = `tenant_upgrade_${id}_${schemas.length}`;
    schemas.push(name);
    await admin.query(`CREATE SCHEMA "${name}"`);
    return name;
  }

  beforeEach(async () => {
    id = crypto.randomUUID().replaceAll("-", "");
    schemas = [];
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    schema = await newSchema();
    await admin.query(`SET search_path TO "${schema}", public`);
  });

  afterEach(async () => {
    try {
      await admin.query("RESET search_path");
      await admin.query(
        `DROP SCHEMA IF EXISTS ${schemas.map((name) => `"${name}"`).join(", ")} CASCADE`,
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
      return { code: failure.code, stderr: failure.stderr ?? "" };
    }
  }
  const psql = (...args: string[]) => psqlWith({}, ...args);

  // Split at each ";" that ends a line outside the $$ function body, as a
  // migration runner's statement splitter does.
  function statements(sql: string) {
    const result: string[] = [];
    let current = "";
    let inBody = false;
    for (const line of sql.split("\n")) {
      if (!inBody && line.startsWith("--")) continue;
      current += `${line}\n`;
      if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inBody = !inBody;
      if (!inBody && line.trimEnd().endsWith(";")) {
        result.push(current);
        current = "";
      }
    }
    return result;
  }

  // A migration runner sending the whole file as one query (one implicit
  // transaction), or each statement as a prepared statement until one fails.
  async function viaClient(searchPath: string, perStatement: boolean) {
    const text = await readFile(enqueue, "utf8");
    const parts = perStatement ? statements(text) : [text];
    if (perStatement) expect(parts).toHaveLength(4);
    await admin.query(`SET search_path TO "${searchPath}"`);
    try {
      for (const [index, part] of parts.entries()) {
        await admin.query(
          perStatement ? { name: `install-${index}`, text: part } : part,
        );
      }
      return { code: 0, stderr: "" };
    } catch (error) {
      return { code: 1, stderr: String((error as { code?: string }).code) };
    } finally {
      await admin.query(`SET search_path TO "${schema}", public`);
    }
  }

  // Engine tables with the schema's own status enum, so the alpha.21 body's
  // "Status" cast resolves through the same search path as its tables.
  async function engineTables(target: string) {
    await admin.query(`
      CREATE TYPE "${target}"."Status" AS ENUM ('PENDING', 'RUNNING');
      CREATE TABLE "${target}".workflow_runs (LIKE public.workflow_runs INCLUDING ALL);
      ALTER TABLE "${target}".workflow_runs ALTER COLUMN status DROP DEFAULT,
        ALTER COLUMN status TYPE "${target}"."Status" USING status::text::"${target}"."Status",
        ALTER COLUMN status SET DEFAULT 'PENDING';
      CREATE TABLE "${target}".idempotency_keys (LIKE public.idempotency_keys INCLUDING ALL);
      CREATE TABLE "${target}".outbox_events (LIKE public.outbox_events INCLUDING ALL);
    `);
  }

  async function engine(...files: string[]) {
    const name = await newSchema();
    await engineTables(name);
    for (const file of files) {
      expect(await psqlWith({ searchPath: name }, "-f", file)).toMatchObject({
        code: 0,
      });
    }
    return name;
  }

  async function functions(target: string) {
    const { rows } = await admin.query(
      `SELECT p.oid::int AS oid, p.pronargs AS args,
              p.proowner::regrole::text AS owner, p.proacl::text[] AS acl,
              obj_description(p.oid, 'pg_proc') AS comment
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'workflow_engine_enqueue' AND n.nspname = $1
        ORDER BY p.pronargs`,
      [target],
    );
    return rows;
  }

  // Calls `<target>.workflow_engine_enqueue` under a search path and returns
  // the run ID, or the SQLSTATE.
  async function enqueueId(
    target: string,
    searchPath: string,
    args: 7 | 9,
    key: string = crypto.randomUUID(),
  ): Promise<string | { code?: string }> {
    const extra = args === 9 ? ", 'tenant-a', '{}'" : "";
    await admin.query(`SET search_path TO ${searchPath}`);
    try {
      const {
        rows: [created],
      } = await admin.query(
        `SELECT "${target}".workflow_engine_enqueue($1, 'wf', 'Workflow', '{}', '{}', 5, NULL${extra}) AS id`,
        [key],
      );
      return created.id;
    } catch (error) {
      return { code: (error as { code?: string }).code };
    } finally {
      await admin.query(`SET search_path TO "${schema}", public`);
    }
  }

  // The engines among `engines` that hold the new run, or the SQLSTATE.
  async function call(
    target: string,
    searchPath: string,
    args: 7 | 9,
    engines: string[],
  ) {
    const id = await enqueueId(target, searchPath, args);
    if (typeof id !== "string") return id.code;
    const found: string[] = [];
    for (const name of engines) {
      const { rowCount } = await admin.query(
        `SELECT FROM "${name}".workflow_runs WHERE id = $1`,
        [id],
      );
      if (rowCount) found.push(name);
    }
    return found;
  }

  async function renameSchema(from: string, to: string) {
    await admin.query(`ALTER SCHEMA "${from}" RENAME TO "${to}"`);
    schemas[schemas.indexOf(from)] = to;
  }

  // The three tables the attribution upgrade alters, as alpha.21 shipped them.
  async function releasedAttributionTables() {
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
  }

  // The wrapper, a 4-, 7- and 9-argument call each create a run in `target`;
  // only the 9-argument call attributes it.
  async function expectEnqueues(target: string, wrapper = true) {
    const calls = [
      ...(wrapper ? ['"enqueue_order"($1)'] : []),
      "workflow_engine_enqueue($1, 'wf', 'Workflow', '{}')",
      "workflow_engine_enqueue($1, 'wf', 'Workflow', '{}', '{}', 5, NULL)",
      `workflow_engine_enqueue($1, 'wf', 'Workflow', '{}', '{}', 5, NULL, 'tenant-a', '{"queue":"batch"}')`,
    ];
    await admin.query(`SET search_path TO "${target}"`);
    try {
      const tenants: Array<string | null> = [];
      for (const sql of calls) {
        const {
          rows: [created],
        } = await admin.query(`SELECT ${sql} AS id`, [crypto.randomUUID()]);
        const { rows } = await admin.query(
          'SELECT "tenantId" FROM workflow_runs WHERE id = $1',
          [created.id],
        );
        tenants.push(...rows.map((row) => row.tenantId));
      }
      expect(tenants).toEqual([
        ...calls.slice(0, -1).map(() => null),
        "tenant-a",
      ]);
    } finally {
      await admin.query(`SET search_path TO "${schema}", public`);
    }
  }

  it.each([
    [
      "the alpha.21 command, psql -f",
      (path: string) =>
        psqlWith({ stop: false, searchPath: path }, "-f", enqueue),
      2,
    ],
    [
      "psql -v ON_ERROR_STOP=1 -f",
      (path: string) => psqlWith({ searchPath: path }, "-f", enqueue),
      2,
    ],
    [
      "psql --single-transaction -f",
      (path: string) =>
        psqlWith(
          { stop: false, searchPath: path },
          "--single-transaction",
          "-f",
          enqueue,
        ),
      1,
    ],
    [
      "the documented psql command",
      (path: string) =>
        psqlWith({ searchPath: path }, "--single-transaction", "-f", enqueue),
      1,
    ],
    [
      "one query holding the whole file",
      (path: string) => viaClient(path, false),
      1,
    ],
    [
      "one prepared statement per statement",
      (path: string) => viaClient(path, true),
      2,
    ],
  ] as const)("leaves a working enqueue after %s", async (_style, run, functionsAfterFailure) => {
    // Upgrade alpha.21 with another owner, a restricted ACL, a comment and
    // a dependent wrapper; the seven-argument function keeps all of them.
    const upgraded = await engine(released);
    const fn = `"${upgraded}".${seven}`;
    await admin.query(`
        REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION ${fn} TO pg_monitor WITH GRANT OPTION;
        ALTER FUNCTION ${fn} OWNER TO pg_read_all_settings;
        CREATE FUNCTION "${upgraded}".enqueue_order(k text) RETURNS text LANGUAGE SQL
          RETURN "${upgraded}".workflow_engine_enqueue(k, 'orders', 'Orders', '{}', '{}', 5, NULL);
      `);
    const [before] = await functions(upgraded);
    expect(before).toMatchObject({
      args: 7,
      owner: "pg_read_all_settings",
      acl: [
        "pg_read_all_settings=X/pg_read_all_settings",
        "pg_monitor=X*/pg_read_all_settings",
      ],
      comment: expect.stringContaining("Create a PENDING workflow run"),
    });
    // The second pass re-runs a completed install.
    for (const _pass of [1, 2]) {
      expect(await run(upgraded)).toMatchObject({
        code: 0,
        stderr: expect.not.stringContaining("ERROR"),
      });
      expect(await functions(upgraded)).toEqual([
        before,
        expect.objectContaining({ args: 9, acl: null }),
      ]);
      await expectEnqueues(upgraded);
    }

    // A failing statement: the leading schema holds another function with
    // the released argument types under other parameter names.
    const conflicting = await engine();
    await admin.query(`
        CREATE FUNCTION "${conflicting}".workflow_engine_enqueue(
          report_key text, b text, c text, d jsonb, e jsonb, f integer, g text
        ) RETURNS text LANGUAGE sql RETURN 'report';
      `);
    const [own] = await functions(conflicting);
    expect(await run(conflicting)).toMatchObject({
      stderr: expect.stringContaining("42P13"),
    });
    const after = await functions(conflicting);
    expect(after).toHaveLength(functionsAfterFailure);
    expect(after[0]).toMatchObject({ oid: own.oid, args: 7 });
    expect(
      (
        await admin.query(
          `SELECT "${conflicting}".workflow_engine_enqueue('k', 'b', 'c', '{}', '{}', 5, NULL) AS id`,
        )
      ).rows,
    ).toEqual([{ id: "report" }]);
    if (after.length === 2) {
      expect(
        await call(conflicting, `"${conflicting}"`, 9, [conflicting]),
      ).toEqual([conflicting]);
    }
  });

  // Each scenario runs once on alpha.21 engines and once on engines upgraded
  // from alpha.21: the 7-argument outcome must match alpha.21's, and the
  // 9-argument call must land wherever the 7-argument call does.
  async function compare<T>(
    scenario: (files: string[], args: 7 | 9) => Promise<T>,
  ) {
    const before = await scenario([released], 7);
    expect(await scenario([released, enqueue], 7)).toEqual(before);
    expect(await scenario([released, enqueue], 9)).toEqual(before);
    return before;
  }

  it("resolves tables through the caller's search path exactly as alpha.21 does", async () => {
    const outcome = await compare(async (files, args) => {
      const [a, b] = [await engine(...files), await engine(...files)];
      const empty = await newSchema();
      const label = (found: string[] | string | undefined) =>
        Array.isArray(found)
          ? found.map((name) => (name === a ? "a" : "b"))
          : found;
      return {
        own: label(await call(a, `"${a}"`, args, [a, b])),
        other: label(await call(a, `"${b}"`, args, [a, b])),
        otherFirst: label(await call(a, `"${b}", "${a}"`, args, [a, b])),
        noEngine: label(await call(a, `"${empty}"`, args, [a, b])),
      };
    });
    expect(outcome).toEqual({
      own: ["a"],
      other: ["b"],
      otherFirst: ["b"],
      noEngine: "42P01",
    });
  });

  it("fires an insert trigger without its own search path exactly as alpha.21 does", async () => {
    const outcome = await compare(async (files, args) => {
      const e = await engine(...files);
      await admin.query(`
        CREATE TABLE "${e}".run_audit (run_id text);
        CREATE FUNCTION "${e}".audit_new_run() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO run_audit VALUES (NEW.id);
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER audit AFTER INSERT ON "${e}".workflow_runs
          FOR EACH ROW EXECUTE FUNCTION "${e}".audit_new_run();
      `);
      const found = await call(e, `"${e}"`, args, [e]);
      const {
        rows: [{ audited }],
      } = await admin.query(
        `SELECT count(*)::int AS audited FROM "${e}".run_audit r
           JOIN "${e}".workflow_runs w ON w.id = r.run_id`,
      );
      return { found: Array.isArray(found) ? found.length : found, audited };
    });
    expect(outcome).toEqual({ found: 1, audited: 1 });
  });

  it("follows schema renames and exchanges exactly as alpha.21 does", async () => {
    const outcome = await compare(async (files, args) => {
      const before = await engine(...files);
      const renamed = `${before}_renamed`;
      await renameSchema(before, renamed);
      const afterRename = await call(renamed, `"${renamed}"`, args, [renamed]);

      // Two engines store the same key, then exchange names in one transaction.
      const [a, b] = [await engine(...files), await engine(...files)];
      const shared = crypto.randomUUID();
      await enqueueId(a, `"${a}"`, args, shared);
      await enqueueId(b, `"${b}"`, args, shared);
      await admin.query(`
        BEGIN;
        ALTER SCHEMA "${a}" RENAME TO "${a}_swap";
        ALTER SCHEMA "${b}" RENAME TO "${a}";
        ALTER SCHEMA "${a}_swap" RENAME TO "${b}";
        COMMIT;
      `);
      const {
        rows: [stored],
      } = await admin.query(
        `SELECT result->>'workflowRunId' AS id FROM "${a}".idempotency_keys WHERE key = $1`,
        [shared],
      );
      const label = (found: string[] | string | undefined) =>
        Array.isArray(found)
          ? found.map((name) => ({ [a]: "a", [b]: "b" })[name] ?? "renamed")
          : found;
      return {
        afterRename: label(afterRename),
        fresh: label(await call(a, `"${a}"`, args, [a, b])),
        replayFromNamedSchema:
          (await enqueueId(a, `"${a}"`, args, shared)) === stored.id,
      };
    });
    expect(outcome).toEqual({
      afterRename: ["renamed"],
      fresh: ["a"],
      replayFromNamedSchema: true,
    });
  });

  it("keeps a role restricted to the seven-argument function enqueueing with the documented grant", async () => {
    const e = await engine(released);
    const role = `enqueue_role_${id}`;
    await admin.query(`
      CREATE ROLE "${role}";
      GRANT USAGE ON SCHEMA "${e}" TO "${role}";
      GRANT SELECT, INSERT, UPDATE
        ON "${e}".workflow_runs, "${e}".idempotency_keys, "${e}".outbox_events
        TO "${role}";
      REVOKE EXECUTE ON FUNCTION "${e}".${seven} FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION "${e}".${seven} TO "${role}";
    `);
    const enqueueAsRole = async () => {
      await admin.query(`SET ROLE "${role}"`);
      try {
        return await enqueueId(e, `"${e}"`, 7);
      } finally {
        await admin.query("RESET ROLE");
      }
    };
    const install = (...acl: string[]) =>
      psqlWith(
        { searchPath: e },
        "--single-transaction",
        "-f",
        enqueue,
        ...acl.flatMap((statement) => ["-c", statement]),
      );
    try {
      expect(await enqueueAsRole()).toEqual(expect.any(String));
      const [releasedFunction] = await functions(e);

      // The seven-argument function calls the new overload as its caller.
      expect(
        await install(`REVOKE EXECUTE ON FUNCTION ${nine} FROM PUBLIC`),
      ).toMatchObject({ code: 0 });
      expect(await enqueueAsRole()).toEqual({ code: "42501" });

      expect(
        await install(
          `REVOKE EXECUTE ON FUNCTION ${nine} FROM PUBLIC`,
          `GRANT EXECUTE ON FUNCTION ${nine} TO "${role}"`,
        ),
      ).toMatchObject({ code: 0 });
      expect(await enqueueAsRole()).toEqual(expect.any(String));
      const [after, overload] = await functions(e);
      expect(after).toEqual(releasedFunction);
      expect(overload.acl).toEqual([
        `${overload.owner}=X/${overload.owner}`,
        `${role}=X/${overload.owner}`,
      ]);
    } finally {
      await admin.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
  });

  it("installs both signatures on a fresh database with the default ACL", async () => {
    await engineTables(schema);
    expect(
      await psql(
        "--single-transaction",
        "-f",
        enqueue,
        "-c",
        `GRANT EXECUTE ON FUNCTION ${nine} TO missing_enqueue_role`,
      ),
    ).toMatchObject({ code: 1, stderr: expect.stringContaining("42704") });
    expect(await functions(schema)).toEqual([]);

    expect(await psql("--single-transaction", "-f", enqueue)).toMatchObject({
      code: 0,
    });
    expect(
      (await functions(schema)).map(({ args, acl }) => ({ args, acl })),
    ).toEqual([
      { args: 7, acl: null },
      { args: 9, acl: null },
    ]);
    await expectEnqueues(schema, false);
  });

  it("fails the column upgrade while an attribution index name holds another definition", async () => {
    await releasedAttributionTables();
    await admin.query(
      'CREATE INDEX "ai_calls_workflowRunId_idx" ON ai_calls (topic)',
    );
    expect(await psql("-f", schemaUpgrade)).toMatchObject({
      code: 3,
      stderr: expect.stringContaining(
        "Attribution index ai_calls_workflowRunId_idx is missing, invalid or not defined as planned",
      ),
    });
    await admin.query('DROP INDEX "ai_calls_workflowRunId_idx"');
    expect(await psql("-f", schemaUpgrade)).toMatchObject({ code: 0 });
    expect(
      (
        await admin.query(
          `SELECT pg_get_indexdef('"ai_calls_workflowRunId_idx"'::regclass) AS definition`,
        )
      ).rows[0].definition,
    ).toContain('USING btree ("workflowRunId")');
  });

  it.skipIf(process.env.PRISMA_MAJOR !== "6")(
    "lets a cache-disabled Prisma 6 claim finish while an AI table reader blocks its ALTER",
    async () => {
      await releasedAttributionTables();
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
          stderr: expect.stringContaining(
            "is missing, invalid or not defined as planned",
          ),
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
