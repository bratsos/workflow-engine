/**
 * Query plans of the `engine.stats` queries and of the outbox claim, against
 * a real database: SQLite (`SQLITE8_KERNEL_SQLITE=1`, Prisma 6, 7 or 8) and
 * Postgres (`DATABASE_URL`).
 *
 * The stats queries count active work only. That is true only while each one
 * is planned from an index that leads with the active column; a plan that
 * walks the table reads every terminal row, which accumulate without limit.
 * This was found by measuring: SQLite drove the unpublished-outbox query and
 * the claim's candidate select from `outbox_events_dlqAt_idx` (`dlqAt IS NULL`
 * is true of every published row), and Postgres with no statistics did the
 * same inside a BitmapAnd. See `LIVE_OUTBOX` in `persistence/prisma/persistence.ts`.
 *
 * What it does: records the SQL each adapter really sends (the client's query
 * log on Prisma 6 and 7, the compiled plan on Prisma 8), asks the database for
 * the plan of every statement, and asserts the expected index and no scan of
 * an engine table. Every captured statement must match exactly one expectation
 * below, so a new stats query fails here until its index is named.
 *
 * What it proves, and what it does not:
 * - SQLite stats checks exercise the no-statistics plan. Claim and sequence
 *   lookup checks also build analysed tables, both kinds of stale statistics
 *   and statistics taken after the outbox drained.
 * - Postgres needs the owner of the engine tables and a role that may `DELETE
 *   FROM pg_statistic` (a superuser; the CI role `postgres` is both and owns
 *   the tables `prisma db push` created): the tests `ALTER TABLE ... SET
 *   (autovacuum_enabled)` and delete statistics. Every state described below
 *   is built, not assumed, so no test depends on what ran against the database
 *   before. As an ordinary non-owner role they fail with `must be owner of
 *   table`.
 * - Postgres, forced (`enable_seqscan = off`, a few seeded rows): a sequential
 *   scan appears only when no index can serve the statement. So this checks
 *   that an index path exists and which index is preferred among them,
 *   independent of row counts. It cannot see a plan that is cheaper only while
 *   the planner has no statistics.
 * - Postgres, not forced, at scale ("at scale, no forced plan" below): the
 *   tables are bulk-loaded (100,000 published outbox events and 100,000
 *   terminal runs, stages and jobs) and the plan is whatever the planner
 *   chooses, first for tables it has no statistics for (`reltuples = -1`, no
 *   `pg_statistic` rows, autovacuum off: a fresh bulk load), then after
 *   `ANALYZE`. Parameters are inlined as the driver sends them, which for the
 *   dead-letter count's `OFFSET` makes it a quoted literal; that form allows a
 *   parallel sequential scan, which the parameterised statement does not.
 * - Every PostgreSQL EXPLAIN and timed dispatch runs as an ordinary role.
 *   Claim and sequence cases cover 0, 10,000 and 100,000 rows. The timed
 *   dispatches use a dense run and a backlog of 28,000 independent runs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../../kernel/index.js";
import { InMemoryBlobStore } from "../../kernel/testing/index.js";
import {
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "../../persistence/prisma/index.js";
import { rawFor } from "../../persistence/prisma/prisma-client-type.js";
import { InMemoryJobQueue } from "../../testing/index.js";

const major = process.env.PRISMA_MAJOR ?? "7";
const sqlite = process.env.SQLITE8_KERNEL_SQLITE === "1";
const databaseUrl = process.env.DATABASE_URL;
const fixtures = createRequire(import.meta.url)(
  "../../../../prisma-fixtures/index.cjs",
);

interface Statement {
  sql: string;
  params: unknown[];
}

/** One query and the index its plan must use. */
interface Expectation {
  name: string;
  matches: (sql: string) => boolean;
  /** Regular expression source for the index name (Prisma 8 SQLite appends a hash suffix). */
  index: string;
  /** Regular expression source for an index the plan must not use. */
  not?: string;
}

const STATS: Expectation[] = [
  {
    name: "runs by status and oldest pending",
    matches: (sql) => sql.includes("workflow_runs"),
    index: "workflow_runs_status_",
  },
  {
    name: "stages by status",
    matches: (sql) =>
      sql.includes("workflow_stages") && !sql.includes("nextPollAt"),
    index: "workflow_stages_status_idx",
  },
  {
    // Either index serves it and neither reads terminal rows in bulk: the
    // status index holds only the stages of one status; the nextPollAt index
    // is read up to now, and a terminal stage keeps its deadline only until
    // its job is settled (see stage-poll-suspended.ts). Postgres picks the
    // second once its statistics say few stages have a deadline.
    name: "due suspended stages",
    matches: (sql) =>
      sql.includes("workflow_stages") && sql.includes("nextPollAt"),
    index: "workflow_stages_(status|nextPollAt)_idx",
  },
  {
    name: "jobs by status and oldest pending",
    matches: (sql) => sql.includes("job_queue"),
    index: "job_queue_status_",
  },
  {
    name: "unpublished outbox events and the oldest",
    matches: (sql) =>
      sql.includes("outbox_events") && sql.includes("publishedAt"),
    index:
      "outbox_events_(publishedAt_idx|live_run_sequence_idx|delivery_run_idx)",
    not: "outbox_events_dlqAt_idx",
  },
  {
    name: "dead-lettered outbox events",
    matches: (sql) =>
      sql.includes("outbox_events") &&
      sql.includes("dlqAt") &&
      !sql.includes("publishedAt"),
    index: "outbox_events_dlqAt_idx",
  },
];

/** The query that acquires a bounded page of scheduled run heads. */
const CLAIM: Expectation = {
  name: "indexed outbox claim",
  matches: (sql) => /^\s*WITH RECURSIVE cursor AS MATERIALIZED/i.test(sql),
  index: "outbox_events_live_run_sequence_idx",
};
const UNPUBLISHED: Expectation = {
  name: "unpublished outbox inspection",
  matches: (sql) =>
    /ORDER BY/i.test(sql) &&
    sql.includes("outbox_events") &&
    !CLAIM.matches(sql) &&
    !ROTATION.matches(sql),
  index:
    "outbox_events_(publishedAt_idx|live_run_sequence_idx|delivery_run_idx)",
  not: "outbox_events_dlqAt_idx",
};

// SQLite's claim is a write; it first reads whether any live row exists.
const IDLE: Expectation = {
  name: "live outbox row before the SQLite claim",
  matches: (sql) =>
    !/ORDER BY/i.test(sql) &&
    /"publishedAt" IS NULL AND "dlqAt" IS NULL LIMIT 1/.test(sql),
  index: "outbox_events_(live_run_sequence_idx|delivery_run_idx)",
  not: "outbox_events_dlqAt_idx",
};

const ROTATION: Expectation = {
  name: "latest recorded outbox rotation",
  matches: (sql) =>
    /ORDER BY[^;]*["`]deliveryClaim["`] DESC[^;]*["`]workflowRunId["`] DESC/i.test(
      sql,
    ) &&
    sql.includes("outbox_events") &&
    !CLAIM.matches(sql),
  index: "outbox_events_delivery_cursor_idx",
};

/** A statement of the engine's: one that names an engine table. */
const ENGINE_TABLE =
  /\b(workflow_runs|workflow_stages|job_queue|outbox_events)\b/;

