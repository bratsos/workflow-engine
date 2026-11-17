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
 * is true of every published row), and scanned the table for `dlqAt IS NOT
 * NULL`. See `LIVE_OUTBOX` in `persistence/prisma/persistence.ts`.
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
 * - Postgres: with `enable_seqscan = off` (set in the checking transaction),
 *   the planner picks a sequential scan only when no index can serve the
 *   statement. So the assertion is that an index path exists and which index
 *   the planner prefers among them; it is independent of row counts. It does
 *   not prove the plan is best at scale: with accurate statistics Postgres
 *   plans these the same way (measured), but the test cannot see that.
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

    /** The plan of one statement as text lines. */
    async function plan(statement: Statement): Promise<string> {
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
    async function expectServedBy(expectation: Expectation, s: Statement) {
      const text = await plan(s);
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
    }

    async function expectStatsPlans() {
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
        await expectServedBy(expectation, own[0]!);
      }
    }

    async function expectClaimPlans() {
      const captured = await record(async () => {
        await persistence.getUnpublishedOutboxEvents(10);
        await persistence.claimUnpublishedOutboxEvents(10);
      });
      const candidates = captured.filter((s) => CLAIM.matches(s.sql));
      expect(candidates.length, "no claim candidate statement").toBeGreaterThan(
        0,
      );
      for (const s of candidates) await expectServedBy(CLAIM, s);
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
      if (!sqlite) await truncate();
      await seed();
    }, 120_000);

    afterAll(async () => {
      if (!sqlite && client) await truncate();
      await client?.$disconnect();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    describe(sqlite ? "without statistics" : "before ANALYZE", () => {
      it("serves every stats query from its index", expectStatsPlans);
      // Not on Postgres: with no statistics it may plan the claim's ORDER BY
      // from the unique (workflowRunId, sequence) index, a choice only its
      // statistics settle. The claim's plan is asserted after ANALYZE there.
      it.skipIf(!sqlite)(
        "serves the outbox claim's candidates from the unpublished index",
        expectClaimPlans,
      );
    });

    // Not on SQLite: after ANALYZE it plans from the row counts, and on the two
    // or three rows seeded here a table scan is the cheaper plan. The choice
    // that matters there is the one made without statistics, which does not
    // depend on row counts and is what a database nobody ANALYZEd gets.
    describe.skipIf(sqlite)("after ANALYZE", () => {
      beforeAll(async () => {
        await client.$executeRawUnsafe("ANALYZE");
      });
      it("serves every stats query from its index", expectStatsPlans);
      it(
        "serves the outbox claim's candidates from the unpublished index",
        expectClaimPlans,
      );
    });
  },
);
