/**
 * Prisma + PostgreSQL Conformance Tests
 *
 * Runs the *shared* persistence / job-queue / AI-call-logger conformance
 * suites (see src/testing/persistence-conformance.ts -- the same spec
 * published from `@bratsos/workflow-engine/testing` for third-party
 * adapters) against `PrismaWorkflowPersistence`, `PrismaJobQueue`, and
 * `PrismaAICallLogger` backed by a real PostgreSQL database (via a
 * generated `@prisma/client`). `adapter-conformance.test.ts` runs the
 * identical suites against the in-memory fakes; this file is what proves
 * the published spec also holds against the actual target database, not
 * just an in-memory approximation of it.
 *
 * PG-only extras kept here (not portable to the in-memory fake, so not
 * part of the shared suite): the raw `FOR UPDATE SKIP LOCKED` claim/dequeue
 * queries, an outbox sequence race under real concurrent connections, a
 * real optimistic-lock `UPDATE ... WHERE version = ?`, and a `Status`
 * enum round-trip through the actual Postgres enum column -- plus one
 * kernel-level end-to-end smoke test wiring `createKernel` to these same
 * Prisma adapters and driving it the way a host does.
 *
 * Requires:
 *   - DATABASE_URL pointing at a Postgres database
 *   - `pnpm --filter @bratsos/workflow-engine run prisma:generate`
 *   - `pnpm --filter @bratsos/workflow-engine run prisma:db-push`
 *
 * When DATABASE_URL is not set, every test in this file is skipped so
 * `pnpm test` stays green without a database (see adapter-conformance.test.ts
 * for the in-memory equivalents that always run unconditionally).
 */

