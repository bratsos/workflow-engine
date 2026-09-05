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
 * real optimistic-lock `UPDATE ... WHERE version = ?`, a `Status` enum
 * round-trip through the actual Postgres enum column, the lease sweep on a
 * session deliberately not on UTC, and the claim/enqueue race under a fast
 * job loop (both need real transactions and a real session timezone) --
 * plus one kernel-level end-to-end smoke test wiring `createKernel` to
 * these same Prisma adapters and driving it the way a host does.
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
import { deriveStepExternalKey } from "../../core/step-external-key.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { executeJobWithHeartbeat } from "../../kernel/helpers/host-support.js";
import { createKernel } from "../../kernel/kernel.js";
import type { Clock } from "../../kernel/ports.js";
import {
  CollectingEventSink,
  InMemoryBlobStore,
} from "../../kernel/testing/index.js";
import {
  createPrismaAICallLogger,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
} from "../../persistence/prisma/index.js";
import {
  aiCallLoggerConformanceSuite,
  jobQueueConformanceSuite,
  persistenceConformanceSuite,
  stepLedgerConformanceSuite,
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
        `TRUNCATE TABLE "job_queue", "workflow_annotations", "workflow_artifacts", "workflow_logs", "workflow_steps", "workflow_stages", "workflow_runs", "ai_calls", "outbox_events", "idempotency_keys" RESTART IDENTITY CASCADE`,
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

    const api = { describe, it, expect, beforeEach };

    persistenceConformanceSuite(
      "PrismaWorkflowPersistence (Postgres)",
      () => {
        const persistence = createPrismaWorkflowPersistence(prisma);
        return Object.assign(persistence, { reset: truncateAll });
      },
      api,
    );

    jobQueueConformanceSuite(
      "PrismaJobQueue (Postgres)",
      () => {
        const queue = createPrismaJobQueue(prisma, {
          workerId: "pg-conformance-worker",
        });
        return Object.assign(queue, { reset: truncateAll });
      },
      api,
    );

    aiCallLoggerConformanceSuite(
      "PrismaAICallLogger (Postgres)",
      () => {
        const logger = createPrismaAICallLogger(prisma);
        return Object.assign(logger, { reset: truncateAll });
      },
      api,
    );

    /**
     * `workflow_steps.stageRecordId` is a cascading foreign key to
     * `workflow_stages.id`, so the ledger suites -- which claim rows against
     * bare stage ids -- need those stage records (and a parent run) to exist
     * on a real schema. The in-memory fake has no such constraint.
     */
    async function seedStageRecords(stageRecordIds: string[]): Promise<void> {
      const run = await prisma.workflowRun.create({
        data: {
          workflowId: "pg-step-ledger-workflow",
          workflowName: "PG Step Ledger Workflow",
          workflowType: "pg-step-ledger",
          input: {},
        },
      });
      await prisma.workflowStage.createMany({
        data: stageRecordIds.map((id, index) => ({
          id,
          workflowRunId: run.id,
          stageId: id,
          stageName: id,
          stageNumber: index + 1,
          executionGroup: index + 1,
        })),
      });
    }

    stepLedgerConformanceSuite(
      "PrismaStepLedger (Postgres)",
      () => {
        const ledger = createPrismaStepLedger(prisma);
        return Object.assign(ledger, {
          reset: async () => {
            await truncateAll();
            await seedStageRecords(["stage-1", "stage-2"]);
          },
        });
      },
      api,
    );

    // ==========================================================================
    // Postgres-only behavior: raw-SQL paths and real-database mechanics the
    // shared suite intentionally can't exercise (it also has to pass against
    // the in-memory fake). Everything else the original hand-rolled version
    // of this file checked (plain run/stage/artifact/log/annotation CRUD,
    // idempotency-key acquire/replay/reclaim, job complete/fail/release) is
    // now covered -- against this same real database -- by the shared
    // suites above, so it isn't duplicated here.
    // ==========================================================================

    describe("PrismaStepLedger (Postgres)", () => {
      const ledger = createPrismaStepLedger(prisma);
      const stageRecordId = "pg-step-ledger-stage";

      beforeEach(async () => {
        await truncateAll();
        await seedStageRecords([stageRecordId]);
      });

      it("round-trips the external key written before the body runs", async () => {
        const externalKey = deriveStepExternalKey(stageRecordId, "submit");
        const claimed = await ledger.claim({
          stageRecordId,
          stepId: "submit",
          seq: 1,
          kind: "run",
          status: "running",
          attempt: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          deadlineAt: null,
          externalKey,
        });

        expect(claimed.created).toBe(true);
        expect(claimed.record.externalKey).toBe(externalKey);
        expect((await ledger.get(stageRecordId, "submit"))?.externalKey).toBe(
          externalKey,
        );

        // A replay re-claims the same row and reads back the same key.
        const replayed = await ledger.claim({
          stageRecordId,
          stepId: "submit",
          seq: 1,
          kind: "run",
          status: "running",
          attempt: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          deadlineAt: null,
          externalKey,
        });
        expect(replayed.created).toBe(false);
        expect(replayed.record.externalKey).toBe(externalKey);

        // A completion never disturbs it: the key is how an orphaned
        // provider-side effect is found later.
        const completed = await ledger.update(stageRecordId, "submit", {
          status: "completed",
          result: { ok: true },
          leaseExpiresAt: null,
        });
        expect(completed.externalKey).toBe(externalKey);
      });

      it("reads a row written without a key as null", async () => {
        await ledger.claim({
          stageRecordId,
          stepId: "wait",
          seq: 2,
          kind: "wait",
          status: "pending",
          attempt: 1,
          leaseExpiresAt: null,
          deadlineAt: new Date(Date.now() + 60_000),
        });
        expect(
          (await ledger.get(stageRecordId, "wait"))?.externalKey,
        ).toBeNull();
      });
    });

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
        const [jobId] = await jobQueue.enqueueParallel([
          {
            workflowRunId: "skip-locked-run",
            workflowId: "skip-locked-workflow",
            stageId: "skip-locked-stage",
          },
        ]);
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

    // ==========================================================================
    // Session timezone independence (PG-only): every timestamp a raw
    // statement writes or compares must mean the same thing as one written
    // through the Prisma model API, whatever `TimeZone` the session is set
    // to. Prisma binds a JS Date as a `timestamptz`; assigning that to the
    // naive `timestamp` columns the schema declares converts it through the
    // session timezone, so on a non-UTC session `lockedAt` landed in the
    // future, no lease ever went stale, and a crashed worker's job was
    // never released -- crash recovery silently did not work.
    // ==========================================================================

    describe("per-group fairness (PG-only)", () => {
      beforeEach(async () => {
        await truncateAll();
      });

      /** 50 jobs from one tenant, then a single job from another. */
      async function floodThenOne(
        queue: ReturnType<typeof createPrismaJobQueue>,
      ) {
        await queue.enqueueParallel(
          Array.from({ length: 50 }, (_, i) => ({
            workflowRunId: `flood-${i}`,
            workflowId: "wf",
            stageId: "stage-1",
            groupKey: "noisy-tenant",
            payload: {},
          })),
        );
        await queue.enqueueParallel([
          {
            workflowRunId: "quiet-run",
            workflowId: "wf",
            stageId: "stage-1",
            groupKey: "quiet-tenant",
            payload: {},
          },
        ]);
      }

      it("puts the quiet tenant behind the whole flood without fairness", async () => {
        const queue = createPrismaJobQueue(prisma, { workerId: "plain" });
        await floodThenOne(queue);

        // The flood shares one `createdAt` (one enqueueParallel transaction),
        // so which of its rows comes out is not defined — only that the quiet
        // tenant's later job is not among the first two.
        expect((await queue.dequeue())?.workflowRunId).toMatch(/^flood-/);
        expect((await queue.dequeue())?.workflowRunId).toMatch(/^flood-/);
      });

      it("skips a tenant already at its concurrency cap", async () => {
        const queue = createPrismaJobQueue(prisma, {
          workerId: "fair",
          fairness: { maxConcurrentPerGroup: 1 },
        });
        await floodThenOne(queue);

        const first = await queue.dequeue();
        expect(first?.workflowRunId).toMatch(/^flood-/);
        // The noisy tenant holds its one slot, so the quiet tenant's job is
        // second out instead of fifty-first.
        expect((await queue.dequeue())?.workflowRunId).toBe("quiet-run");
        // Both tenants are now at their cap.
        expect(await queue.dequeue()).toBeNull();

        // Freeing a slot lets that tenant back in.
        await queue.complete(first!.jobId, {
          startedAt: first!.startedAt,
          attempt: first!.attempt,
        });
        const third = await queue.dequeue();
        expect(third?.workflowRunId).toMatch(/^flood-/);
        expect(third?.workflowRunId).not.toBe(first?.workflowRunId);
      });

      it("groups on an existing payload field when groupBy names one", async () => {
        const queue = createPrismaJobQueue(prisma, {
          workerId: "fair-path",
          fairness: { maxConcurrentPerGroup: 1, groupBy: "config.tenantId" },
        });
        await queue.enqueueParallel(
          Array.from({ length: 5 }, (_, i) => ({
            workflowRunId: `acme-${i}`,
            workflowId: "wf",
            stageId: "stage-1",
            payload: { config: { tenantId: "acme" } },
          })),
        );
        await queue.enqueueParallel([
          {
            workflowRunId: "globex-1",
            workflowId: "wf",
            stageId: "stage-1",
            payload: { config: { tenantId: "globex" } },
          },
        ]);

        await queue.dequeue();
        expect((await queue.dequeue())?.workflowRunId).toBe("globex-1");
      });

      it("keeps the group key out of the payload handed to the stage", async () => {
        const queue = createPrismaJobQueue(prisma, {
          workerId: "fair-payload",
          fairness: { maxConcurrentPerGroup: 2 },
        });
        await queue.enqueueParallel([
          {
            workflowRunId: "run-1",
            workflowId: "wf",
            stageId: "stage-1",
            groupKey: "tenant-a",
            payload: { config: { x: 1 } },
          },
        ]);

        const claimed = await queue.dequeue();
        expect(claimed?.payload).toEqual({ config: { x: 1 } });
        const [record] = await queue.getJobsByWorkflowRun("run-1");
        expect(record?.payload).toEqual({ config: { x: 1 } });
      });
    });

    describe("session timezone independence", () => {
      // UTC+14, no DST: a session-timezone slip shows up as a 14-hour jump,
      // and the case still proves its point on a database whose own default
      // timezone is already something other than UTC.
      const tzUrl = new URL(DATABASE_URL);
      tzUrl.searchParams.set("options", "-c timezone=Pacific/Kiritimati");
      tzUrl.searchParams.set("connection_limit", "1");
      const tzPrisma = new PrismaClient({ datasourceUrl: tzUrl.toString() });

      beforeEach(async () => {
        await truncateAll();
      });

      afterAll(async () => {
        await tzPrisma.$disconnect();
      });

      it("runs its statements on a session that is not on UTC", async () => {
        const rows = (await tzPrisma.$queryRawUnsafe(
          `SELECT current_setting('TimeZone') AS tz`,
        )) as Array<{ tz: string }>;
        expect(rows[0]?.tz).toBe("Pacific/Kiritimati");
      });

      it("releases a crashed worker's lease on a non-UTC session", async () => {
        const queue = createPrismaJobQueue(tzPrisma, { workerId: "tz-worker" });
        const runId = "tz-stale-run";
        await queue.enqueueParallel([
          {
            workflowRunId: runId,
            workflowId: "tz-workflow",
            stageId: "tz-stage",
            payload: {},
          },
        ]);

        const before = Date.now();
        const dequeued = await queue.dequeue();
        expect(dequeued).not.toBeNull();

        // The lease the raw dequeue wrote must be *now*, not now shifted by
        // the session's offset.
        const [locked] = await queue.getJobsByWorkflowRun(runId);
        expect(locked?.status).toBe("RUNNING");
        expect(
          Math.abs((locked?.lockedAt?.getTime() ?? 0) - before),
        ).toBeLessThan(60_000);

        // ...so the sweep that recovers a dead worker's job actually sees it.
        await new Promise((resolve) => setTimeout(resolve, 150));
        const released = await queue.releaseStaleJobs(100);
        expect(released).toBeGreaterThanOrEqual(1);

        const [after] = await queue.getJobsByWorkflowRun(runId);
        expect(after?.status).toBe("PENDING");
        expect(after?.lockedAt).toBeNull();
        expect(after?.workerId).toBeNull();
      });

      it("keeps a touched lease ahead of the lease it replaced on a non-UTC session", async () => {
        const queue = createPrismaJobQueue(tzPrisma, { workerId: "tz-worker" });
        const runId = "tz-touch-run";
        const [jobId] = await queue.enqueueParallel([
          {
            workflowRunId: runId,
            workflowId: "tz-workflow",
            stageId: "tz-stage",
            payload: {},
          },
        ]);
        await queue.dequeue();
        const [before] = await queue.getJobsByWorkflowRun(runId);

        // Both the dequeue and touchJob stamp the lease from the database
        // clock. They must agree, and both must move forward.
        await new Promise((resolve) => setTimeout(resolve, 30));
        await queue.touchJob(jobId!);

        const [after] = await queue.getJobsByWorkflowRun(runId);
        expect(after?.lockedAt?.getTime() ?? 0).toBeGreaterThan(
          before?.lockedAt?.getTime() ?? 0,
        );
      });

      it("stamps the lease from the database clock even when the host's clock is an hour out", async () => {
        // The failure this guards: a host whose system clock runs an hour
        // behind used to write `lockedAt` an hour in the past, so the very
        // next sweep -- on any host -- reclaimed a job that had only just
        // been claimed and ran it twice. With the stamp taken from the
        // database, a drifting host cannot shorten (or extend) a lease.
        const skewed = createPrismaJobQueue(tzPrisma, {
          workerId: "skewed-worker",
          now: () => new Date(Date.now() - 60 * 60 * 1000),
        });
        const runId = "skewed-clock-run";
        await skewed.enqueueParallel([
          {
            workflowRunId: runId,
            workflowId: "tz-workflow",
            stageId: "tz-stage",
            payload: {},
          },
        ]);
        const claimed = await skewed.dequeue();
        expect(claimed).not.toBeNull();

        const [job] = await skewed.getJobsByWorkflowRun(runId);
        expect(
          Math.abs((job?.lockedAt?.getTime() ?? 0) - Date.now()),
        ).toBeLessThan(60_000);
        // The attempt stamp handed to the worker is the stored one, so the
        // acknowledgement fence still matches.
        expect(
          Math.abs(
            claimed!.startedAt.getTime() - (job?.startedAt?.getTime() ?? 0),
          ),
        ).toBeLessThan(1);

        // A one-minute lease is nowhere near stale.
        expect(await skewed.releaseStaleJobs(60_000)).toBe(0);
        const [stillHeld] = await skewed.getJobsByWorkflowRun(runId);
        expect(stillHeld?.status).toBe("RUNNING");
      });

      it("claims a pending run with a UTC startedAt on a non-UTC session", async () => {
        const persistence = createPrismaWorkflowPersistence(tzPrisma);
        const run = await persistence.createRun({
          workflowId: "tz-claim-workflow",
          workflowName: "TZ Claim",
          workflowType: "tz",
          input: { value: "x" },
        });

        const claimed = await persistence.claimNextPendingRun();
        expect(claimed?.id).toBe(run.id);
        // `createdAt` is Postgres' own default; `startedAt`/`updatedAt` come
        // from the raw claim statement. They must be on the same clock.
        expect(
          (claimed?.startedAt?.getTime() ?? 0) - run.createdAt.getTime(),
        ).toBeLessThan(60_000);
        expect(
          (claimed?.startedAt?.getTime() ?? 0) - run.createdAt.getTime(),
        ).toBeGreaterThanOrEqual(0);
      });
    });

    // ==========================================================================
    // The claim/enqueue race, at the shape that exposed it: a job loop
    // polling every 2ms against runs being claimed at the same time. The
    // first-stage enqueue happens after the claim transaction commits, so a
    // dequeued job's run is always already RUNNING; before that fix the
    // majority of runs wedged RUNNING with a discarded ghost job.
    // ==========================================================================

    describe("claim/enqueue race under a fast job loop", () => {
      beforeEach(async () => {
        await truncateAll();
      });

      it("wedges no run when the job loop polls every 2ms", async () => {
        const schema = z.object({ value: z.string() });
        const stage = defineStage({
          id: "race-stage",
          name: "Race Stage",
          schemas: { input: schema, output: schema, config: z.object({}) },
          async execute(ctx) {
            return { output: { value: `${ctx.input.value}!` } };
          },
        });
        const workflow = new WorkflowBuilder(
          "pg-claim-race",
          "PG Claim Race",
          "Claim/enqueue race",
          schema,
          schema,
        )
          .pipe(stage)
          .build();

        const persistence = createPrismaWorkflowPersistence(prisma);
        const jobTransport = createPrismaJobQueue(prisma, {
          workerId: "race-worker",
        });
        const kernel = createKernel({
          persistence,
          jobTransport,
          blobStore: new InMemoryBlobStore(),
          eventSink: new CollectingEventSink(),
          clock: { now: () => new Date() } satisfies Clock,
          registry: {
            getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
          },
        });

        const RUNS = 12;
        for (let i = 0; i < RUNS; i++) {
          await kernel.dispatch({
            type: "run.create",
            idempotencyKey: `pg-race-${i}`,
            workflowId: workflow.id,
            input: { value: `v${i}` },
          });
        }

        const sleep = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        let looping = true;
        // The two loops a NodeHost runs: dequeue-and-execute at a 2ms poll,
        // and the orchestration tick's run.claimPending.
        const jobLoop = (async () => {
          while (looping) {
            const job = await jobTransport.dequeue();
            if (!job) {
              await sleep(2);
              continue;
            }
            await executeJobWithHeartbeat(kernel, {
              jobTransport,
              job,
              logPrefix: "[pg-race]",
            });
          }
        })();
        const claimLoop = (async () => {
          while (looping) {
            await kernel.dispatch({
              type: "run.claimPending",
              workerId: "race-worker",
              maxClaims: 10,
            });
            await sleep(5);
          }
        })();

        const deadline = Date.now() + 20_000;
        for (;;) {
          const unfinished = (await persistence.getRunsByStatus("RUNNING"))
            .length;
          const pending = (await persistence.getRunsByStatus("PENDING")).length;
          if (unfinished + pending === 0 || Date.now() > deadline) break;
          await sleep(20);
        }
        looping = false;
        await Promise.all([jobLoop, claimLoop]);

        const completed = await persistence.getRunsByStatus("COMPLETED");
        expect(completed).toHaveLength(RUNS);
        expect(await persistence.getRunsByStatus("RUNNING")).toHaveLength(0);

        // No job was thrown away as an orphan of a run that was merely
        // waiting for its claim to commit.
        const discarded = await prisma.jobQueue.count({
          where: { lastError: { contains: "ghost job discarded" } },
        });
        expect(discarded).toBe(0);
      }, 40_000);
    });
  });
}