const SQLITE_TABLE_SCAN =
  /\bSCAN (main\.)?(t0|workflow_runs|workflow_stages|job_queue|outbox_events)\b/;

/** Opens a client for the Prisma major under test that records every statement it sends. */
async function openRecordingClient(file?: string, url = databaseUrl) {
  const statements: Statement[] = [];
  if (major === "8") {
    const db = sqlite
      ? await fixtures.createSqliteDb(file)
      : fixtures.createPostgresDb(url);
    const query = db.query.bind(db);
    const execute = db.execute.bind(db);
    const capture = (plan: any) => {
      const parts: unknown[] | undefined = plan.ast?.parts;
      if (parts) {
        const params: unknown[] = [];
        let sql = "";
        for (const part of parts as any[]) {
          if (typeof part === "string") sql += part;
          else {
            params.push(part.value);
            sql += `$${params.length}`;
          }
        }
        statements.push({ sql, params });
      }
    };
    const transaction = db.transaction.bind(db);
    db.transaction = (work: (tx: any) => Promise<unknown>) =>
      transaction((tx: any) =>
        work({
          ...tx,
          raw: tx.raw,
          query: (plan: any) => {
            capture(plan);
            return tx.query(plan);
          },
          execute: (plan: any) => {
            capture(plan);
            return tx.execute(plan);
          },
        }),
      );
    db.query = (plan: any) => {
      capture(plan);
      return query(plan);
    };
    db.execute = (plan: any) => {
      capture(plan);
      return execute(plan);
    };
    const client = Object.assign(fromPrisma8(db), {
      $disconnect: () => db.close(),
    });
    return { client, statements };
  }
  const options = { log: [{ emit: "event", level: "query" }] };
  const client = sqlite
    ? fixtures.createSqliteClient(file, options)
    : fixtures.createPostgresClient(url, options);
  client.$on("query", (e: { query: string; params: string }) =>
    statements.push({ sql: e.query, params: JSON.parse(e.params) }),
  );
  return { client, statements };
}

/** `$n` placeholders replaced by literals, so the plan can be asked for without bound parameters. */
function inlineParams(sql: string, params: unknown[]): string {
  const literal = (value: unknown): string => {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) return `'{${value.join(",")}}'`;
    return `'${String(value).replace(/'/g, "''")}'`;
  };
  return sql.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1]));
}