import { createRequire } from "node:module";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { createKernel } from "../../kernel/kernel.js";
import type { Clock } from "../../kernel/ports.js";
import {
  CollectingEventSink,
  InMemoryBlobStore,
} from "../../kernel/testing/index.js";
import {
  createPrismaAICallLogger,
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
} from "../../persistence/prisma/index.js";
import {
  aiCallLoggerConformanceSuite,
  jobQueueConformanceSuite,
  persistenceConformanceSuite,
} from "../../testing/persistence-conformance.js";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("I want the Prisma adapters to conform against real Postgres", () => {
    it("skipped - set DATABASE_URL to run against a real Postgres database", () => {});
  });
} else {
  describe("I want the Prisma adapters to conform against real Postgres", () => {
    // Required lazily (not as a static ESM import) so that `@prisma/client`
    // -- which only exists once `prisma generate` has been run -- is never
    // resolved when this branch isn't taken (i.e. DATABASE_URL is unset).
    const require = createRequire(import.meta.url);
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

    async function truncateAll() {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "job_queue", "workflow_annotations", "workflow_artifacts", "workflow_logs", "workflow_stages", "workflow_runs", "ai_calls", "outbox_events", "idempotency_keys" RESTART IDENTITY CASCADE`,
      );
    }

    afterAll(async () => {
      await truncateAll();
      await prisma.$disconnect();
    });

    // ==========================================================================
    // Shared conformance suites -- the exact spec published for third-party
    // adapters, run here against the real Prisma + Postgres adapters. Each
    // factory attaches an async `reset` (TRUNCATE) so the shared suites'
    // `beforeEach` resets real database state between every test instead of
    // the in-memory fakes' synchronous `clear()`.
    // ==========================================================================

    persistenceConformanceSuite("PrismaWorkflowPersistence (Postgres)", () => {
      const persistence = createPrismaWorkflowPersistence(prisma);
      return Object.assign(persistence, { reset: truncateAll });
    });

    jobQueueConformanceSuite("PrismaJobQueue (Postgres)", () => {
      const queue = createPrismaJobQueue(prisma, {
        workerId: "pg-conformance-worker",
      });
      return Object.assign(queue, { reset: truncateAll });
    });

    aiCallLoggerConformanceSuite("PrismaAICallLogger (Postgres)", () => {
      const logger = createPrismaAICallLogger(prisma);
      return Object.assign(logger, { reset: truncateAll });
    });

    // ==========================================================================
    // Postgres-only behavior: raw-SQL paths and real-database mechanics the
    // shared suite intentionally can't exercise (it also has to pass against
    // the in-memory fake). Everything else the original hand-rolled version
    // of this file checked (plain run/stage/artifact/log/annotation CRUD,
    // idempotency-key acquire/replay/reclaim, job complete/fail/release) is
    // now covered -- against this same real database -- by the shared
    // suites above, so it isn't duplicated here.
    // ==========================================================================

    describe("Postgres-only behavior", () => {
      const persistence = createPrismaWorkflowPersistence(prisma);
      const jobQueue = createPrismaJobQueue(prisma, {
        workerId: "pg-extras-worker",
      });

      beforeEach(async () => {
        await truncateAll();
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

      it("updates a run and enforces optimistic locking via a real UPDATE ... WHERE version = ?", async () => {
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

      it("round-trips every Status enum value through the real Postgres column", async () => {
        // The in-memory fake stores `status` as a plain JS string; only a
        // real run against Postgres proves the enum-compat layer
        // (enum-compat.ts, resolving Prisma 6.x strings vs 7.x typed
        // enums) writes and reads back every value correctly.
        const run = await persistence.createRun(createRunData());
        const statuses = [
          "PENDING",
          "RUNNING",
          "SUSPENDED",
          "COMPLETED",
          "FAILED",
          "CANCELLED",
          "SKIPPED",
        ] as const;

        for (const status of statuses) {
          await persistence.updateRun(run.id, { status });
          const readBack = await persistence.getRunStatus(run.id);
          expect(readBack).toBe(status);
        }
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

      it("enqueues and dequeues a job atomically using FOR UPDATE SKIP LOCKED", async () => {
        const jobId = await jobQueue.enqueue({
          workflowRunId: "skip-locked-run",
          workflowId: "skip-locked-workflow",
          stageId: "skip-locked-stage",
        });
        expect(jobId).toBeTruthy();

        const dequeued = await jobQueue.dequeue();
        expect(dequeued?.jobId).toBe(jobId);
        expect(dequeued?.attempt).toBe(1);

        // Nothing left to dequeue.
        expect(await jobQueue.dequeue()).toBeNull();
      });
    });

    // ==========================================================================
    // Kernel-level end-to-end smoke test: createKernel wired to the real
    // Prisma adapters, driven by dispatch calls the way a host drives it
    // (see packages/workflow-engine-host-node/src/host.ts's orchestration
    // tick + job loop) -- proves the full claim -> enqueue -> dequeue ->
    // execute -> complete -> transition -> flush pipeline works against a
    // real database, not just against in-memory fakes or isolated handler
    // calls. `KernelConfig.scheduler` is optional (unused by the kernel;
    // see kernel/ports.ts) and intentionally omitted.
    // ==========================================================================

    describe("kernel end-to-end smoke test", () => {
      beforeEach(async () => {
        await truncateAll();
      });

      function createTwoStageWorkflow() {
        const schema = z.object({ value: z.string() });
        const stage1 = defineStage({
          id: "stage-one",
          name: "Stage One",
          schemas: { input: schema, output: schema, config: z.object({}) },
          async execute(ctx) {
            return { output: { value: `${ctx.input.value}-1` } };
          },
        });
        const stage2 = defineStage({
          id: "stage-two",
          name: "Stage Two",
          schemas: { input: schema, output: schema, config: z.object({}) },
          async execute(ctx) {
            return { output: { value: `${ctx.input.value}-2` } };
          },
        });
        return new WorkflowBuilder(
          "pg-e2e-workflow",
          "PG E2E Workflow",
          "Kernel end-to-end smoke test",
          schema,
          schema,
        )
          .pipe(stage1)
          .pipe(stage2)
          .build();
      }

      it("runs a 2-stage workflow to completion, flushes the outbox, and replays an idempotent re-dispatch", async () => {
        const workflow = createTwoStageWorkflow();
        const persistence = createPrismaWorkflowPersistence(prisma);
        const jobTransport = createPrismaJobQueue(prisma, {
          workerId: "pg-e2e-worker",
        });
        const blobStore = new InMemoryBlobStore();
        const eventSink = new CollectingEventSink();
        // A real (not fake/frozen) clock -- Postgres independently stamps
        // WorkflowRun.createdAt via its own `now()` default, so a frozen
        // clock far from wall-clock time (FakeClock defaults to
        // 2025-01-01) would make run.transition's
        // `duration = clock.now() - run.createdAt` go wildly negative and
        // overflow the `duration Int` column.
        const clock: Clock = { now: () => new Date() };

        const kernel = createKernel({
          persistence,
          jobTransport,
          blobStore,
          eventSink,
          clock,
          registry: {
            getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
          },
          // scheduler intentionally omitted -- optional, unused by the kernel.
        });

        // 1. run.create (mirrors an API handler creating a run)
        const createResult = await kernel.dispatch({
          type: "run.create",
          idempotencyKey: "pg-e2e-create-key",
          workflowId: workflow.id,
          input: { value: "start" },
        });
        expect(createResult.status).toBe("PENDING");
        const { workflowRunId } = createResult;

        // 2. run.claimPending (mirrors NodeHost's orchestration tick):
        // claims the PENDING run and enqueues the first-stage job.
        const claimResult = await kernel.dispatch({
          type: "run.claimPending",
          workerId: "pg-e2e-worker",
          maxClaims: 10,
        });
        expect(
          claimResult.claimed.some((c) => c.workflowRunId === workflowRunId),
        ).toBe(true);

        // 3. Job loop (mirrors NodeHost.processJobs): dequeue -> execute ->
        // complete -> transition, until no jobs remain. Bounded so a bug
        // that leaves a job perpetually re-enqueued fails the test instead
        // of hanging it.
        let iterations = 0;
        for (;;) {
          const job = await jobTransport.dequeue();
          if (!job) break;
          if (++iterations > 10) {
            throw new Error(
              "kernel E2E smoke test: too many job.execute iterations -- likely stuck",
            );
          }

          const result = await kernel.dispatch({
            type: "job.execute",
            idempotencyKey: `job:${job.jobId}:attempt:${job.attempt}`,
            workflowRunId: job.workflowRunId,
            workflowId: job.workflowId,
            stageId: job.stageId,
            config: {},
          });

          expect(result.outcome).toBe("completed");
          await jobTransport.complete(job.jobId);
          await kernel.dispatch({ type: "run.transition", workflowRunId });
        }

        expect(iterations).toBe(2); // stage-one, then stage-two

        // 4. Assert the run completed with both stages' transformations
        // applied in order.
        const finalRun = await persistence.getRun(workflowRunId);
        expect(finalRun?.status).toBe("COMPLETED");
        expect(finalRun?.output).toEqual({ value: "start-1-2" });

        // 5. outbox.flush publishes the buffered events through EventSink.
        const flushResult = await kernel.dispatch({
          type: "outbox.flush",
          maxEvents: 100,
        });
        expect(flushResult.published).toBeGreaterThan(0);
        expect(eventSink.getByType("workflow:completed")).toHaveLength(1);

        // 6. Idempotent re-dispatch: the same run.create idempotencyKey
        // replays the cached result instead of creating a second run.
        const replayResult = await kernel.dispatch({
          type: "run.create",
          idempotencyKey: "pg-e2e-create-key",
          workflowId: workflow.id,
          input: { value: "start" },
        });
        expect(replayResult.workflowRunId).toBe(workflowRunId);

        const runsForWorkflow = await persistence.getRunsByStatus("COMPLETED");
        expect(
          runsForWorkflow.filter((r) => r.workflowId === workflow.id),
        ).toHaveLength(1);
      });
    });
  });
}
