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
 * - SQLite: the planner's choice for these statements with no statistics.
 *   Without `sqlite_stat1` SQLite plans from the schema alone, whatever the row
 *   counts, so this is the choice a large database nobody ANALYZEd gets. It
 *   does not cover a database that was analysed: SQLite then plans from the
 *   row counts, which a few seeded rows cannot stand in for.
 * - Postgres needs a role that may `DELETE FROM pg_statistic` (a superuser; the
 *   CI role `postgres` is one): every state described below is built, not
 *   assumed, so no test depends on what ran against the database before.
 * - Postgres, forced (`enable_seqscan = off`, a few seeded rows): a sequential
 *   scan appears only when no index can serve the statement. So this checks
 *   that an index path exists and which index is preferred among them,
 *   independent of row counts. It cannot see a plan that is cheaper only while
 *   the planner has no statistics.
 * - Postgres, not forced, at scale ("at scale, no forced plan" below): the
 *   tables are bulk-loaded (500,000 published outbox events and 100,000
 *   terminal runs, stages and jobs) and the plan is whatever the planner
 *   chooses, first for tables it has no statistics for (`reltuples = -1`, no
 *   `pg_statistic` rows, autovacuum off: a fresh bulk load), then after
 *   `ANALYZE`. Parameters are inlined as the driver sends them, which for the
 *   dead-letter count's `OFFSET` makes it a quoted literal; that form allows a
 *   parallel sequential scan, which the parameterised statement does not.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "../../persistence/prisma/index.js";
import { rawFor } from "../../persistence/prisma/prisma-client-type.js";

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
    index: "outbox_events_publishedAt_idx",
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

/** The claim's candidate select (SQLite and `getUnpublishedOutboxEvents`) and Postgres's claim statement. */
const CLAIM: Expectation = {
  name: "outbox claim candidates",
  matches: (sql) => sql.includes("outbox_events") && /ORDER BY/i.test(sql),
  index: "outbox_events_publishedAt_idx",
  not: "outbox_events_dlqAt_idx",
};

/**
 * The claim on Postgres with no statistics. It must not read the NULL range of
 * `outbox_events_dlqAt_idx` (one entry per published event, which the plain
 * `dlqAt IS NULL` filter made it do), but a limit below about 50 can make it
 * walk the unique (workflowRunId, sequence) index instead: it estimates 1,400
 * qualifying rows in 250,000 and expects the first few to turn up early. They
 * do not when the live events sort last, as seeded in the scale tests. Only
 * statistics settle that choice.
 */
const CLAIM_WITHOUT_STATISTICS: Expectation = {
  ...CLAIM,
  index: "outbox_events_(publishedAt_idx|workflowRunId_sequence_key)",
};

const SQLITE_TABLE_SCAN =
  /\bSCAN (main\.)?(t0|workflow_runs|workflow_stages|job_queue|outbox_events)\b/;

/** Opens a client for the Prisma major under test that records every statement it sends. */
async function openRecordingClient(file?: string) {
  const statements: Statement[] = [];
  if (major === "8") {
    const db = sqlite
      ? await fixtures.createSqliteDb(file)
      : fixtures.createPostgresDb(databaseUrl);
    const query = db.query.bind(db);
    db.query = (plan: any) => {
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
      return query(plan);
    };
    const client = Object.assign(fromPrisma8(db), {
      $disconnect: () => db.close(),
    });
    return { client, statements };
  }
  const options = { log: [{ emit: "event", level: "query" }] };
  const client = sqlite
    ? fixtures.createSqliteClient(file, options)
    : fixtures.createPostgresClient(databaseUrl, options);
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
        // Without this Postgres picks a sequential scan on a small table
        // whatever the indexes are. With it, a sequential scan appears only
        // when no index can serve the statement.
        if (forceIndex)
          await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        const rows = await rawFor(tx, {
          "QUERY PLAN": "text",
        }).$queryRawUnsafe(
          `EXPLAIN ${inlineParams(statement.sql, statement.params)}`,
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
      return statements.slice();
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
              `(Index (Only )?Scan using|Bitmap Index Scan on) "?${expectation.index}`,
            ),
      );
      expect(text, message).not.toMatch(
        sqlite ? SQLITE_TABLE_SCAN : /Seq Scan/,
      );
      if (expectation.not) {
        expect(text, message).not.toMatch(new RegExp(expectation.not));
      }
    }

    async function expectStatsPlans(forceIndex = true) {
      const captured = await record(() =>
        Promise.all([
          persistence.getActiveWorkStats(new Date()),
          queue.getJobStats(),
        ]),
      );
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

    async function expectClaimPlans(
      forceIndex = true,
      expectation: Expectation = CLAIM,
    ) {
      const captured = await record(async () => {
        await persistence.getUnpublishedOutboxEvents(10);
        await persistence.claimUnpublishedOutboxEvents(10);
      });
      const candidates = captured.filter((s) => CLAIM.matches(s.sql));
      expect(candidates.length, "no claim candidate statement").toBeGreaterThan(
        0,
      );
      for (const s of candidates) {
        await expectServedBy(expectation, s, forceIndex);
      }
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
      it("serves the outbox claim's candidates from the unpublished index", () =>
        expectClaimPlans());
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
      it("serves the outbox claim's candidates from the unpublished index", () =>
        expectClaimPlans());
    });

    // The forced tests above cannot see a plan that is cheaper only while the
    // planner has no statistics: a fresh bulk load, autovacuum off or behind.
    // These load the volumes the statements must not read (terminal rows,
    // published events) and take whatever plan the planner chooses.
    describe.skipIf(sqlite)("at scale, no forced plan", () => {
      const TERMINAL_ROWS = 100_000;
      const PUBLISHED_EVENTS = 500_000;
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
          expectClaimPlans(false, CLAIM_WITHOUT_STATISTICS));
      });

      describe("after ANALYZE", () => {
        beforeAll(async () => {
          await client.$executeRawUnsafe("ANALYZE");
        });
        it("serves every stats query from its index", () =>
          expectStatsPlans(false));
        it("serves the outbox claim's candidates from the unpublished index", () =>
          expectClaimPlans(false));
      });
    });

    // A claim candidate that nothing will claim must not occupy the slot of
    // one that can be claimed. `retryCount` is NOT NULL DEFAULT 0 and only the
    // engine writes it, but the schema does not stop a negative value, and a
    // filter that treated it as "live" stalled a claim with a small limit.
    describe("a row an operator edited", () => {
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
        const claimed = await persistence.claimUnpublishedOutboxEvents(1);
        expect(claimed.map((e) => e.id)).toEqual([next!.id]);

        await client.outboxEvent.deleteMany({ where: { workflowRunId: run } });
        await client.workflowRun.deleteMany({ where: { id: run } });
      });
    });
  },
);
