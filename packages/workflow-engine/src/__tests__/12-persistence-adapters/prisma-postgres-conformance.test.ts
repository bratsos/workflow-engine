/**
 * Prisma + PostgreSQL Conformance Tests
 *
 * Exercises PrismaWorkflowPersistence and PrismaJobQueue against a real
 * PostgreSQL database (via a generated `@prisma/client`), verifying the raw
 * SQL paths (FOR UPDATE SKIP LOCKED claim/dequeue queries in
 * persistence.ts / job-queue.ts) that in-memory and mocked tests can't
 * cover.
 *
 * Requires:
 *   - DATABASE_URL pointing at a Postgres database
 *   - `pnpm --filter @bratsos/workflow-engine run prisma:generate`
 *   - `pnpm --filter @bratsos/workflow-engine run prisma:db-push`
 *
 * When DATABASE_URL is not set, every test in this file is skipped so
 * `pnpm test` stays green without a database (see adapter-conformance.test.ts
 * for the in-memory equivalents that always run).
 */

import { createRequire } from "node:module";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
} from "../../persistence/prisma/index.js";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("I want PrismaWorkflowPersistence + PrismaJobQueue to conform against real Postgres", () => {
    it("skipped - set DATABASE_URL to run against a real Postgres database", () => {});
  });
} else {
  describe("I want PrismaWorkflowPersistence + PrismaJobQueue to conform against real Postgres", () => {
    // Required lazily (not as a static ESM import) so that `@prisma/client`
    // -- which only exists once `prisma generate` has been run -- is never
    // resolved when this branch isn't taken (i.e. DATABASE_URL is unset).
    const require = createRequire(import.meta.url);
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

    const persistence = createPrismaWorkflowPersistence(prisma);
    const jobQueue = createPrismaJobQueue(prisma, {
      workerId: "pg-conformance-worker",
    });

    async function truncateAll() {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "job_queue", "workflow_annotations", "workflow_artifacts", "workflow_logs", "workflow_stages", "workflow_runs", "ai_calls", "outbox_events", "idempotency_keys" RESTART IDENTITY CASCADE`,
      );
    }

    beforeEach(async () => {
      await truncateAll();
    });

    afterAll(async () => {
      await truncateAll();
      await prisma.$disconnect();
    });

    function createRunData(overrides: Record<string, unknown> = {}) {
      return {
        workflowId: `workflow-${Date.now()}-${Math.random()}`,
        workflowName: "PG Conformance Workflow",
        workflowType: "pg-conformance",
        input: { value: "test" },
        ...overrides,
      };
    }

    describe("WorkflowPersistence", () => {
      it("creates and reads back a run", async () => {
        const run = await persistence.createRun(createRunData());
        expect(run.id).toBeTruthy();
        expect(run.status).toBe("PENDING");
        expect(run.version).toBe(1); // schema default: `version Int @default(1)`

        const fetched = await persistence.getRun(run.id);
        expect(fetched?.workflowType).toBe("pg-conformance");
      });

      it("updates a run and enforces optimistic locking via expectedVersion", async () => {
        const run = await persistence.createRun(createRunData());

        await persistence.updateRun(run.id, {
          status: "RUNNING",
          expectedVersion: run.version,
        });

        await expect(
          persistence.updateRun(run.id, {
            status: "COMPLETED",
            expectedVersion: run.version, // stale on purpose
          }),
        ).rejects.toThrow();
      });

      it("claims the next PENDING run atomically using FOR UPDATE SKIP LOCKED", async () => {
        const runA = await persistence.createRun(
          createRunData({ priority: 5 }),
        );
        await persistence.createRun(createRunData({ priority: 1 }));

        const claimed = await persistence.claimNextPendingRun();
        expect(claimed?.id).toBe(runA.id);
        expect(claimed?.status).toBe("RUNNING");

        const stillPending = await persistence.getRunsByStatus("PENDING");
        expect(stillPending).toHaveLength(1);
      });

      it("creates a stage, artifact, and log linked to a run", async () => {
        const run = await persistence.createRun(createRunData());
        const stage = await persistence.createStage({
          workflowRunId: run.id,
          stageId: "extract",
          stageName: "Extract",
          stageNumber: 1,
          executionGroup: 1,
        });
        expect(stage.id).toBeTruthy();

        await persistence.saveArtifact({
          workflowRunId: run.id,
          workflowStageId: stage.id,
          key: "output.json",
          type: "STAGE_OUTPUT",
          data: { ok: true },
          size: 10,
        });
        expect(await persistence.hasArtifact(run.id, "output.json")).toBe(true);

        await persistence.createLog({
          workflowRunId: run.id,
          workflowStageId: stage.id,
          level: "INFO",
          message: "hello from postgres",
        });
      });

      it("appends and lists annotations", async () => {
        const run = await persistence.createRun(createRunData());
        await persistence.appendAnnotations([
          {
            workflowRunId: run.id,
            scope: "run",
            key: "trigger.source",
            value: "webhook:test",
          },
        ]);

        const annotations = await persistence.listAnnotations(run.id);
        expect(annotations).toHaveLength(1);
        expect(annotations[0]?.key).toBe("trigger.source");
      });

      it("assigns non-colliding sequences under concurrent appendOutboxEvents for the same run", async () => {
        // Regression test for the pg_advisory_xact_lock no-op outside a
        // transaction: PrismaWorkflowPersistence.appendOutboxEvents is
        // called standalone (autocommit) here, so the advisory lock is
        // released instantly and provides no real serialization -- the
        // (workflowRunId, sequence) unique constraint + retry-on-conflict
        // is what must prevent duplicate/missing sequences.
        const run = await persistence.createRun(createRunData());

        await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            persistence.appendOutboxEvents([
              {
                workflowRunId: run.id,
                eventType: `concurrent.${i}`,
                payload: { i },
                causationId: `cmd-${i}`,
                occurredAt: new Date(),
              },
            ]),
          ),
        );

        const events = await persistence.getUnpublishedOutboxEvents(100);
        const runEvents = events.filter((e) => e.workflowRunId === run.id);
        const sequences = runEvents
          .map((e) => e.sequence)
          .sort((a, b) => a - b);

        expect(sequences).toHaveLength(10);
        expect(new Set(sequences).size).toBe(10);
        expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      });

      it("acquires and completes an idempotency key", async () => {
        const first = await persistence.acquireIdempotencyKey(
          "key-1",
          "run.create",
        );
        expect(first.status).toBe("acquired");

        const second = await persistence.acquireIdempotencyKey(
          "key-1",
          "run.create",
        );
        expect(second.status).toBe("in_progress");

        await persistence.completeIdempotencyKey("key-1", "run.create", {
          done: true,
        });

        const replay = await persistence.acquireIdempotencyKey(
          "key-1",
          "run.create",
        );
        expect(replay.status).toBe("replay");
      });

      it("reclaims an idempotency key stuck in_progress past staleInProgressAfterMs", async () => {
        // Regression test for a dispatcher crashing between committing
        // its transaction and calling completeIdempotencyKey: without a
        // TTL reclaim, this key (and every future dispatch using it)
        // would throw IdempotencyInProgressError forever.
        const start = new Date("2024-01-01T00:00:00.000Z");
        const first = await persistence.acquireIdempotencyKey(
          "stale-pg-key",
          "run.create",
          { now: start, staleInProgressAfterMs: 10 * 60 * 1000 },
        );
        expect(first.status).toBe("acquired");

        // Not yet stale.
        const tooSoon = await persistence.acquireIdempotencyKey(
          "stale-pg-key",
          "run.create",
          {
            now: new Date(start.getTime() + 5 * 60 * 1000),
            staleInProgressAfterMs: 10 * 60 * 1000,
          },
        );
        expect(tooSoon.status).toBe("in_progress");

        // Past the threshold -- reclaimable.
        const stale = new Date(start.getTime() + 10 * 60 * 1000);
        const reclaimed = await persistence.acquireIdempotencyKey(
          "stale-pg-key",
          "run.create",
          { now: stale, staleInProgressAfterMs: 10 * 60 * 1000 },
        );
        expect(reclaimed.status).toBe("acquired");

        // A completed key is never reclaimed, no matter how old.
        await persistence.completeIdempotencyKey("stale-pg-key", "run.create", {
          done: true,
        });
        const afterComplete = await persistence.acquireIdempotencyKey(
          "stale-pg-key",
          "run.create",
          {
            now: new Date(stale.getTime() + 24 * 60 * 60 * 1000),
            staleInProgressAfterMs: 10 * 60 * 1000,
          },
        );
        expect(afterComplete.status).toBe("replay");
      });
    });

    describe("JobQueue", () => {
      it("enqueues and dequeues a job atomically using FOR UPDATE SKIP LOCKED", async () => {
        const jobId = await jobQueue.enqueue({
          workflowRunId: "run-1",
          workflowId: "workflow-1",
          stageId: "stage-1",
        });
        expect(jobId).toBeTruthy();

        const dequeued = await jobQueue.dequeue();
        expect(dequeued?.jobId).toBe(jobId);
        expect(dequeued?.attempt).toBe(1);

        // Nothing left to dequeue.
        expect(await jobQueue.dequeue()).toBeNull();
      });

      it("completes, fails, and releases stale jobs", async () => {
        const jobId = await jobQueue.enqueue({
          workflowRunId: "run-2",
          workflowId: "workflow-2",
          stageId: "stage-2",
        });
        await jobQueue.dequeue();
        await jobQueue.complete(jobId);

        const jobId2 = await jobQueue.enqueue({
          workflowRunId: "run-3",
          workflowId: "workflow-3",
          stageId: "stage-3",
        });
        await jobQueue.dequeue();
        await jobQueue.fail(jobId2, "boom", false);

        const released = await jobQueue.releaseStaleJobs(0);
        expect(typeof released).toBe("number");
      });
    });
  });
}
