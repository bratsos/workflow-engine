import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
const oldSignature =
  "workflow_engine_enqueue(text,text,text,jsonb,jsonb,integer,text)";
const newSignature =
  "workflow_engine_enqueue(text,text,text,jsonb,jsonb,integer,text,text,jsonb)";

describe.skipIf(!databaseUrl)("tenant attribution PostgreSQL upgrade", () => {
  let admin: Client;
  let schema: string;

  beforeEach(async () => {
    schema = `tenant_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(
      `CREATE SCHEMA "${schema}"; SET search_path TO "${schema}", public`,
    );
  });

  afterEach(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });

  async function psql(...args: string[]) {
    const url = new URL(databaseUrl!);
    const password = decodeURIComponent(url.password);
    url.password = "";
    try {
      await promisify(execFile)(
        "psql",
        [
          "-X",
          "-v",
          "ON_ERROR_STOP=1",
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
            PGOPTIONS: `-c search_path=${schema}`,
          },
        },
      );
      return { code: 0, stderr: "" };
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      if (typeof failure.code !== "number") throw error;
      return { code: failure.code, stderr: failure.stderr };
    }
  }

  async function privileges(signature: string) {
    const {
      rows: [row],
    } = await admin.query(
      `SELECT
         has_function_privilege('pg_read_all_settings', p.oid, 'EXECUTE') AS allowed,
         EXISTS (SELECT FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))
                 WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public
       FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
      [`${schema}.${signature}`],
    );
    return row;
  }

  it("installs with the intended ACL and rolls back when ACL installation fails", async () => {
    const acl = `REVOKE EXECUTE ON FUNCTION ${newSignature} FROM PUBLIC;
                 GRANT EXECUTE ON FUNCTION ${newSignature} TO pg_read_all_settings`;
    expect(
      await psql("--single-transaction", "-f", enqueue, "-c", "SELECT 1/0"),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("22012"),
    });
    expect(await privileges(newSignature)).toBeUndefined();
    expect(
      await psql("--single-transaction", "-f", enqueue, "-c", acl),
    ).toMatchObject({ code: 0 });
    expect(await privileges(newSignature)).toEqual({
      allowed: true,
      public: false,
    });
  });

  it("fails on tracked dependents and replaces the function, wrapper and ACL atomically", async () => {
    const wrapper = `CREATE FUNCTION enqueue_order(k text) RETURNS text LANGUAGE SQL
      RETURN "${schema}".workflow_engine_enqueue(k, 'orders', 'Orders', '{}', '{}', 5, NULL)`;
    await admin.query(`
      CREATE TABLE workflow_runs (LIKE public.workflow_runs INCLUDING ALL);
      CREATE TABLE idempotency_keys (LIKE public.idempotency_keys INCLUDING ALL);
      CREATE TABLE outbox_events (LIKE public.outbox_events INCLUDING ALL);
      CREATE FUNCTION workflow_engine_enqueue(text, text, text, jsonb, jsonb, integer, text)
      RETURNS text LANGUAGE SQL RETURN 'old';
      ${wrapper};
      REVOKE EXECUTE ON FUNCTION ${oldSignature} FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ${oldSignature} TO pg_read_all_settings;
    `);
    expect(await psql("--single-transaction", "-f", enqueue)).toMatchObject({
      code: 3,
      stderr: expect.stringContaining("2BP01"),
    });
    expect(await privileges(newSignature)).toBeUndefined();
    expect(await privileges(oldSignature)).toEqual({
      allowed: true,
      public: false,
    });
    expect(
      (await admin.query("SELECT enqueue_order('before') AS id")).rows,
    ).toEqual([{ id: "old" }]);

    const dir = await mkdtemp(join(tmpdir(), "enqueue-upgrade-"));
    try {
      const before = join(dir, "before.sql");
      const after = join(dir, "after.sql");
      await writeFile(before, "DROP FUNCTION enqueue_order(text);\n");
      await writeFile(
        after,
        `
        REVOKE EXECUTE ON FUNCTION ${newSignature} FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION ${newSignature} TO pg_read_all_settings;
        ${wrapper};
      `,
      );
      expect(
        await psql(
          "--single-transaction",
          "-f",
          before,
          "-f",
          enqueue,
          "-f",
          after,
        ),
      ).toMatchObject({ code: 0 });
      expect(await privileges(oldSignature)).toBeUndefined();
      expect(await privileges(newSignature)).toEqual({
        allowed: true,
        public: false,
      });
      const {
        rows: [created],
      } = await admin.query("SELECT enqueue_order($1) AS id", [
        `upgrade-${schema}`,
      ]);
      expect(created?.id).toBeTruthy();
      expect(
        (
          await admin.query("SELECT id FROM workflow_runs WHERE id = $1", [
            created?.id,
          ])
        ).rows,
      ).toEqual([created]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