describe.skipIf(!sqlite && !databaseUrl)(
  `stats query plans on ${sqlite ? "SQLite" : "Postgres"} (Prisma ${major})`,
  () => {
    let directory: string | undefined;
    let client: any;
    let statements: Statement[];
    let persistence: ReturnType<typeof createPrismaWorkflowPersistence>;
    let queue: ReturnType<typeof createPrismaJobQueue>;
    const plannerRole = `outbox_plan_${process.pid}_${Math.floor(Math.random() * 1_000_000)}`;
    let plannerRoleCreated = false;

    async function truncate() {
      await client.$executeRawUnsafe(
        `TRUNCATE TABLE "job_queue", "workflow_annotations", "workflow_artifacts", "workflow_logs", "workflow_steps", "workflow_stages", "workflow_runs", "ai_calls", "outbox_events", "idempotency_keys" RESTART IDENTITY CASCADE`,
      );
    }

    // Postgres: the tables the statistics checks are about.
    const TABLES = [
      "workflow_runs",
      "workflow_stages",
      "job_queue",
      "outbox_events",
    ];
    const inTables = TABLES.map((table) => `'"${table}"'::regclass`).join(", ");

    /** How many of the tables carry planner statistics of any kind. */
    async function analysedTables(): Promise<number> {
      const [rows, stats] = await Promise.all([
        rawFor(client, { n: "int" }).$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM pg_class WHERE oid IN (${inTables}) AND reltuples <> -1`,
        ),
        rawFor(client, { n: "int" }).$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM pg_statistic WHERE starelid IN (${inTables})`,
        ),
      ]);
      return Number(rows[0].n) + Number(stats[0].n);
    }

    /**
     * Puts the tables in the state of a fresh bulk load: `TRUNCATE` resets
     * `reltuples`, but the `pg_statistic` rows an earlier `ANALYZE` (this
     * file's, a previous run's, an autovacuum's) left survive it, and an
     * autovacuum could analyse them again mid-test. Deleting from
     * `pg_statistic` needs a superuser, which the CI role is.
     */
    async function withoutStatistics() {
      for (const table of TABLES) {
        await client.$executeRawUnsafe(
          `ALTER TABLE "${table}" SET (autovacuum_enabled = false)`,
        );
      }
      await client.$executeRawUnsafe(
        `DELETE FROM pg_statistic WHERE starelid IN (${inTables})`,
      );
    }

    /**
     * The plan of one statement as text lines. On Postgres `forceIndex` turns
     * sequential scans off for the checking transaction; without it the plan
     * is whatever the planner chooses.
     */
    async function plan(
      statement: Statement,
      forceIndex: boolean,
      analyze = false,
    ): Promise<string> {
      if (sqlite) {
        const rows = await rawFor(client, {
          detail: "text",
        }).$queryRawUnsafe(
          `EXPLAIN QUERY PLAN ${statement.sql}`,
          ...statement.params,
        );
        return rows.map((row: any) => String(row.detail)).join("\n");
      }
      return client.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${plannerRole}"`);
        // Without this Postgres picks a sequential scan on a small table
        // whatever the indexes are. With it, a sequential scan appears only
        // when no index can serve the statement.
        const claim = CLAIM.matches(statement.sql);
        if (forceIndex || claim)
          await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        if (claim) {
          await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
          await tx.$executeRawUnsafe("SET LOCAL enable_sort = off");
          await tx.$executeRawUnsafe("SET LOCAL enable_incremental_sort = off");
          await tx.$executeRawUnsafe("SET LOCAL jit = off");
        }
        const rows = await rawFor(tx, {
          "QUERY PLAN": "text",
        }).$queryRawUnsafe(
          `EXPLAIN ${analyze ? "(ANALYZE, BUFFERS) " : ""}${inlineParams(statement.sql, statement.params)}`,
        );
        return rows.map((row: any) => String(row["QUERY PLAN"])).join("\n");
      });
    }

    async function record(run: () => Promise<unknown>): Promise<Statement[]> {
      statements.length = 0;
      await run();
      // Prisma 6 delivers its query events after the call has resolved: wait
      // until no more arrive.
      for (let seen = -1; seen !== statements.length; ) {
        seen = statements.length;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Only what touches an engine table: a driver also logs statements of its
      // own (the Prisma 6 engine's connection check is `SELECT 1`) and the
      // client's `BEGIN` and `COMMIT`, which are no query of the engine's.
      // An asynchronous query event from the previous EXPLAIN can also
      // arrive while recording the next operation.
      return statements.filter(
        (s) => ENGINE_TABLE.test(s.sql) && !/^\s*EXPLAIN\b/i.test(s.sql),
      );
    }

    /** Asserts the expected index and no scan of an engine table for one statement. */
    async function expectServedBy(
      expectation: Expectation,
      s: Statement,
      forceIndex: boolean,
    ) {
      const text = await plan(s, forceIndex);
      const message = `${expectation.name}\n${s.sql}\n${text}`;
      expect(text, message).toMatch(
        sqlite
          ? new RegExp(`USING (COVERING )?INDEX ${expectation.index}`)
          : new RegExp(
              `(Index (Only )?Scan (Backward )?using|Bitmap Index Scan on) "?${expectation.index}`,
            ),
      );
      expect(text, message).not.toMatch(
        sqlite ? SQLITE_TABLE_SCAN : /Seq Scan/,
      );
      if (expectation.not) {
        expect(text, message).not.toMatch(new RegExp(expectation.not));
      }
    }

    async function expectStatsPlans(
      forceIndex = true,
      connectionCheck = false,
      readShape?: "$queryRaw" | "$queryRawUnsafe",
    ) {
      const expose = (target: typeof client): typeof client =>
        new Proxy(target, {
          get(prisma, key) {
            if (
              (key === "$queryRaw" || key === "$queryRawUnsafe") &&
              key !== readShape
            )
              return undefined;
            if (key === "$withColumns" && prisma.$withColumns)
              return (...args: unknown[]) =>
                expose(prisma.$withColumns(...args));
            return Reflect.get(prisma, key, prisma);
          },
        });
      const view = readShape ? expose(client) : client;
      const options = {
        databaseType: sqlite ? ("sqlite" as const) : ("postgresql" as const),
      };
      const statsPort = readShape
        ? createPrismaWorkflowPersistence(view, options)
        : persistence;
      const jobPort = readShape ? createPrismaJobQueue(view, options) : queue;
      if (readShape) {
        // Verify dates outside the capture so only the stats statements are explained.
        await statsPort.getActiveWorkStats(new Date());
        await jobPort.getJobStats();
      }
      const captured = await record(() =>
        Promise.all([
          statsPort.getActiveWorkStats(new Date()),
          jobPort.getJobStats(),
          // What a driver's own connection check looks like in the log.
          ...(connectionCheck
            ? [rawFor(client, { n: "int" }).$queryRawUnsafe("SELECT 1 AS n")]
            : []),
        ]),
      );
      if (connectionCheck) {
        expect(statements.some((s) => !ENGINE_TABLE.test(s.sql))).toBe(true);
      }
      // Every statement is claimed by exactly one expectation and every
      // expectation by exactly one statement: a new query must be named here.
      for (const s of captured) {
        expect(
          STATS.filter((e) => e.matches(s.sql)),
          `unexpected or ambiguous stats statement: ${s.sql}`,
        ).toHaveLength(1);
      }
      for (const expectation of STATS) {
        const own = captured.filter((s) => expectation.matches(s.sql));
        expect(own, expectation.name).toHaveLength(1);
        await expectServedBy(expectation, own[0]!, forceIndex);
      }
    }

    async function expectClaimPlans(forceIndex = true) {
      const captured = await record(async () => {
        await persistence.getUnpublishedOutboxEvents(10);
        await persistence.claimOutboxDelivery(
          10,
          "2000-01-01T00:00:00.000Z|plans",
          new Date(),
          [],
        );
      });
      const candidates = captured.filter((s) => CLAIM.matches(s.sql));
      expect(candidates.length, "no claim candidate statement").toBeGreaterThan(
        0,
      );
      for (const s of candidates) await expectServedBy(CLAIM, s, forceIndex);
      for (const s of captured.filter((item) => UNPUBLISHED.matches(item.sql)))
        await expectServedBy(UNPUBLISHED, s, forceIndex);
      for (const s of captured.filter((item) => ROTATION.matches(item.sql)))
        await expectServedBy(ROTATION, s, forceIndex);
      const idle = captured.filter((item) => IDLE.matches(item.sql));
      expect(idle, IDLE.name).toHaveLength(sqlite ? 1 : 0);
      for (const s of idle) await expectServedBy(IDLE, s, forceIndex);
    }

    async function expectDeliveryWritePlans(
      forceIndex = true,
      allowSmallScan = false,
    ) {
      const now = new Date();
      const claim = "2099-01-01T00:00:00.000Z|plan-write";
      const runId = `zz-plan-write-${crypto.randomUUID()}`;
      await persistence.appendOutboxEvents([
        {
          workflowRunId: runId,
          eventType: "e",
          payload: {},
          causationId: "plan",
          occurredAt: now,
        },
      ]);
      const event = await client.outboxEvent.findFirst({
        where: { workflowRunId: runId },
      });
      const setClaim = () =>
        client.outboxEvent.updateMany({
          where: { id: event.id },
          data: {
            deliveryClaim: `r0000000000000000001|${claim}`,
            publishedAt: null,
            dlqAt: null,
            retryCount: 0,
          },
        });
      // The write by event ID, then (a failure) the release of the run's
      // other events by their stored claim, from the cursor index.
      const check = async (statementsToCheck: Statement[], count = 1) => {
        const updates = statementsToCheck.filter(
          (statement) =>
            /\bUPDATE\b/i.test(statement.sql) &&
            statement.sql.includes("outbox_events"),
        );
        expect(updates).toHaveLength(count);
        for (const [index, update] of updates.entries()) {
          const text = await plan(update, forceIndex);
          if (allowSmallScan) continue;
          expect(text).toMatch(
            index === 0
              ? sqlite
                ? /USING INDEX (sqlite_autoindex_outbox_events_1)/
                : /Index Scan using "?outbox_events_pkey/
              : sqlite
                ? /USING (COVERING )?INDEX outbox_events_delivery_cursor_idx/
                : /(Index (Only )?Scan using|Bitmap Index Scan on) "?outbox_events_delivery_cursor_idx/,
          );
          expect(text).not.toMatch(sqlite ? SQLITE_TABLE_SCAN : /Seq Scan/);
        }
      };
      // Drain Prisma 6's asynchronous query events before recording the next
      // operation, so the setup UPDATE is not mistaken for its write.
      await record(setClaim);
      const checks = await record(() =>
        persistence.isOutboxDeliveryClaimActive(event.id, claim, now),
      );
      const checkStatement = checks.find(
        (statement) =>
          /\bSELECT\b/i.test(statement.sql) &&
          statement.sql.includes("outbox_events"),
      );
      expect(checkStatement).toBeDefined();
      const checkPlan = await plan(checkStatement!, forceIndex);
      if (!allowSmallScan) {
        expect(checkPlan).toMatch(
          sqlite
            ? /USING (COVERING )?INDEX (sqlite_autoindex_outbox_events_1)/
            : /Index (Only )?Scan using "?outbox_events_pkey/,
        );
        expect(checkPlan).not.toMatch(sqlite ? SQLITE_TABLE_SCAN : /Seq Scan/);
      }
      await check(
        await record(() =>
          persistence.completeOutboxDelivery(event.id, claim, now),
        ),
      );
      await record(setClaim);
      await check(
        await record(() =>
          persistence.completeOutboxDeliveries([event.id], claim, now),
        ),
      );
      await record(setClaim);
      await check(
        await record(() =>
          persistence.failOutboxDelivery(event.id, claim, 3, now),
        ),
        2,
      );
      await client.outboxEvent.deleteMany({ where: { workflowRunId: runId } });
    }

    /** A few rows of each kind, in the statuses the stats queries tell apart. */
    async function seed() {
      const run = (id: string) => ({
        id,
        workflowId: "plans",
        workflowName: "plans",
        workflowType: "plans",
        input: {},
      });
      for (const [id, status] of [
        ["plan-pending", undefined],
        ["plan-running", "RUNNING"],
        ["plan-suspended", "SUSPENDED"],
        ["plan-done", "COMPLETED"],
      ] as const) {
        await persistence.createRun(run(id));
        if (status) await persistence.updateRun(id, { status });
      }
      const suspended = await persistence.createStage({
        workflowRunId: "plan-suspended",
        stageId: "wait",
        stageName: "wait",
        stageNumber: 1,
        executionGroup: 1,
        status: "SUSPENDED",
      });
      await persistence.updateStage(suspended.id, {
        nextPollAt: new Date(Date.now() - 60_000),
      });
      await persistence.createStage({
        workflowRunId: "plan-done",
        stageId: "done",
        stageName: "done",
        stageNumber: 1,
        executionGroup: 1,
        status: "COMPLETED",
      });
      await queue.enqueueParallel([
        { workflowRunId: "plan-pending", workflowId: "plans", stageId: "a" },
        { workflowRunId: "plan-running", workflowId: "plans", stageId: "b" },
      ]);
      await persistence.appendOutboxEvents(
        Array.from({ length: 6 }, (_, i) => ({
          workflowRunId: "plan-pending",
          eventType: "e",
          payload: {},
          causationId: `c${i}`,
          occurredAt: new Date(),
        })),
      );
      const events = await persistence.getUnpublishedOutboxEvents();
      await persistence.markOutboxEventsPublished(
        events.slice(0, 3).map((e) => e.id),
      );
      await persistence.moveOutboxEventToDLQ(events[3]!.id);
    }

    beforeAll(async () => {
      if (sqlite) {
        directory = await mkdtemp(join(tmpdir(), `stats-plans-${major}-`));
      }
      const opened = await openRecordingClient(
        directory ? join(directory, "plans.db") : undefined,
      );
      client = opened.client;
      statements = opened.statements;
      const options = {
        databaseType: sqlite ? ("sqlite" as const) : ("postgresql" as const),
      };
      persistence = createPrismaWorkflowPersistence(client, options);
      queue = createPrismaJobQueue(client, {
        ...options,
        workerId: "plans-worker",
      });
      if (!sqlite) {
        await client.$executeRawUnsafe(
          `CREATE ROLE "${plannerRole}" LOGIN PASSWORD 'outbox-plan-fixture'`,
        );
        plannerRoleCreated = true;
        await client.$executeRawUnsafe(
          `GRANT USAGE ON SCHEMA public TO "${plannerRole}"`,
        );
        await client.$executeRawUnsafe(
          `GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA public TO "${plannerRole}"`,
        );
        await truncate();
        await withoutStatistics();
      }
      await seed();
    }, 120_000);

    afterAll(async () => {
      if (!sqlite && client) {
        await truncate();
        for (const table of TABLES) {
          await client.$executeRawUnsafe(
            `ALTER TABLE "${table}" RESET (autovacuum_enabled)`,
          );
        }
        if (plannerRoleCreated) {
          await client.$executeRawUnsafe(`DROP OWNED BY "${plannerRole}"`);
          await client.$executeRawUnsafe(`DROP ROLE "${plannerRole}"`);
        }
      }
      await client?.$disconnect();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    describe(sqlite ? "without statistics" : "before ANALYZE", () => {
      // The premise of this describe, checked rather than assumed.
      beforeAll(async () => {
        if (sqlite) return;
        expect(
          await analysedTables(),
          "tables must start without statistics",
        ).toBe(0);
      });
      it("serves every stats query from its index", () => expectStatsPlans());
      it("ignores a statement that touches no engine table", () =>
        expectStatsPlans(true, true));
      it("serves the outbox claim's candidates from the live-run index", () =>
        expectClaimPlans());
      it("uses the primary key for publication and retry release", () =>
        expectDeliveryWritePlans());
    });

    // Not on SQLite: after ANALYZE it plans from the row counts, and on the two
    // or three rows seeded here a table scan is the cheaper plan. The choice
    // that matters there is the one made without statistics, which does not
    // depend on row counts and is what a database nobody ANALYZEd gets.
    describe.skipIf(sqlite)("after ANALYZE", () => {
      beforeAll(async () => {
        await client.$executeRawUnsafe("ANALYZE");
      });
      it("serves every stats query from its index", () => expectStatsPlans());
      it("serves the outbox claim's candidates from the live-run index", () =>
        expectClaimPlans());
      it("uses the primary key for publication and retry release", () =>
        expectDeliveryWritePlans());
    });

    // The forced tests above cannot see a plan that is cheaper only while the
    // planner has no statistics: a fresh bulk load, autovacuum off or behind.
    // These load the volumes the statements must not read (terminal rows,
    // published events) and take whatever plan the planner chooses.
    describe.skipIf(sqlite)("at scale, no forced plan", () => {
      const TERMINAL_ROWS = 100_000;
      const PUBLISHED_EVENTS = 100_000;
      beforeAll(async () => {
        await truncate();
        await withoutStatistics();
        const terminal = (statuses: string[]) =>
          `(ARRAY[${statuses.map((s) => `'${s}'`).join(",")}])[1 + g % ${statuses.length}]::"Status"`;
        await client.$executeRawUnsafe(
          `INSERT INTO "workflow_runs" (id, "updatedAt", "workflowId", "workflowName", "workflowType", status, input, "createdAt")
           SELECT 'a-scale-run-' || g, now(), 'plans', 'plans', 'plans', ${terminal(["COMPLETED", "FAILED", "CANCELLED"])}, '{}'::jsonb, now()
           FROM generate_series(1, ${TERMINAL_ROWS}) g`,
        );
        await client.$executeRawUnsafe(
          `INSERT INTO "workflow_stages" (id, "updatedAt", "workflowRunId", "stageId", "stageName", "stageNumber", "executionGroup", status)
           SELECT 'scale-stage-' || g, now(), 'a-scale-run-' || g, 's', 's', 1, 1, ${terminal(["COMPLETED", "FAILED", "SKIPPED", "CANCELLED"])}
           FROM generate_series(1, ${TERMINAL_ROWS}) g`,
        );
        await client.$executeRawUnsafe(
          `INSERT INTO "job_queue" (id, "updatedAt", "workflowRunId", "stageId", status, "createdAt")
           SELECT 'scale-job-' || g, now(), 'a-scale-run-' || g, 's', ${terminal(["COMPLETED", "FAILED", "CANCELLED"])}, now()
           FROM generate_series(1, ${TERMINAL_ROWS}) g`,
        );
        await client.$executeRawUnsafe(
          `INSERT INTO "outbox_events" (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt", "publishedAt")
           SELECT 'scale-event-' || g, 'a-scale-run-' || g, 1, 'e', '{}'::jsonb, 'c', now(), now()
           FROM generate_series(1, ${PUBLISHED_EVENTS}) g`,
        );
        // The live rows sort after every published one, the worst case for a
        // plan that walks the events in (workflowRunId, sequence) order.
        await seed();
        expect(
          await analysedTables(),
          "tables must start without statistics",
        ).toBe(0);
      }, 300_000);

      describe("never analysed", () => {
        it("serves every stats query from its index", () =>
          expectStatsPlans(false));
        it("serves the outbox claim's candidates without reading the dlqAt index", () =>
          expectClaimPlans(false));
        it("uses the primary key for publication and retry release", () =>
          expectDeliveryWritePlans());
      });

      describe("after ANALYZE", () => {
        beforeAll(async () => {
          await client.$executeRawUnsafe("ANALYZE");
        });
        it("serves every stats query from its index", () =>
          expectStatsPlans(false));
        it("serves the outbox claim's candidates from the live-run index", () =>
          expectClaimPlans(false));
        it("uses the primary key for publication and retry release", () =>
          expectDeliveryWritePlans());
      });
    });

    // Statistics taken while the rows were active, then the tables grew by
    // terminal rows and published events and nobody analysed them again (an
    // ANALYZE early in a deployment's life, autovacuum off or behind; SQLite
    // keeps `sqlite_stat1` until the next ANALYZE). The planner then believes
    // most rows are active or unpublished.
    describe("stale statistics: analysed while the rows were active, then grown by terminal rows", () => {
      const TABLES_GROWN = [
        "workflow_runs",
        "workflow_stages",
        "job_queue",
        "outbox_events",
      ] as const;

      /** Copies the row `template` of `table` `n` times under new ids (and new run ids). */
      async function grow(table: string, template: string, n: number) {
        const columns: string[] = sqlite
          ? (
              await rawFor(client, { name: "text" }).$queryRawUnsafe(
                `SELECT name FROM pragma_table_info('${table}')`,
              )
            ).map((r: any) => String(r.name))
          : (
              await rawFor(client, { name: "text" }).$queryRawUnsafe(
                `SELECT column_name AS name FROM information_schema.columns WHERE table_name = '${table}' AND table_schema = current_schema()`,
              )
            ).map((r: any) => String(r.name));
        const value = (column: string) =>
          column === "id"
            ? `'grown-' || g.x`
            : column === "workflowRunId" && table !== "workflow_runs"
              ? `'grown-' || g.x`
              : `t."${column}"`;
        const numbers = sqlite
          ? `(WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${n}) SELECT x FROM n)`
          : `(SELECT generate_series(1, ${n}) AS x)`;
        await client.$executeRawUnsafe(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")})
           SELECT ${columns.map(value).join(", ")} FROM "${table}" t, ${numbers} g WHERE t.id = '${template}'`,
        );
      }

      /** Root buffers an executed statement read (Postgres). */
      async function buffers(statement: Statement): Promise<number> {
        const rows = await rawFor(client, {
          "QUERY PLAN": "text",
        }).$queryRawUnsafe(
          `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) ${inlineParams(statement.sql, statement.params)}`,
        );
        const text = rows.map((r: any) => String(r["QUERY PLAN"])).join("\n");
        const match = text.match(/Buffers: shared( hit=(\d+))?( read=(\d+))?/);
        return Number(match?.[2] ?? 0) + Number(match?.[4] ?? 0);
      }

      async function pages(table: string): Promise<number> {
        const rows = await rawFor(client, { n: "int" }).$queryRawUnsafe(
          `SELECT pg_relation_size('"${table}"'::regclass)::int / current_setting('block_size')::int AS n`,
        );
        return Number(rows[0].n);
      }

      for (const n of [10_000, 100_000]) {
        describe(`${n.toLocaleString("en")} terminal rows`, () => {
          beforeAll(async () => {
            if (sqlite) {
              for (const table of TABLES_GROWN)
                await client.$executeRawUnsafe(`DELETE FROM "${table}"`);
            } else {
              await truncate();
              await withoutStatistics();
            }
            // Active rows (and unpublished events) only, then the statistics.
            await seed();
            await client.$executeRawUnsafe(
              `UPDATE "outbox_events" SET "publishedAt" = NULL, "dlqAt" = NULL`,
            );
            await client.$executeRawUnsafe(
              `UPDATE "workflow_runs" SET status = 'RUNNING' WHERE id = 'plan-done'`,
            );
            await client.$executeRawUnsafe(
              `UPDATE "workflow_stages" SET status = 'RUNNING' WHERE status = 'COMPLETED'`,
            );
            for (const table of TABLES_GROWN)
              await client.$executeRawUnsafe(`ANALYZE "${table}"`);
            // The active rows finish and terminal history grows.
            const done = sqlite ? `'COMPLETED'` : `'COMPLETED'::"Status"`;
            await client.$executeRawUnsafe(
              `UPDATE "workflow_runs" SET status = ${done}`,
            );
            await client.$executeRawUnsafe(
              `UPDATE "workflow_stages" SET status = ${done}, "nextPollAt" = NULL`,
            );
            await client.$executeRawUnsafe(
              `UPDATE "job_queue" SET status = ${done}`,
            );
            await client.$executeRawUnsafe(
              `UPDATE "outbox_events" SET "publishedAt" = "occurredAt"`,
            );
            await grow("workflow_runs", "plan-done", n);
            for (const table of [
              "workflow_stages",
              "job_queue",
              "outbox_events",
            ]) {
              const template = await rawFor(client, {
                id: "text",
              }).$queryRawUnsafe(
                `SELECT id FROM "${table}" ORDER BY id LIMIT 1`,
              );
              await grow(table, String(template[0].id), n);
            }
            // Fresh live work, as before: a few active rows, unpublished events, a dead letter.
            for (const id of [
              "plan-pending",
              "plan-running",
              "plan-suspended",
              "plan-done",
            ]) {
              await client.$executeRawUnsafe(
                `DELETE FROM "workflow_runs" WHERE id = '${id}'`,
              );
            }
            await client.$executeRawUnsafe(
              `DELETE FROM "job_queue" WHERE id NOT LIKE 'grown-%'`,
            );
            await client.$executeRawUnsafe(
              `DELETE FROM "outbox_events" WHERE id NOT LIKE 'grown-%'`,
            );
            await seed();
            if (!sqlite) {
              // The premise: statistics exist and were not refreshed.
              expect(await analysedTables()).toBeGreaterThan(0);
            }
          }, 600_000);

          it("counts correctly", async () => {
            const stats = await persistence.getActiveWorkStats(new Date());
            expect(stats.runs.byStatus).toEqual({
              PENDING: 1,
              RUNNING: 1,
              SUSPENDED: 1,
            });
            expect(stats.outbox.unpublished).toBe(2);
            expect(stats.outbox.deadLettered).toBe(1);
            expect((await queue.getJobStats()).byStatus.PENDING).toBe(2);
          });

          it.skipIf(!sqlite)(
            "serves each stats count from its index on both SQLite single-read shapes",
            async () => {
              await expectStatsPlans(false, false, "$queryRaw");
              await expectStatsPlans(false, false, "$queryRawUnsafe");
            },
          );

          it.skipIf(!sqlite)(
            "inspects unpublished rows from the live sequence index (SQLite)",
            async () => {
              const captured = await record(async () => {
                expect(
                  await persistence.getUnpublishedOutboxEvents(1),
                ).toHaveLength(1);
              });
              const inspection = captured.find((statement) =>
                UNPUBLISHED.matches(statement.sql),
              );
              expect(inspection).toBeDefined();
              await expectServedBy(
                {
                  ...UNPUBLISHED,
                  index: "outbox_events_live_run_sequence_idx",
                },
                inspection!,
                false,
              );
            },
          );

          // Postgres plans these from the stale estimate ("most rows are
          // active"): the runs, stages, jobs and live-outbox reads take one
          // pass over their table, the due-stage and dead-letter reads stay on
          // their index. No way of writing the statement changes that without a
          // planner setting or a new index; the docs state this cost.
          it.skipIf(sqlite)(
            "reads at most one pass of each table, and the due-stage and dead-letter reads stay on their index (Postgres)",
            async () => {
              const captured = await record(() =>
                Promise.all([
                  persistence.getActiveWorkStats(new Date()),
                  queue.getJobStats(),
                ]),
              );
              const report: string[] = [];
              for (const expectation of STATS) {
                const statement = captured.find((c) =>
                  expectation.matches(c.sql),
                )!;
                const table = statement.sql.match(ENGINE_TABLE)![1]!;
                const read = await buffers(statement);
                const size = await pages(table);
                report.push(
                  `${expectation.name}: ${read} buffers (${table}: ${size} pages)`,
                );
                expect(read, expectation.name).toBeLessThanOrEqual(size + 64);
                if (
                  expectation.name === "dead-lettered outbox events" ||
                  expectation.name === "due suspended stages"
                ) {
                  expect(read, expectation.name).toBeLessThan(64);
                }
              }
              console.log(
                `stale statistics, ${n} rows:\n  ${report.join("\n  ")}`,
              );
            },
          );
        });
      }
    });

    describe.skipIf(sqlite)("an active backlog", () => {
      beforeAll(async () => {
        await truncate();
        await withoutStatistics();
        await client.$executeRawUnsafe(`INSERT INTO "outbox_events" (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt", "publishedAt")
          SELECT 'backlog-history-' || g, 'same-run', g, 'e', '{}'::jsonb, 'c', now(), now() FROM generate_series(1, 100000) g`);
        await client.$executeRawUnsafe(`INSERT INTO "outbox_events" (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt")
          SELECT 'backlog-active-' || g, 'backlog-run-' || g, 1, 'e', '{}'::jsonb, 'c', now() FROM generate_series(1, 10000) g`);
        await client.$executeRawUnsafe(
          `INSERT INTO "outbox_events" (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt") VALUES ('backlog-head', 'same-run', 100001, 'e', '{}'::jsonb, 'c', now())`,
        );
      }, 120_000);
      for (const analysed of [false, true]) {
        it(`avoids a quadratic earlier-event join ${analysed ? "after ANALYZE" : "without statistics"}`, async () => {
          if (analysed)
            await client.$executeRawUnsafe('ANALYZE "outbox_events"');
          const statements = await record(() =>
            persistence.claimOutboxDelivery(
              10,
              "2099-01-01T00:00:00.000Z|backlog",
              new Date(),
              [],
            ),
          );
          const claim = statements.find((statement) =>
            CLAIM.matches(statement.sql),
          );
          expect(claim).toBeDefined();
          const text = await plan(claim!, false, true);
          expect(text).toMatch(/outbox_events_live_run_sequence_idx/);
          expect(text).not.toMatch(
            /Nested Loop Anti Join|Seq Scan on outbox_events|outbox_events_dlqAt_idx/,
          );
          expect(text).toMatch(/Execution Time:/);
        });
      }
    });

    describe.skipIf(sqlite)("an empty outbox", () => {
      let writeStatements: Statement[];
      beforeAll(async () => {
        await truncate();
        await withoutStatistics();
        const now = new Date();
        const claim = "2099-01-01T00:00:00.000Z|empty-plan";
        await persistence.appendOutboxEvents([
          {
            workflowRunId: "empty-plan",
            eventType: "e",
            payload: {},
            causationId: "c",
            occurredAt: now,
          },
        ]);
        const row = await client.outboxEvent.findFirst({
          where: { workflowRunId: "empty-plan" },
        });
        const setClaim = () =>
          client.outboxEvent.updateMany({
            where: { id: row.id },
            data: {
              deliveryClaim: `r0000000000000000001|${claim}`,
              publishedAt: null,
              retryCount: 0,
              dlqAt: null,
            },
          });
        await record(setClaim);
        const published = await record(() =>
          persistence.completeOutboxDelivery(row.id, claim, now),
        );
        await record(setClaim);
        const released = await record(() =>
          persistence.failOutboxDelivery(row.id, claim, 3, now),
        );
        writeStatements = [...published, ...released].filter(
          (statement) =>
            /\bUPDATE\b/i.test(statement.sql) &&
            statement.sql.includes("outbox_events"),
        );
        expect(writeStatements).toHaveLength(3);
        await client.outboxEvent.deleteMany({});
      });
      for (const analysed of [false, true]) {
        it(`explains counts and delivery writes on zero rows ${analysed ? "after ANALYZE" : "without statistics"}`, async () => {
          if (analysed)
            await client.$executeRawUnsafe('ANALYZE "outbox_events"');
          expect(await client.outboxEvent.count()).toBe(0);
          const captured = await record(async () => {
            await persistence.getActiveWorkStats(new Date());
            await persistence.claimOutboxDelivery(
              1,
              "2099-01-01T00:00:00.000Z|empty",
              new Date(),
              [],
            );
          });
          const outbox = captured.filter((statement) =>
            statement.sql.includes("outbox_events"),
          );
          expect(outbox.length).toBeGreaterThanOrEqual(3);
          for (const statement of [...outbox, ...writeStatements])
            expect((await plan(statement, false)).length).toBeGreaterThan(0);
        });
      }
    });

    for (const publishedRows of [0, 10_000, 100_000]) {
      describe.skipIf(sqlite)(
        `outbox plans with ${publishedRows} published rows`,
        () => {
          beforeAll(async () => {
            await truncate();
            await withoutStatistics();
            if (publishedRows) {
              await client.$executeRawUnsafe(
                `INSERT INTO "outbox_events" (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt", "publishedAt")
               SELECT 'volume-event-' || g, 'volume-run-' || g, 1, 'e', '{}'::jsonb, 'c', now(), now()
               FROM generate_series(1, ${publishedRows - 8}) g`,
              );
            }
            await persistence.appendOutboxEvents(
              Array.from({ length: 8 }, (_, i) => ({
                workflowRunId: `zz-volume-run-${i}`,
                eventType: "e",
                payload: {},
                causationId: "c",
                occurredAt: new Date(),
              })),
            );
          }, 120_000);
          for (const analysed of [false, true]) {
            it(`${analysed ? "after ANALYZE" : "never analysed"}: explains counts, claim, publication and release as an ordinary role`, async () => {
              if (analysed)
                await client.$executeRawUnsafe('ANALYZE "outbox_events"');
              const captured = await record(async () => {
                await persistence.getActiveWorkStats(new Date());
                await persistence.claimOutboxDelivery(
                  1,
                  "2099-01-01T00:00:00.000Z|volume",
                  new Date(),
                  [],
                );
              });
              const outbox = captured.filter((statement) =>
                statement.sql.includes("outbox_events"),
              );
              expect(outbox.length).toBeGreaterThanOrEqual(3);
              for (const statement of outbox) {
                const text = await plan(statement, false);
                expect(text.length).toBeGreaterThan(0);
                if (publishedRows >= 10_000)
                  expect(text).not.toMatch(/Seq Scan on outbox_events/);
              }
              await expectDeliveryWritePlans(false, publishedRows === 0);
            });
          }
        },
      );
    }

    describe("bounded claim and sequence lookup", () => {
      const count = (n: number, statement: string) =>
        sqlite
          ? `WITH RECURSIVE series(g) AS (SELECT 1 WHERE ${n} > 0 UNION ALL SELECT g + 1 FROM series WHERE g < ${n}) ${statement} FROM series`
          : `${statement} FROM generate_series(1, ${n}) g`;

      async function resetOutboxPlanner() {
        if (sqlite) {
          await client.outboxEvent.deleteMany({});
          await client.$executeRawUnsafe("ANALYZE outbox_events");
          await client.$executeRawUnsafe(
            "DELETE FROM sqlite_stat1 WHERE tbl = 'outbox_events'",
          );
          await client.$executeRawUnsafe("ANALYZE sqlite_schema");
        } else {
          await client.$executeRawUnsafe("TRUNCATE outbox_events");
          await withoutStatistics();
        }
      }

      const history = (
        n: number,
        published: boolean,
        prefix: string,
        wide = false,
      ) => {
        const date = !sqlite
          ? "now()"
          : major === "6"
            ? "1735689600000"
            : major === "8"
              ? "'2025-01-01T00:00:00.000Z'"
              : "'2025-01-01T00:00:00.000+00:00'";
        const run = wide
          ? `'${prefix}-run-' || ((g - 1) % 28000 + 1)`
          : `'${prefix}'`;
        const sequence = wide ? "(g - 1) / 28000 + 1" : "g";
        const body = `INSERT INTO outbox_events (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt", "publishedAt")
          SELECT '${prefix}-' || g, ${run}, ${sequence}, 'e', '{}', 'c', ${date}, ${published ? date : "NULL"}`;
        return client.$executeRawUnsafe(count(n, body));
      };

      /**
       * Statistics taken after an outbox drained: a table of 10,000 rows
       * emptied and then analysed keeps its pages, so the planner expects
       * almost no rows on every page the next load fills.
       */
      async function emptied() {
        await history(10_000, true, "drained", true);
        await client.outboxEvent.deleteMany({});
        await client.$executeRawUnsafe("ANALYZE outbox_events");
      }

      function sharedBuffers(text: string): number {
        const buffers = /Buffers: shared ([^\n]+)/.exec(text);
        return [...(buffers?.[1] ?? "").matchAll(/(?:hit|read)=(\d+)/g)].reduce(
          (sum, entry) => sum + Number(entry[1]),
          0,
        );
      }

      async function expectBoundedClaim(limit = 10, expected?: number) {
        let acquired = 0;
        const claim = await record(async () => {
          const rows = await persistence.claimOutboxDelivery(
            limit,
            "2000-01-01T00:00:00.000Z|measure",
            new Date(),
            [],
          );
          acquired = rows.length;
        });
        if (expected !== undefined) expect(acquired).toBe(expected);
        if (!sqlite) {
          // One statement sets every planner setting for the transaction.
          const settings = statements.filter(({ sql }) =>
            sql.includes("set_config("),
          );
          expect(settings).toHaveLength(1);
          for (const setting of [
            "enable_seqscan",
            "enable_bitmapscan",
            "enable_sort",
            "enable_incremental_sort",
            "jit",
          ])
            expect(settings[0]!.sql).toContain(
              `set_config('${setting}', 'off', true)`,
            );
        }
        for (const statement of claim.filter(({ sql }) =>
          ROTATION.matches(sql),
        )) {
          if (sqlite || expected !== 0)
            await expectServedBy(ROTATION, statement, false);
        }
        const phases = claim.filter((statement) =>
          CLAIM.matches(statement.sql),
        );
        expect(phases.length).toBeGreaterThan(0);
        for (const phase of phases) {
          const text = await plan(phase, false, !sqlite);
          const message = `${phase.sql}
${text}`;
          expect(text, message).toContain(
            "outbox_events_live_run_sequence_idx",
          );
          expect(text, message).not.toMatch(
            sqlite
              ? /\bSCAN (outbox_events|e|main\.outbox_events)\b|USE TEMP B-TREE/
              : /Seq Scan on outbox_events/,
          );
          if (sqlite) {
            expect(text, message).toMatch(/workflowRunId>\?/);
            expect(text, message).toMatch(
              /outbox_events_delivery_run_idx.*deliveryClaim>\?/,
            );
          } else {
            // The atomic claim includes the anchor writes and the rotation
            // read as well as the probes. The bound stays fixed at ten heads.
            expect(sharedBuffers(text), message).toBeLessThan(850);
          }
        }
      }

      for (const n of [0, 10_000, 100_000]) {
        for (const statistics of [
          "never",
          "analysed",
          "stale published",
          "stale live",
          "emptied",
        ]) {
          it(`bounds the claim and highest sequence lookup at ${n} rows with ${statistics} statistics`, async () => {
            await resetOutboxPlanner();
            try {
              if (statistics.startsWith("stale")) {
                await history(7, statistics === "stale published", "stale");
                await client.$executeRawUnsafe("ANALYZE outbox_events");
                await client.outboxEvent.deleteMany({});
              }
              if (statistics === "emptied") await emptied();
              if (n) {
                await history(n - 2, true, "long");
                await history(2, false, "ready");
              }
              if (statistics === "analysed")
                await client.$executeRawUnsafe("ANALYZE outbox_events");
              // The one ready run takes the page: both of its events.
              await expectBoundedClaim(10, n ? 2 : 0);
              const append = await record(() =>
                persistence.appendOutboxEvents([
                  {
                    workflowRunId: "long",
                    eventType: "e",
                    payload: {},
                    causationId: "plan",
                    occurredAt: new Date(),
                  },
                ]),
              );
              const lookup = append.find(
                ({ sql }) =>
                  /SELECT.*sequence.*ORDER BY/is.test(sql) &&
                  sql.includes("outbox_events"),
              );
              expect(lookup).toBeDefined();
              const high = await plan(lookup!, false, !sqlite);
              // shortcut: drained statistics can send the highest-sequence lookup
              // through outbox_events_delivery_cursor_idx (all the run's rows);
              // the append path is not bounded for that state yet.
              if (n && statistics !== "emptied") {
                expect(high).toContain(
                  sqlite && major === "8"
                    ? "sqlite_autoindex_outbox_events_2"
                    : "outbox_events_workflowRunId_sequence_key",
                );
                expect(high).not.toMatch(
                  sqlite ? /USE TEMP B-TREE/ : /Seq Scan|Aggregate/,
                );
                if (!sqlite) {
                  expect(high).toMatch(/rows=1 loops=1/);
                  const buffers =
                    /Buffers: shared hit=(\d+)(?: read=(\d+))?/.exec(high);
                  expect(buffers).toBeTruthy();
                  expect(
                    Number(buffers![1]) + Number(buffers![2] ?? 0),
                  ).toBeLessThan(20);
                }
              }
            } finally {
              await resetOutboxPlanner();
            }
          }, 30_000);
        }
      }

      for (const n of [0, 10_000, 100_000]) {
        for (const shape of ["dense", "wide", "held"]) {
          for (const statistics of [
            "never",
            "analysed",
            "stale published",
            "stale live",
            "emptied",
          ]) {
            it(`bounds the ${shape} claim at ${n} rows with ${statistics} statistics`, async () => {
              await resetOutboxPlanner();
              try {
                if (statistics.startsWith("stale")) {
                  await history(7, statistics === "stale published", "stale");
                  await client.$executeRawUnsafe("ANALYZE outbox_events");
                  await client.outboxEvent.deleteMany({});
                }
                if (statistics === "emptied") await emptied();
                await history(
                  shape === "held" && n ? n - 20 : n,
                  false,
                  shape,
                  shape === "wide",
                );
                if (shape === "held" && n) {
                  await history(10, false, "a-held", true);
                  await history(10, false, "z-ready", true);
                  await client.$executeRawUnsafe(
                    `UPDATE outbox_events SET "deliveryClaim" = '2099-01-01T00:00:00.000Z|crashed'
                     WHERE "workflowRunId" LIKE 'a-held-%'`,
                  );
                }
                if (statistics === "analysed")
                  await client.$executeRawUnsafe("ANALYZE outbox_events");
                await expectBoundedClaim(10, n ? 10 : 0);
              } finally {
                await resetOutboxPlanner();
              }
            }, 60_000);
          }
        }
      }

      it.skipIf(sqlite)(
        "measures PostgreSQL's visibility cost before dead index entries can be vacuumed",
        async () => {
          await resetOutboxPlanner();
          try {
            // Capture the real point probes before the dead range has been touched.
            const fresh = createPrismaWorkflowPersistence(client);
            const statements = await record(() =>
              fresh.claimOutboxDelivery(
                1,
                "2000-01-01T00:00:00.000Z|measure",
                new Date(),
                [],
              ),
            );
            const seek = statements.find((statement) =>
              CLAIM.matches(statement.sql),
            )!;
            await history(100_000, false, "a-old", true);
            await history(1, false, "z-ready");
            let finish!: () => void;
            let open!: () => void;
            const snapshotOpen = new Promise<void>((resolve) => {
              open = resolve;
            });
            const hold = new Promise<void>((resolve) => {
              finish = resolve;
            });
            const snapshot = client.$transaction(
              async (tx: typeof client) => {
                await tx.outboxEvent.count();
                open();
                await hold;
              },
              { isolationLevel: "RepeatableRead", timeout: 30_000 },
            );
            try {
              await Promise.race([snapshotOpen, snapshot]);
              await client.$executeRawUnsafe(
                `UPDATE outbox_events SET "publishedAt" = now() WHERE "workflowRunId" LIKE 'a-old-%'`,
              );
              const dirty = await plan(seek, false, true);
              expect(dirty).toContain("outbox_events_live_run_sequence_idx");
              expect(dirty).not.toMatch(/Seq Scan on outbox_events/);
              expect(sharedBuffers(dirty)).toBeGreaterThan(500);
              console.info(
                `Outbox PostgreSQL dead entries: ${sharedBuffers(dirty)} shared buffers; ${dirty.match(/Execution Time: [^\n]+/)?.[0]}`,
              );
            } finally {
              finish();
              await snapshot;
            }
            await client.$executeRawUnsafe("VACUUM outbox_events");
            const clean = await plan(seek, false, true);
            expect(sharedBuffers(clean)).toBeLessThan(100);
            console.info(
              `Outbox PostgreSQL after vacuum: ${sharedBuffers(clean)} shared buffers; ${clean.match(/Execution Time: [^\n]+/)?.[0]}`,
            );
          } finally {
            await resetOutboxPlanner();
          }
        },
        60_000,
      );

      it.each([
        ["dense", 100_000, 100],
        ["wide", 28_000, 10],
      ] as const)(
        "dispatches a bounded page of %s live rows before the host timeout",
        async (shape, n, limit) => {
          await resetOutboxPlanner();
          try {
            // Reproduce the bad stale-published plan before growing the live set.
            await history(7, true, "small");
            await client.$executeRawUnsafe("ANALYZE outbox_events");
            await history(n, false, shape, shape === "wide");
            const delivered: number[] = [];
            const userUrl = sqlite ? undefined : new URL(databaseUrl!);
            if (userUrl) {
              userUrl.username = plannerRole;
              userUrl.password = "outbox-plan-fixture";
            }
            const ordinary = userUrl
              ? (await openRecordingClient(undefined, userUrl.toString()))
                  .client
              : undefined;
            try {
              const kernel = createKernel({
                persistence: ordinary
                  ? createPrismaWorkflowPersistence(ordinary)
                  : persistence,
                eventSink: {
                  async emit(_, delivery) {
                    delivered.push(delivery!.sequence);
                  },
                },
                clock: { now: () => new Date() },
                registry: { getWorkflow: () => undefined },
                blobStore: new InMemoryBlobStore(),
                jobTransport: new InMemoryJobQueue("plan"),
              });
              const start = performance.now();
              const result = await kernel.dispatch({
                type: "outbox.flush",
                maxEvents: limit,
              });
              const elapsed = performance.now() - start;
              console.info(
                `Outbox ${shape} dispatch: ${elapsed.toFixed(1)}ms, ${result.published} published`,
              );
              expect(result).toMatchObject({
                published: limit,
                eventSinkStatus: "healthy",
              });
              if (shape === "dense")
                expect(delivered).toEqual(
                  Array.from({ length: limit }, (_, i) => i + 1),
                );
              expect(elapsed).toBeLessThan(5_000);
            } finally {
              await ordinary?.$disconnect();
            }
          } finally {
            await resetOutboxPlanner();
          }
        },
        60_000,
      );
    });

    // A claim candidate that nothing will claim must not occupy the slot of
    // one that can be claimed. `retryCount` is NOT NULL DEFAULT 0 and only the
    // engine writes it, but the schema does not stop a negative value, and a
    // filter that treated it as "live" stalled a claim with a small limit.
    describe("a row an operator edited", () => {
      beforeAll(async () => {
        await client.outboxEvent.deleteMany({});
      });
      it("does not stall the claim: a dead letter with a negative retryCount is skipped", async () => {
        const run = "plan-negative";
        await persistence.createRun({
          id: run,
          workflowId: "plans",
          workflowName: "plans",
          workflowType: "plans",
          input: {},
        });
        await persistence.appendOutboxEvents(
          Array.from({ length: 3 }, (_, i) => ({
            workflowRunId: run,
            eventType: "e",
            payload: {},
            causationId: `neg${i}`,
            occurredAt: new Date(),
          })),
        );
        const [head, next] = (await persistence.getUnpublishedOutboxEvents())
          .filter((e) => e.workflowRunId === run)
          .sort((a, b) => a.sequence - b.sequence);
        await persistence.moveOutboxEventToDLQ(head!.id);
        await client.outboxEvent.update({
          where: { id: head!.id },
          data: { retryCount: -1 },
        });

        // `run` sorts before every other seeded run: the head of the queue.
        const candidates = await persistence.getUnpublishedOutboxEvents(1);
        expect(candidates.map((e) => e.id)).toEqual([next!.id]);
        const claimed = await persistence.claimOutboxDelivery(
          1,
          "2000-01-01T00:00:00.000Z|plans",
          new Date(),
          ["plan-pending", "plan-negative-other"],
        );
        expect(claimed.map((e) => e.id)).toEqual([next!.id]);

        await client.outboxEvent.deleteMany({ where: { workflowRunId: run } });
        await client.workflowRun.deleteMany({ where: { id: run } });
      });
    });
  },
);
