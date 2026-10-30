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
 *   - PRISMA_MAJOR (6, 7 or 8, default 7): the Prisma major under test
 *   - `pnpm --filter @bratsos/workflow-engine run prisma:generate`
 *   - `pnpm --filter @bratsos/workflow-engine run prisma:db-push`
 *
 * When DATABASE_URL is not set, every test in this file is skipped so
 * `pnpm test` stays green without a database (see adapter-conformance.test.ts
 * for the in-memory equivalents that always run unconditionally).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { DefinitionRegistrationRetryableError } from "../../persistence/interface.js";
import {
  createPrismaAICallLogger,
  createPrismaBlobStore,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
} from "../../persistence/prisma/index.js";
import { rawFor } from "../../persistence/prisma/prisma-client-type.js";
import {
  isSerializationFailure,
  isUniqueViolation,
  sqlStateOf,
} from "../../persistence/prisma/sql-errors.js";
import {
  aiCallLoggerConformanceSuite,
  jobQueueConformanceSuite,
  persistenceConformanceSuite,
  stepLedgerConformanceSuite,
} from "../../testing/persistence-conformance.js";
import { createPostgresClient, isPrisma8 } from "../utils/postgres-client.js";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("I want the Prisma adapters to conform against real Postgres", () => {
    it("skipped - set DATABASE_URL to run against a real Postgres database", () => {});
  });
} else {
  describe("I want the Prisma adapters to conform against real Postgres", () => {
    // Required lazily (not as a static ESM import) so that the generated
    // `@prisma/client` -- which only exists once `prisma:generate` has been run
    // -- is never resolved when this branch isn't taken (i.e. DATABASE_URL is
    // unset). The fixture for the Prisma major in PRISMA_MAJOR builds it.
    const prisma = createPostgresClient(DATABASE_URL);

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

      it("registers the same new definition in concurrent outer transactions without aborting either", async () => {
        const workflowId = `definition-race-${crypto.randomUUID()}`;
        const input = {
          workflowId,
          version: "v1",
          snapshot: { format: 1, workflowId, stages: [] },
          structureHash: "same-structure",
        };
        let emptyReads = 0;
        let release!: () => void;
        const bothRead = new Promise<void>((resolve) => {
          release = resolve;
        });
        const register = () =>
          prisma.$transaction(async (tx: typeof prisma) => {
            // Make the old find/create path race deterministically. The atomic
            // insert path reads only after inserting, so never waits here.
            const model = tx.workflowDefinition;
            const client = new Proxy(tx, {
              get(target, key) {
                if (key === "workflowDefinition")
                  return new Proxy(model, {
                    get(delegate, method) {
                      if (method === "findUnique")
                        return async (args: unknown) => {
                          const row = await delegate.findUnique(args);
                          if (!row) {
                            if (++emptyReads === 2) release();
                            await bothRead;
                          }
                          return row;
                        };
                      const value = Reflect.get(delegate, method);
                      return typeof value === "function"
                        ? value.bind(delegate)
                        : value;
                    },
                  });
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            const adapter = createPrismaWorkflowPersistence(client, {
              definitionVersioning: true,
            });
            const row = await adapter.insertDefinitionIfAbsent(input);
            // An additional SQL read must work in the same caller transaction.
            expect(
              await adapter.getDefinition(workflowId, input.version),
            ).toEqual(row);
            return row;
          });
        try {
          const results = await Promise.allSettled([register(), register()]);
          expect(results.map((result) => result.status)).toEqual([
            "fulfilled",
            "fulfilled",
          ]);
          const rows = results.map((result) =>
            result.status === "fulfilled" ? result.value : null,
          );
          expect(rows[0]).toMatchObject(input);
          expect(rows[1]).toEqual(rows[0]);
          expect(
            await prisma.workflowDefinition.count({ where: { workflowId } }),
          ).toBe(1);
        } finally {
          await prisma.workflowDefinition.deleteMany({ where: { workflowId } });
        }
      });

      it("fulfils overlapping registrations in one caller transaction and preserves earlier writes", async () => {
        const workflowId = `definition-overlap-${crypto.randomUUID()}`;
        const inputs = ["first", "second"].map((suffix) => ({
          workflowId: `${workflowId}-${suffix}`,
          version: "v1",
          snapshot: { format: 1, stages: [] },
          structureHash: suffix,
        }));
        let priorId!: string;
        try {
          await prisma.$transaction(async (tx: typeof prisma) => {
            const adapter = createPrismaWorkflowPersistence(tx, {
              definitionVersioning: true,
            });
            priorId = (await adapter.createRun(createRunData({ workflowId })))
              .id;
            const results = await Promise.allSettled(
              inputs.map((input) => adapter.insertDefinitionIfAbsent(input)),
            );
            expect(results.map((result) => result.status)).toEqual([
              "fulfilled",
              "fulfilled",
            ]);
            for (const [index, result] of results.entries()) {
              if (result.status === "fulfilled")
                expect(result.value).toMatchObject(inputs[index]);
            }
            expect(
              await rawFor(tx, { ok: "int" }).$queryRaw`SELECT 1 AS ok`,
            ).toEqual([{ ok: 1 }]);
          });
          expect(await persistence.getRun(priorId)).toMatchObject({
            id: priorId,
            workflowId,
          });
          for (const input of inputs) {
            expect(
              await persistence.getDefinition(input.workflowId, input.version),
            ).toMatchObject(input);
          }
        } finally {
          await prisma.workflowRun.deleteMany({ where: { workflowId } });
          await prisma.workflowDefinition.deleteMany({
            where: {
              workflowId: { in: inputs.map((input) => input.workflowId) },
            },
          });
        }
      });

      it.each([
        false,
        true,
      ])("registers via an autocommit client without $transaction (skip transactions: %s)", async (skipInteractiveTransactions) => {
        const input = {
          workflowId: `definition-autocommit-${crypto.randomUUID()}`,
          version: "v1",
          snapshot: { format: 1, stages: [] },
          structureHash: "autocommit",
        };
        const client = new Proxy(prisma, {
          get(target, key) {
            if (key === "$transaction") return undefined;
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        try {
          const adapter = createPrismaWorkflowPersistence(client, {
            definitionVersioning: true,
            skipInteractiveTransactions,
          });
          const row = await adapter.withTransaction((inner) =>
            inner.insertDefinitionIfAbsent(input),
          );
          expect(row).toMatchObject(input);
          expect(
            await persistence.getDefinition(input.workflowId, input.version),
          ).toEqual(row);
          expect(
            await rawFor(prisma, { ok: "int" }).$queryRaw`SELECT 1 AS ok`,
          ).toEqual([{ ok: 1 }]);
        } finally {
          await prisma.workflowDefinition.deleteMany({
            where: { workflowId: input.workflowId },
          });
        }
      });

      it.each([
        "RepeatableRead",
        "Serializable",
      ])("returns a retry signal at %s and retries the whole caller transaction", async (isolationLevel) => {
        const workflowId = `definition-snapshot-${crypto.randomUUID()}`;
        const input = {
          workflowId,
          version: "v1",
          snapshot: { format: 1, workflowId, stages: [] },
          structureHash: "same-structure",
        };
        let snapshots = 0;
        let release!: () => void;
        const bothRead = new Promise<void>((resolve) => {
          release = resolve;
        });
        const register = (race: boolean) =>
          prisma.$transaction(
            async (tx: typeof prisma) => {
              const adapter = createPrismaWorkflowPersistence(tx, {
                definitionVersioning: true,
              });
              // Both transactions acquire snapshots before either inserts.
              if (race) {
                expect(
                  await adapter.getDefinition(workflowId, input.version),
                ).toBeNull();
                if (++snapshots === 2) release();
                await bothRead;
              }
              const row = await adapter.insertDefinitionIfAbsent(input);
              expect(
                await adapter.getDefinition(workflowId, input.version),
              ).toEqual(row);
              return row;
            },
            { isolationLevel, timeout: 15_000 },
          );
        try {
          const results = await Promise.allSettled([
            register(true),
            register(true),
          ]);
          const winners = results.filter((r) => r.status === "fulfilled");
          const losers = results.filter((r) => r.status === "rejected");
          expect(winners).toHaveLength(1);
          expect(losers).toHaveLength(1);
          expect(losers[0].reason).toBeInstanceOf(
            DefinitionRegistrationRetryableError,
          );
          expect(losers[0].reason).toMatchObject({
            code: "DEFINITION_REGISTRATION_RETRY",
            retryable: true,
            workflowId,
            version: input.version,
          });
          expect(await register(false)).toEqual(winners[0].value);
          expect(
            await prisma.workflowDefinition.count({ where: { workflowId } }),
          ).toBe(1);
        } finally {
          await prisma.workflowDefinition.deleteMany({ where: { workflowId } });
        }
      });

      it("fails clearly without $executeRaw while preserving the caller transaction", async () => {
        await prisma.$transaction(async (tx: typeof prisma) => {
          const client = new Proxy(tx, {
            get(target, key) {
              if (key === "$executeRaw") return undefined;
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const adapter = createPrismaWorkflowPersistence(client, {
            definitionVersioning: true,
          });
          await expect(
            adapter.insertDefinitionIfAbsent({
              workflowId: "missing-execute",
              version: "v1",
              snapshot: {},
              structureHash: "hash",
            }),
          ).rejects.toThrow(
            "Prisma client does not support $executeRaw (required for the insertDefinitionIfAbsent path)",
          );
          expect(
            await rawFor(tx, { ok: "int" }).$queryRaw`SELECT 1 AS ok`,
          ).toEqual([{ ok: 1 }]);
        });
      });

      it("returns a retry signal if a conflict winner disappears before the follow-up read", async () => {
        const input = {
          workflowId: `definition-disappeared-${crypto.randomUUID()}`,
          version: "v1",
          snapshot: {},
          structureHash: "hash",
        };
        await persistence.insertDefinitionIfAbsent(input);
        const client = new Proxy(prisma, {
          get(target, key) {
            if (key === "$executeRaw")
              return async (
                strings: TemplateStringsArray,
                ...values: unknown[]
              ) => {
                const count = await target.$executeRaw(strings, ...values);
                expect(count).toBe(0);
                // A real concurrent autocommit deletion between the statements.
                await prisma.workflowDefinition.deleteMany({
                  where: { workflowId: input.workflowId },
                });
                return count;
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        try {
          const adapter = createPrismaWorkflowPersistence(client, {
            definitionVersioning: true,
          });
          await expect(
            adapter.insertDefinitionIfAbsent(input),
          ).rejects.toBeInstanceOf(DefinitionRegistrationRetryableError);
          expect(
            await persistence.insertDefinitionIfAbsent(input),
          ).toMatchObject(input);
        } finally {
          await prisma.workflowDefinition.deleteMany({
            where: { workflowId: input.workflowId },
          });
        }
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

      it("hands every pending run to exactly one of many concurrent claimers", async () => {
        const runs = await Promise.all(
          Array.from({ length: 12 }, () =>
            persistence.createRun(createRunData()),
          ),
        );

        const claims = await Promise.all(
          Array.from({ length: 24 }, () => persistence.claimNextPendingRun()),
        );

        const claimed = claims.flatMap((run) => (run ? [run.id] : []));
        expect(claimed.sort()).toEqual(runs.map((run) => run.id).sort());
        expect(await persistence.getRunsByStatus("PENDING")).toHaveLength(0);
      });

      it("hands every pending job to exactly one of many concurrent dequeuers", async () => {
        const jobIds = await jobQueue.enqueueParallel(
          Array.from({ length: 12 }, (_, i) => ({
            workflowRunId: "many-dequeuers-run",
            workflowId: "many-dequeuers-workflow",
            stageId: `stage-${i}`,
          })),
        );

        const dequeued = await Promise.all(
          Array.from({ length: 24 }, () => jobQueue.dequeue()),
        );

        const claimed = dequeued.flatMap((job) => (job ? [job.jobId] : []));
        expect(claimed.sort()).toEqual([...jobIds].sort());
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

    // Every argument shape `fromPrisma8` accepts, with the same literal expected
    // values on every major: 6 and 7 prove the expectation, 8 has to meet it.
    describe("argument parity across Prisma majors", () => {
      const D1 = new Date("2026-01-01T00:00:00.000Z");
      const D2 = new Date("2026-02-01T12:00:00.500Z");
      const ALL = "a,b,c,d,e,f,g,h,i,j,k,l";
      const NO_STAGES = "d,e,f,g,h,i,j,k,l";
      const run = (id: string, extra = {}) => ({
        id,
        workflowId: "wf",
        workflowName: "wf",
        workflowType: "t",
        input: {},
        ...extra,
      });
      const stage = (
        id: string,
        runId: string,
        stageId: string,
        extra = {},
      ) => ({
        id,
        workflowRunId: runId,
        stageId,
        stageName: stageId,
        stageNumber: 1,
        executionGroup: 1,
        ...extra,
      });
      const annotation = (
        id: string,
        runId: string,
        stageRecordId: string | null,
      ) => ({
        id,
        workflowRunId: runId,
        workflowStageRecordId: stageRecordId,
        scope: "run",
        key: id,
        value: {},
      });

      // Rows a-d are written twice, so the heap order is not the id order, and
      // metadata holds DB NULL (a, b), JSON null (c, d) and JSON values.
      async function seed() {
        await prisma.$executeRawUnsafe(
          `TRUNCATE "workflow_runs", "workflow_blobs" RESTART IDENTITY CASCADE`,
        );
        await prisma.workflowRun.createMany({
          data: [
            run("a", {
              workflowName: "ab",
              priority: 1,
              definitionVersion: "x",
            }),
            run("b", {
              workflowName: "a_b",
              priority: 2,
              startedAt: D1,
              definitionVersion: "y",
            }),
            run("c", { workflowName: "a%b", priority: 3, startedAt: D2 }),
            run("d", { workflowName: "a\\b", priority: 4, status: "RUNNING" }),
            run("e", {
              workflowName: "xy",
              priority: 5,
              status: "RUNNING",
              metadata: { k: 1, n: { m: 2 } },
            }),
            run("f", {
              workflowName: "a\\%",
              priority: 6,
              metadata: { k: "1" },
            }),
            run("g", {
              workflowName: "A_B",
              priority: 7,
              metadata: { k: null },
            }),
            run("h", { workflowName: "z", priority: 8, metadata: { k: true } }),
            run("i", {
              workflowName: "z2",
              priority: 9,
              metadata: { k: { a: 1 } },
            }),
            run("j", {
              workflowName: "z3",
              priority: 10,
              metadata: { k: [1, 2] },
            }),
            run("k", {
              workflowName: "z4",
              priority: 11,
              metadata: { other: 1 },
            }),
            run("l", {
              workflowName: "z5",
              priority: 12,
              metadata: { k: 1, n: { m: 2 } },
            }),
          ],
        });
        await prisma.$executeRawUnsafe(
          `UPDATE "workflow_runs" SET "metadata" = NULL WHERE "id" IN ('a', 'b')`,
        );
        await prisma.$executeRawUnsafe(
          `UPDATE "workflow_runs" SET "metadata" = 'null'::jsonb WHERE "id" IN ('c', 'd')`,
        );
        await prisma.workflowStage.createMany({
          data: [
            stage("s1", "a", "s", { errorMessage: "boom", duration: 5 }),
            stage("s2", "a", "t", { duration: 7, status: "RUNNING" }),
            stage("s3", "b", "s", { errorMessage: "zap" }),
            stage("s4", "c", "u", { status: "FAILED", startedAt: D1 }),
          ],
        });
        await prisma.workflowAnnotation.createMany({
          data: [
            annotation("n1", "a", "s1"),
            annotation("n2", "a", null),
            annotation("n3", "b", null),
          ],
        });
        await prisma.workflowBlob.createMany({
          data: [
            { key: "x", data: 1 },
            { key: "y", data: 2 },
          ],
        });
      }

      afterAll(() => prisma.$executeRawUnsafe(`TRUNCATE "workflow_blobs"`));

      const idsOf = (rows: Array<{ id: string }>) =>
        rows.map((row) => row.id).join();
      const runs = async (where?: unknown, extra = {}) =>
        idsOf(
          await prisma.workflowRun.findMany({
            where,
            select: { id: true },
            orderBy: { id: "asc" },
            ...extra,
          }),
        );
      const stages = async (where?: unknown) =>
        idsOf(
          await prisma.workflowStage.findMany({
            where,
            select: { id: true },
            orderBy: { id: "asc" },
          }),
        );
      const annotations = async (where?: unknown) =>
        idsOf(
          await prisma.workflowAnnotation.findMany({
            where,
            select: { id: true },
            orderBy: { id: "asc" },
          }),
        );
      const sorted = (rows: any[], by: string) =>
        [...rows].sort((a, b) => String(a[by]).localeCompare(String(b[by])));
      // A blob row binds 4 parameters on 8, so 16,383 rows fill one statement.
      const blobRows = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ key: `bulk-${i}`, data: i }));

      // On 8 the rejection has to come from the bridge: that is what proves
      // no SQL ran.
      const REJECTED = isPrisma8 ? /^fromPrisma8: / : /./;

      const FILTERS: Array<[string, unknown, string]> = [
        ["no where", undefined, ALL],
        [
          "in with quotes, commas and NULL as text",
          { workflowName: { in: ["a\\b", "a%b", "NULL", "", 'x"y,z'] } },
          "c,d",
        ],
        ["an empty where", {}, ALL],
        ["an undefined field", { id: undefined }, ALL],
        ["an empty operator object", { id: {} }, ALL],
        ["an undefined equals", { id: { equals: undefined } }, ALL],
        ["an undefined not", { id: { not: undefined } }, ALL],
        ["an undefined in", { id: { in: undefined } }, ALL],
        ["an undefined gt", { definitionVersion: { gt: undefined } }, ALL],
        ["a no-op beside a filter", { id: {}, workflowName: "ab" }, "a"],
        [
          "undefined beside a filter",
          { id: undefined, workflowName: "ab" },
          "a",
        ],
        ["OR: []", { OR: [] }, ""],
        ["OR: [{}]", { OR: [{}] }, ""],
        ["an undefined OR", { OR: undefined }, ALL],
        ["an OR child of undefined", { OR: [{ id: undefined }] }, ""],
        ["an OR child of a no-op", { OR: [{ id: {} }] }, ""],
        [
          "an OR child of equals undefined",
          { OR: [{ id: { equals: undefined } }] },
          "",
        ],
        ["an empty OR child before a real one", { OR: [{}, { id: "a" }] }, "a"],
        ["an empty OR child after a real one", { OR: [{ id: "a" }, {}] }, "a"],
        [
          "an undefined OR child beside a real one",
          { OR: [{ id: undefined }, { id: "a" }] },
          "a",
        ],
        [
          "a no-op OR child beside a real one",
          { OR: [{ id: {} }, { id: "a" }] },
          "a",
        ],
        ["a nested OR: []", { OR: [{ OR: [] }] }, ""],
        ["a nested OR: [{}]", { OR: [{ OR: [{}] }] }, ""],
        [
          "a nested OR: [] beside a real child",
          { OR: [{ OR: [] }, { id: "a" }] },
          "a",
        ],
        [
          "a nested OR: [{}] beside a real child",
          { OR: [{ OR: [{}] }, { id: "a" }] },
          "a",
        ],
        ["a child of an undefined OR", { OR: [{ OR: undefined }] }, ""],
        ["OR: [] beside a filter", { id: "a", OR: [] }, ""],
        ["OR: [{}] beside a filter", { id: "a", OR: [{}] }, ""],
        ["OR of two fields", { OR: [{ id: "a" }, { id: "b" }] }, "a,b"],
        [
          "OR children mixing no-ops and filters",
          {
            OR: [
              { id: "a", workflowName: undefined },
              { id: {}, workflowName: "xy" },
            ],
          },
          "a,e",
        ],
        [
          "OR children of two fields",
          {
            OR: [
              { id: "a", priority: 1 },
              { id: "b", priority: 9 },
            ],
          },
          "a",
        ],
        ["in: [] over NULLs", { definitionVersion: { in: [] } }, ""],
        ["notIn: [] over NULLs", { definitionVersion: { notIn: [] } }, ALL],
        ["in over NULLs", { definitionVersion: { in: ["x"] } }, "a"],
        ["notIn over NULLs", { definitionVersion: { notIn: ["x"] } }, "b"],
        ["not over NULLs", { definitionVersion: { not: "x" } }, "b"],
        ["not: null", { definitionVersion: { not: null } }, "a,b"],
        [
          "equals: null",
          { definitionVersion: { equals: null } },
          "c,d,e,f,g,h,i,j,k,l",
        ],
        ["a bare null", { definitionVersion: null }, "c,d,e,f,g,h,i,j,k,l"],
        ["gte on text", { definitionVersion: { gte: "x" } }, "a,b"],
        ["lt on text", { workflowName: { lt: "b" } }, "a,b,c,d,f,g"],
        [
          "not with in",
          { definitionVersion: { not: "x", in: ["x", "y"] } },
          "b",
        ],
        ["two operators", { priority: { gte: 2, lt: 4 } }, "b,c"],
        ["a fractional int", { priority: 1.5 }, "a"],
        ["a fractional bound", { priority: { lt: 2.5 } }, "a"],
        ["a fractional list", { priority: { in: [1.5, 2.5] } }, "a,b"],
        ["not null with lt", { startedAt: { not: null, lt: D2 } }, "b"],
        [
          "an undefined operator beside a real one",
          { priority: { gte: undefined, lt: 3 } },
          "a,b",
        ],
        ["an enum", { status: "RUNNING" }, "d,e"],
        ["an enum in", { status: { in: ["RUNNING"] } }, "d,e"],
        ["an enum not", { status: { not: "PENDING" } }, "d,e"],
        ["an enum notIn", { status: { notIn: ["PENDING"] } }, "d,e"],
        ["a float", { totalCost: 0 }, ALL],
        ["a float lt", { totalCost: { lt: 1 } }, ALL],
        [
          "startsWith % as a wildcard",
          { workflowName: { startsWith: "a%" } },
          "a,b,c,d,f",
        ],
        [
          "startsWith _ as a wildcard",
          { workflowName: { startsWith: "a_" } },
          "a,b,c,d,f",
        ],
        [
          "startsWith with a trailing backslash",
          { workflowName: { startsWith: "a\\" } },
          "",
        ],
        [
          "startsWith with an escaped _",
          { workflowName: { startsWith: "a\\_" } },
          "b",
        ],
        [
          "startsWith with an escaped %",
          { workflowName: { startsWith: "a\\%" } },
          "c",
        ],
        ["startsWith %", { workflowName: { startsWith: "%" } }, ALL],
        ["startsWith nothing", { workflowName: { startsWith: "" } }, ALL],
        [
          "startsWith nothing over NULLs",
          { definitionVersion: { startsWith: "" } },
          "a,b",
        ],
        [
          "startsWith, case sensitive",
          { workflowName: { startsWith: "A" } },
          "g",
        ],
        [
          "startsWith a plain prefix",
          { workflowName: { startsWith: "z" } },
          "h,i,j,k,l",
        ],
        ["JSON equals: null", { metadata: { equals: null } }, "c,d"],
        ["JSON not: null", { metadata: { not: null } }, "e,f,g,h,i,j,k,l"],
        [
          "JSON equals: null and not: null",
          { metadata: { equals: null, not: null } },
          "",
        ],
        [
          "JSON equals an object",
          { metadata: { equals: { k: 1, n: { m: 2 } } } },
          "e,l",
        ],
        [
          "JSON not an object",
          { metadata: { not: { k: "1" } } },
          "c,d,e,g,h,i,j,k,l",
        ],
        ["JSON equals a string", { metadata: { equals: "x" } }, ""],
        [
          "JSON not a string",
          { metadata: { not: "x" } },
          "c,d,e,f,g,h,i,j,k,l",
        ],
        ["an empty JSON filter", { metadata: {} }, ALL],
        ["an undefined JSON equals", { metadata: { equals: undefined } }, ALL],
        ["an undefined JSON not", { metadata: { not: undefined } }, ALL],
        [
          "a JSON path to a number",
          { metadata: { path: ["k"], equals: 1 } },
          "e,l",
        ],
        [
          "a JSON path to a string",
          { metadata: { path: ["k"], equals: "1" } },
          "f",
        ],
        [
          "a JSON path to null",
          { metadata: { path: ["k"], equals: null } },
          "g",
        ],
        [
          "a JSON path to a boolean",
          { metadata: { path: ["k"], equals: true } },
          "h",
        ],
        [
          "a JSON path to an object",
          { metadata: { path: ["k"], equals: { a: 1 } } },
          "i",
        ],
        [
          "a JSON path to an array",
          { metadata: { path: ["k"], equals: [1, 2] } },
          "j",
        ],
        ["an empty JSON path", { metadata: { path: [], equals: 1 } }, ""],
        [
          "a JSON path to nothing",
          { metadata: { path: ["absent"], equals: "1" } },
          "",
        ],
        [
          "a deep JSON path",
          { metadata: { path: ["n", "m"], equals: 2 } },
          "e,l",
        ],
        [
          "a JSON path into an array",
          { metadata: { path: ["k", "0"], equals: 1 } },
          "j",
        ],
        [
          "a JSON path in OR",
          { OR: [{ metadata: { path: ["k"], equals: 1 } }, { id: "a" }] },
          "a,e,l",
        ],
        [
          "an undefined JSON path",
          { metadata: { path: undefined, equals: 1 } },
          "",
        ],
        ["a Date", { startedAt: D1 }, "b"],
        ["a Date equals", { startedAt: { equals: D1 } }, "b"],
        ["a Date not", { startedAt: { not: D1 } }, "c"],
        ["a Date lt", { startedAt: { lt: D2 } }, "b"],
        ["a Date lte", { startedAt: { lte: D2 } }, "b,c"],
        ["a Date gt", { startedAt: { gt: D1 } }, "c"],
        ["a Date gte", { startedAt: { gte: D1 } }, "b,c"],
        ["a Date in", { startedAt: { in: [D1] } }, "b"],
        ["a Date notIn", { startedAt: { notIn: [D1] } }, "c"],
        ["a null Date", { startedAt: null }, "a,d,e,f,g,h,i,j,k,l"],
        ["none: {}", { stages: { none: {} } }, NO_STAGES],
        ["an undefined none", { stages: { none: undefined } }, ALL],
        [
          "none of undefined",
          { stages: { none: { stageId: undefined } } },
          NO_STAGES,
        ],
        ["none of a no-op", { stages: { none: { stageId: {} } } }, NO_STAGES],
        ["none of OR: []", { stages: { none: { OR: [] } } }, ALL],
        ["none of OR: [{}]", { stages: { none: { OR: [{}] } } }, ALL],
        [
          "none of a field",
          { stages: { none: { stageId: "s" } } },
          "c,d,e,f,g,h,i,j,k,l",
        ],
        [
          "none in OR",
          { OR: [{ stages: { none: {} } }, { id: "a" }] },
          "a,d,e,f,g,h,i,j,k,l",
        ],
        [
          "an undefined none in OR",
          { OR: [{ stages: { none: undefined } }] },
          "",
        ],
      ];

      const STAGE_FILTERS: Array<[string, unknown, string]> = [
        ["an empty relation filter", { workflowRun: {} }, "s1,s2,s3,s4"],
        [
          "an undefined relation filter",
          { workflowRun: undefined },
          "s1,s2,s3,s4",
        ],
        [
          "a relation filter of undefined",
          { workflowRun: { id: undefined } },
          "s1,s2,s3,s4",
        ],
        [
          "a relation filter of a no-op",
          { workflowRun: { id: {} } },
          "s1,s2,s3,s4",
        ],
        ["a relation filter of OR: []", { workflowRun: { OR: [] } }, ""],
        ["a relation filter of OR: [{}]", { workflowRun: { OR: [{}] } }, ""],
        [
          "a relation filter of an undefined OR child",
          { workflowRun: { OR: [{ id: undefined }] } },
          "",
        ],
        ["a relation field", { workflowRun: { id: "a" } }, "s1,s2"],
        [
          "a relation OR",
          { workflowRun: { OR: [{ id: "a" }, { id: "c" }] } },
          "s1,s2,s4",
        ],
        [
          "a relation beside a field",
          { stageId: "s", workflowRun: { id: "a" } },
          "s1",
        ],
        [
          "a nested relation",
          { workflowRun: { stages: { none: { stageId: "t" } } } },
          "s3,s4",
        ],
        ["an empty relation filter in OR", { OR: [{ workflowRun: {} }] }, ""],
        [
          "a relation filter of undefined in OR",
          { OR: [{ workflowRun: { id: undefined } }] },
          "",
        ],
        [
          "a relation in OR",
          { OR: [{ workflowRun: { id: "c" } }, { stageId: "t" }] },
          "s2,s4",
        ],
        [
          "a relation of OR: [] in OR",
          { OR: [{ workflowRun: { OR: [] } }] },
          "",
        ],
      ];

      const ANNOTATION_FILTERS: Array<[string, unknown, string]> = [
        [
          "an empty optional relation filter",
          { workflowStage: {} },
          "n1,n2,n3",
        ],
        [
          "an undefined optional relation filter",
          { workflowStage: undefined },
          "n1,n2,n3",
        ],
        [
          "an optional relation filter of undefined",
          { workflowStage: { id: undefined } },
          "n1,n2,n3",
        ],
        [
          "an optional relation field",
          { workflowStage: { stageId: "s" } },
          "n1",
        ],
        ["an optional relation of OR: []", { workflowStage: { OR: [] } }, ""],
      ];

      // Rejected on every major; the call must never reach the database.
      const INVALID: Array<[string, unknown]> = [
        ["an undefined OR element", { OR: [undefined] }],
        ["a null OR element", { OR: [null] }],
        ["OR as an object", { OR: { id: "a" } }],
        ["null in in", { definitionVersion: { in: [null] } }],
        ["null in notIn", { definitionVersion: { notIn: [null] } }],
        ["a value and null in in", { definitionVersion: { in: ["x", null] } }],
        ["undefined in in", { definitionVersion: { in: [undefined] } }],
        ["in without an array", { id: { in: "a" } }],
        ["lt: null", { definitionVersion: { lt: null } }],
        ["a number for text", { id: 5 }],
        ["a string for an int", { priority: "1" }],
        ["an array for an int", { priority: [1] }],
        ["a string for a float", { totalCost: "0" }],
        ["a date-only string", { createdAt: { lt: "2099-01-01" } }],
        ["a number for a Date", { startedAt: 5 }],
        ["an invalid Date", { startedAt: new Date("nope") }],
        ["an unknown enum value", { status: "NOPE" }],
        ["lt on an enum", { status: { lt: "RUNNING" } }],
        ["startsWith on an enum", { status: { startsWith: "R" } }],
        ["startsWith on an int", { priority: { startsWith: "1" } }],
        ["startsWith: null", { workflowName: { startsWith: null } }],
        ["startsWith a number", { workflowName: { startsWith: 1 } }],
        ["null for a required column", { id: null }],
        ["equals: null on a required column", { id: { equals: null } }],
        ["not: null on a required column", { id: { not: null } }],
        ["an unknown column", { nope: 1 }],
        ["an unknown operator", { id: { nope: 1 } }],
        ["a bare null on JSON", { metadata: null }],
        ["a bare object on JSON", { metadata: { k: 1 } }],
        ["a bare number on JSON", { metadata: 5 }],
        ["a bare string on JSON", { metadata: "x" }],
        ["in on JSON", { metadata: { in: [1] } }],
        [
          "a JSON path with equals undefined",
          { metadata: { path: ["k"], equals: undefined } },
        ],
        ["a JSON path alone", { metadata: { path: ["k"] } }],
        ["a JSON path as a string", { metadata: { path: "k", equals: 1 } }],
        ["a JSON path on text", { workflowName: { path: ["k"], equals: 1 } }],
        [
          "a compound key in a list filter",
          { workflowRunId_stageId: { workflowRunId: "a", stageId: "s" } },
        ],
      ];

      // 6 and 7 accept these, but no adapter calls them, so the bridge rejects
      // them rather than emulate them. Hence asserted on 8 only.
      const UNSUPPORTED_ON_8: Array<[string, unknown]> = [
        ["AND", { AND: [{ id: "a" }] }],
        ["NOT", { NOT: { id: "a" } }],
        ["a nested not", { definitionVersion: { not: { equals: "x" } } }],
        ["not of nothing", { definitionVersion: { not: {} } }],
        ["an ISO string for a Date", { startedAt: "2026-01-01T00:00:00.000Z" }],
        [
          "an offset string for a Date",
          { startedAt: "2026-01-01T02:00:00.000+02:00" },
        ],
        ["contains", { workflowName: { contains: "b" } }],
        ["endsWith", { workflowName: { endsWith: "b" } }],
        ["mode", { workflowName: { startsWith: "a", mode: "insensitive" } }],
        ["lt on JSON", { metadata: { lt: 1 } }],
        ["a JSON path with not", { metadata: { path: ["k"], not: 1 } }],
        ["a JSON path with gt", { metadata: { path: ["k"], gt: 0 } }],
        ["a to-many filter with nothing in it", { stages: {} }],
        ["some", { stages: { some: {} } }],
        ["every", { stages: { every: {} } }],
      ];

      describe("reads", () => {
        beforeAll(seed);

        it.each(FILTERS)("filters on %s", async (_name, where, expected) => {
          expect(await runs(where)).toBe(expected);
        });
        it.each(
          STAGE_FILTERS,
        )("filters stages on %s", async (_name, where, expected) => {
          expect(await stages(where)).toBe(expected);
        });
        it.each(
          ANNOTATION_FILTERS,
        )("filters annotations on %s", async (_name, where, expected) => {
          expect(await annotations(where)).toBe(expected);
        });
        it.each(INVALID)("rejects %s", async (_name, where) => {
          await expect(runs(where)).rejects.toThrow(REJECTED);
        });
        it.runIf(isPrisma8).each(UNSUPPORTED_ON_8)(
          "does not take %s on Prisma 8",
          async (_name, where) => {
            await expect(runs(where)).rejects.toThrow(REJECTED);
          },
        );

        const READS: Array<[string, () => Promise<unknown>, unknown]> = [
          [
            "orderBy asc over NULLs",
            () =>
              runs(
                {},
                { orderBy: [{ startedAt: "asc" }, { id: "asc" }], take: 5 },
              ),
            "b,c,a,d,e",
          ],
          [
            "orderBy desc over NULLs",
            () =>
              runs(
                {},
                { orderBy: [{ startedAt: "desc" }, { id: "asc" }], take: 5 },
              ),
            "a,d,e,f,g",
          ],
          [
            "orderBy of JSON asc",
            () => runs({}, { orderBy: [{ metadata: "asc" }, { id: "asc" }] }),
            "c,d,g,f,h,j,i,k,e,l,a,b",
          ],
          [
            "orderBy of JSON desc",
            () => runs({}, { orderBy: [{ metadata: "desc" }, { id: "asc" }] }),
            "a,b,e,l,k,i,j,h,f,g,c,d",
          ],
          [
            "orderBy of an enum",
            () => runs({}, { orderBy: [{ status: "desc" }, { id: "asc" }] }),
            "d,e,a,b,c,f,g,h,i,j,k,l",
          ],
          [
            "orderBy of a float",
            () => runs({}, { orderBy: [{ totalCost: "asc" }, { id: "asc" }] }),
            ALL,
          ],
          [
            "take with no order, by primary key",
            () => runs({}, { orderBy: undefined, take: 3 }),
            "a,b,c",
          ],
          [
            "take with an empty order, by primary key",
            () => runs({}, { orderBy: {}, take: 3 }),
            "a,b,c",
          ],
          [
            "take with an empty order list, by primary key",
            () => runs({}, { orderBy: [], take: 3 }),
            "a,b,c",
          ],
          ["take: 0", () => runs({}, { take: 0 }), ""],
          ["a fractional take", () => runs({}, { take: 2.5 }), "a,b"],
          [
            "an undefined take",
            async () => (await runs({}, { take: undefined })).length,
            ALL.length,
          ],
          [
            "findFirst with no match",
            () => prisma.workflowRun.findFirst({ where: { id: "zz" } }),
            null,
          ],
          [
            "findFirst with take: 1",
            () =>
              prisma.workflowRun.findFirst({
                take: 1,
                orderBy: { id: "desc" },
                select: { id: true },
              }),
            { id: "l" },
          ],
          [
            "select with a false column",
            () =>
              prisma.workflowRun.findFirst({
                where: { id: "a" },
                select: { id: true, workflowName: false },
              }),
            { id: "a" },
          ],
          [
            "select with an undefined column",
            () =>
              prisma.workflowRun.findFirst({
                where: { id: "a" },
                select: { id: true, workflowName: undefined },
              }),
            { id: "a" },
          ],
          [
            "select with a false relation",
            () =>
              prisma.workflowRun.findFirst({
                where: { id: "a" },
                select: { id: true, stages: false },
              }),
            { id: "a" },
          ],
          [
            "select of a to-many relation",
            async () => {
              const row = await prisma.workflowRun.findFirst({
                where: { id: "a" },
                select: { id: true, stages: { select: { stageId: true } } },
              });
              return { ...row, stages: sorted(row.stages, "stageId") };
            },
            { id: "a", stages: [{ stageId: "s" }, { stageId: "t" }] },
          ],
          [
            "select of a to-many relation with no rows",
            () =>
              prisma.workflowRun.findFirst({
                where: { id: "d" },
                select: { stages: { select: { stageId: true } } },
              }),
            { stages: [] },
          ],
          [
            "include of a to-one relation",
            async () =>
              (
                await prisma.workflowStage.findMany({
                  where: { id: "s1" },
                  include: { workflowRun: { select: { workflowType: true } } },
                })
              )[0].workflowRun,
            { workflowType: "t" },
          ],
          [
            "include of an optional relation with no row",
            async () =>
              (
                await prisma.workflowAnnotation.findMany({
                  where: { id: "n2" },
                  include: { workflowStage: { select: { stageId: true } } },
                })
              )[0].workflowStage,
            null,
          ],
          [
            "include with no parents",
            () =>
              prisma.workflowStage.findMany({
                where: { id: "zz" },
                include: { workflowRun: { select: { workflowType: true } } },
              }),
            [],
          ],
          [
            "an empty include",
            async () =>
              (
                await prisma.workflowRun.findFirst({
                  where: { id: "a" },
                  include: {},
                })
              ).id,
            "a",
          ],
          [
            "a false include",
            async () =>
              "stages" in
              (await prisma.workflowRun.findFirst({
                where: { id: "a" },
                include: { stages: false },
              })),
            false,
          ],
          ["count with no args", () => prisma.workflowRun.count(), 12],
          [
            "count with an empty where",
            () => prisma.workflowRun.count({ where: {} }),
            12,
          ],
          [
            "count of a filter",
            () => prisma.workflowRun.count({ where: { status: "RUNNING" } }),
            2,
          ],
          [
            "count of OR: []",
            () => prisma.workflowRun.count({ where: { OR: [] } }),
            0,
          ],
          [
            "count of OR: [{}]",
            () => prisma.workflowRun.count({ where: { OR: [{}] } }),
            0,
          ],
          [
            "aggregate _count over zero rows",
            () =>
              prisma.workflowRun.aggregate({
                where: { id: "zz" },
                _count: { _all: true },
              }),
            { _count: { _all: 0 } },
          ],
          [
            "aggregate _max over zero rows",
            () =>
              prisma.workflowRun.aggregate({
                where: { id: "zz" },
                _max: { priority: true },
              }),
            { _max: { priority: null } },
          ],
          [
            "aggregate _min over zero rows",
            () =>
              prisma.workflowRun.aggregate({
                where: { id: "zz" },
                _min: { createdAt: true },
              }),
            { _min: { createdAt: null } },
          ],
          [
            "aggregate of everything over zero rows",
            () =>
              prisma.workflowRun.aggregate({
                where: { id: "zz" },
                _count: { _all: true },
                _min: { priority: true },
                _max: { startedAt: true },
              }),
            {
              _count: { _all: 0 },
              _min: { priority: null },
              _max: { startedAt: null },
            },
          ],
          [
            "aggregate of OR: [{}]",
            () =>
              prisma.workflowRun.aggregate({
                where: { OR: [{}] },
                _count: { _all: true },
              }),
            { _count: { _all: 0 } },
          ],
          [
            "groupBy of OR: [{}]",
            () =>
              prisma.workflowRun.groupBy({
                by: ["status"],
                where: { OR: [{}] },
                _count: { _all: true },
              }),
            [],
          ],
          [
            "aggregate _count",
            () => prisma.workflowRun.aggregate({ _count: { _all: true } }),
            { _count: { _all: 12 } },
          ],
          [
            "aggregate _max",
            () => prisma.workflowRun.aggregate({ _max: { priority: true } }),
            { _max: { priority: 12 } },
          ],
          [
            "aggregate _min of a Date",
            () => prisma.workflowRun.aggregate({ _min: { startedAt: true } }),
            { _min: { startedAt: D1 } },
          ],
          [
            "aggregate _max of text",
            () =>
              prisma.workflowRun.aggregate({ _max: { workflowName: true } }),
            { _max: { workflowName: "z5" } },
          ],
          [
            "aggregate _max of an enum",
            () => prisma.workflowRun.aggregate({ _max: { status: true } }),
            { _max: { status: "RUNNING" } },
          ],
          [
            "groupBy over zero rows",
            () =>
              prisma.workflowRun.groupBy({
                by: ["status"],
                where: { id: "zz" },
                _count: { _all: true },
              }),
            [],
          ],
          [
            "groupBy with _count",
            async () =>
              sorted(
                await prisma.workflowRun.groupBy({
                  by: ["status"],
                  _count: { _all: true },
                }),
                "status",
              ),
            [
              { status: "PENDING", _count: { _all: 10 } },
              { status: "RUNNING", _count: { _all: 2 } },
            ],
          ],
          [
            "groupBy with _min and _max",
            () =>
              prisma.workflowStage.groupBy({
                by: ["workflowRunId"],
                where: { workflowRunId: "c" },
                _min: { startedAt: true },
                _max: { duration: true },
              }),
            [
              {
                workflowRunId: "c",
                _min: { startedAt: D1 },
                _max: { duration: null },
              },
            ],
          ],
          [
            "groupBy on a nullable column",
            async () =>
              sorted(
                await prisma.workflowRun.groupBy({
                  by: ["definitionVersion"],
                  _count: { _all: true },
                }),
                "definitionVersion",
              ),
            [
              { definitionVersion: null, _count: { _all: 10 } },
              { definitionVersion: "x", _count: { _all: 1 } },
              { definitionVersion: "y", _count: { _all: 1 } },
            ],
          ],
          [
            "groupBy of two columns",
            async () =>
              (
                await prisma.workflowRun.groupBy({
                  by: ["status", "definitionVersion"],
                })
              ).length,
            4,
          ],
          [
            "findUnique of a miss",
            () => prisma.workflowRun.findUnique({ where: { id: "zz" } }),
            null,
          ],
          [
            "findUnique beside a matching field",
            () =>
              prisma.workflowRun.findUnique({
                where: { id: "a", workflowId: "wf" },
                select: { id: true },
              }),
            { id: "a" },
          ],
          [
            "findUnique beside a missing field",
            () =>
              prisma.workflowRun.findUnique({
                where: { id: "a", workflowId: "nope" },
              }),
            null,
          ],
          [
            "findUnique beside an undefined field",
            () =>
              prisma.workflowRun.findUnique({
                where: { id: "a", workflowId: undefined },
                select: { id: true },
              }),
            { id: "a" },
          ],
          [
            "findUnique beside OR: []",
            () => prisma.workflowRun.findUnique({ where: { id: "a", OR: [] } }),
            null,
          ],
          [
            "findUnique beside OR: [{}]",
            () =>
              prisma.workflowRun.findUnique({ where: { id: "a", OR: [{}] } }),
            null,
          ],
          [
            "findUnique beside an OR",
            () =>
              prisma.workflowRun.findUnique({
                where: { id: "a", OR: [{ workflowId: "wf" }] },
                select: { id: true },
              }),
            { id: "a" },
          ],
          [
            "findUnique beside a relation filter",
            () =>
              prisma.workflowRun.findUnique({
                where: { id: "a", stages: { none: {} } },
              }),
            null,
          ],
          [
            "findUnique beside an operator",
            () =>
              prisma.workflowRun.findUnique({
                where: { id: "a", priority: { gt: 0 } },
                select: { id: true },
              }),
            { id: "a" },
          ],
          [
            "findUnique of a compound key",
            () =>
              prisma.workflowStage.findUnique({
                where: {
                  workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
                },
                select: { id: true },
              }),
            { id: "s1" },
          ],
          [
            "findUnique of a compound key miss",
            () =>
              prisma.workflowStage.findUnique({
                where: {
                  workflowRunId_stageId: { workflowRunId: "a", stageId: "zz" },
                },
              }),
            null,
          ],
          [
            "findUnique of the id and a compound key",
            () =>
              prisma.workflowStage.findUnique({
                where: {
                  id: "s1",
                  workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
                },
                select: { id: true },
              }),
            { id: "s1" },
          ],
          [
            "findUnique of an id and a compound key that differ",
            () =>
              prisma.workflowStage.findUnique({
                where: {
                  id: "s2",
                  workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
                },
              }),
            null,
          ],
          [
            "findUnique of a compound key beside a field",
            () =>
              prisma.workflowStage.findUnique({
                where: {
                  workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
                  status: "PENDING",
                },
                select: { id: true },
              }),
            { id: "s1" },
          ],
          [
            "findUnique of a compound key beside a missing field",
            () =>
              prisma.workflowStage.findUnique({
                where: {
                  workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
                  status: "RUNNING",
                },
              }),
            null,
          ],
          [
            "findUnique of a compound primary key",
            () =>
              prisma.workflowDefinition.findUnique({
                where: {
                  workflowId_version: { workflowId: "zz", version: "1" },
                },
              }),
            null,
          ],
        ];
        it.each(READS)("reads %s", async (_name, read, expected) => {
          expect(await read()).toEqual(expected);
        });

        const INVALID_READS: Array<[string, () => Promise<unknown>]> = [
          [
            "orderBy of two columns in one entry",
            () => runs({}, { orderBy: { priority: "desc", id: "asc" } }),
          ],
          [
            "orderBy of undefined in a list",
            () => runs({}, { orderBy: [undefined] }),
          ],
          [
            "orderBy of a bad direction",
            () => runs({}, { orderBy: { priority: "up" } }),
          ],
          [
            "orderBy of an unknown column",
            () => runs({}, { orderBy: { nope: "asc" } }),
          ],
          ["take: null", () => runs({}, { take: null })],
          [
            "findFirst with take: 0",
            () => prisma.workflowRun.findFirst({ take: 0 }),
          ],
          [
            "findFirst with take: 2",
            () => prisma.workflowRun.findFirst({ take: 2 }),
          ],
          [
            "an empty select",
            () => prisma.workflowRun.findFirst({ select: {} }),
          ],
          [
            "a select of false only",
            () => prisma.workflowRun.findFirst({ select: { id: false } }),
          ],
          [
            "a select of undefined only",
            () => prisma.workflowRun.findFirst({ select: { id: undefined } }),
          ],
          [
            "a select with options on a column",
            () =>
              prisma.workflowRun.findFirst({
                select: { id: { unrecognized: true } },
              }),
          ],
          [
            "a select of a string",
            () => prisma.workflowRun.findFirst({ select: { id: "yes" } }),
          ],
          [
            "a select of null",
            () => prisma.workflowRun.findFirst({ select: { id: null } }),
          ],
          [
            "a select of an unknown column",
            () => prisma.workflowRun.findFirst({ select: { nope: true } }),
          ],
          [
            "an empty select of a relation",
            () =>
              prisma.workflowRun.findFirst({
                select: { stages: { select: {} } },
              }),
          ],
          [
            "select with include",
            () =>
              prisma.workflowRun.findFirst({
                select: { id: true },
                include: { stages: true },
              }),
          ],
          [
            "include of an unknown relation",
            () => prisma.workflowRun.findFirst({ include: { nope: true } }),
          ],
          [
            "include of a column",
            () => prisma.workflowRun.findFirst({ include: { id: true } }),
          ],
          [
            "an empty select in an include",
            () =>
              prisma.workflowStage.findMany({
                include: { workflowRun: { select: {} } },
              }),
          ],
          ["an aggregate of nothing", () => prisma.workflowRun.aggregate({})],
          ["an empty _min", () => prisma.workflowRun.aggregate({ _min: {} })],
          [
            "_min of false",
            () => prisma.workflowRun.aggregate({ _min: { priority: false } }),
          ],
          [
            "_min of undefined",
            () =>
              prisma.workflowRun.aggregate({ _min: { priority: undefined } }),
          ],
          [
            "_min of a string",
            () => prisma.workflowRun.aggregate({ _min: { priority: "yes" } }),
          ],
          [
            "_max of JSON",
            () => prisma.workflowRun.aggregate({ _max: { metadata: true } }),
          ],
          [
            "_max of an unknown column",
            () => prisma.workflowRun.aggregate({ _max: { nope: true } }),
          ],
          [
            "_count of false",
            () => prisma.workflowRun.aggregate({ _count: { _all: false } }),
          ],
          [
            "_count of undefined",
            () => prisma.workflowRun.aggregate({ _count: { _all: undefined } }),
          ],
          [
            "an empty _count",
            () => prisma.workflowRun.aggregate({ _count: {} }),
          ],
          [
            "groupBy of no columns",
            () =>
              prisma.workflowRun.groupBy({ by: [], _count: { _all: true } }),
          ],
          [
            "groupBy with no by",
            () => prisma.workflowRun.groupBy({ _count: { _all: true } }),
          ],
          [
            "groupBy of an unknown column",
            () => prisma.workflowRun.groupBy({ by: ["nope"] }),
          ],
          [
            "groupBy with _min of false",
            () =>
              prisma.workflowRun.groupBy({
                by: ["status"],
                _min: { priority: false },
              }),
          ],
          [
            "groupBy with _count of false",
            () =>
              prisma.workflowRun.groupBy({
                by: ["status"],
                _count: { _all: false },
              }),
          ],
          ["findUnique with no args", () => prisma.workflowRun.findUnique()],
          [
            "findUnique with an empty where",
            () => prisma.workflowRun.findUnique({ where: {} }),
          ],
          [
            "findUnique of an undefined key",
            () => prisma.workflowRun.findUnique({ where: { id: undefined } }),
          ],
          [
            "findUnique of no key",
            () =>
              prisma.workflowRun.findUnique({ where: { workflowId: "wf" } }),
          ],
          [
            "findUnique of a null key",
            () => prisma.workflowRun.findUnique({ where: { id: null } }),
          ],
          [
            "findUnique of a filter on the key",
            () =>
              prisma.workflowRun.findUnique({ where: { id: { equals: "a" } } }),
          ],
          [
            "findUnique of in on the key",
            () =>
              prisma.workflowRun.findUnique({ where: { id: { in: ["a"] } } }),
          ],
          [
            "findUnique of a number key",
            () => prisma.workflowRun.findUnique({ where: { id: 5 } }),
          ],
          [
            "findUnique of OR alone",
            () =>
              prisma.workflowRun.findUnique({ where: { OR: [{ id: "a" }] } }),
          ],
          [
            "findUnique with take",
            () =>
              prisma.workflowRun.findUnique({ where: { id: "a" }, take: 1 }),
          ],
          [
            "findUnique with orderBy",
            () =>
              prisma.workflowRun.findUnique({
                where: { id: "a" },
                orderBy: { id: "asc" },
              }),
          ],
          [
            "findUnique of a compound key missing a part",
            () =>
              prisma.workflowStage.findUnique({
                where: { workflowRunId_stageId: { workflowRunId: "a" } },
              }),
          ],
          [
            "findUnique of a compound key with an undefined part",
            () =>
              prisma.workflowStage.findUnique({
                where: {
                  workflowRunId_stageId: {
                    workflowRunId: "a",
                    stageId: undefined,
                  },
                },
              }),
          ],
          [
            "findUnique of a compound key with a null part",
            () =>
              prisma.workflowStage.findUnique({
                where: {
                  workflowRunId_stageId: { workflowRunId: "a", stageId: null },
                },
              }),
          ],
          [
            "findUnique of a compound key with a filter part",
            () =>
              prisma.workflowStage.findUnique({
                where: {
                  workflowRunId_stageId: {
                    workflowRunId: "a",
                    stageId: { equals: "s" },
                  },
                },
              }),
          ],
          [
            "findUnique of a compound key with an extra column",
            () =>
              prisma.workflowStage.findUnique({
                where: {
                  workflowRunId_stageId: {
                    workflowRunId: "a",
                    stageId: "s",
                    status: "PENDING",
                  },
                },
              }),
          ],
          [
            "findUnique of an empty compound key",
            () =>
              prisma.workflowStage.findUnique({
                where: { workflowRunId_stageId: {} },
              }),
          ],
          [
            "findUnique of the columns of a compound key",
            () =>
              prisma.workflowStage.findUnique({
                where: { workflowRunId: "a", stageId: "s" },
              }),
          ],
          [
            "findUnique of the id and an incomplete compound key",
            () =>
              prisma.workflowStage.findUnique({
                where: {
                  id: "s1",
                  workflowRunId_stageId: {
                    workflowRunId: "a",
                    stageId: undefined,
                  },
                },
              }),
          ],
          [
            "findUnique of a compound key with a null nullable part",
            () =>
              prisma.workflowAnnotation.findUnique({
                where: {
                  workflowRunId_key_idempotencyKey: {
                    workflowRunId: "a",
                    key: "k",
                    idempotencyKey: null,
                  },
                },
              }),
          ],
        ];
        it.each(INVALID_READS)("rejects %s", async (_name, read) => {
          await expect(read()).rejects.toThrow(REJECTED);
        });

        const UNSUPPORTED_READS_ON_8: Array<[string, () => Promise<unknown>]> =
          [
            [
              "orderBy of undefined",
              () => runs({}, { orderBy: { priority: undefined } }),
            ],
            [
              "orderBy with nulls",
              () =>
                runs(
                  {},
                  { orderBy: { startedAt: { sort: "asc", nulls: "first" } } },
                ),
            ],
            [
              "orderBy of a relation count",
              () => runs({}, { orderBy: { stages: { _count: "asc" } } }),
            ],
            [
              "a unique key beside one of its own columns",
              () =>
                prisma.workflowStage.findUnique({
                  where: {
                    workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
                    stageId: "t",
                  },
                }),
            ],
            ["a negative take", () => runs({}, { take: -1 })],
            ["skip", () => runs({}, { skip: 1 })],
            ["cursor", () => runs({}, { cursor: { id: "a" } })],
            ["distinct", () => runs({}, { distinct: ["id"] })],
            [
              "a select of a number",
              () => prisma.workflowRun.findFirst({ select: { id: 1 } }),
            ],
            [
              "a select of an empty object",
              () => prisma.workflowRun.findFirst({ select: { id: {} } }),
            ],
            [
              "a relation selected with true",
              () => prisma.workflowRun.findFirst({ select: { stages: true } }),
            ],
            [
              "a relation included with true",
              () => prisma.workflowRun.findFirst({ include: { stages: true } }),
            ],
            [
              "an include with a where",
              () =>
                prisma.workflowRun.findFirst({
                  include: { stages: { where: { stageId: "s" } } },
                }),
            ],
            [
              "count with select",
              () => prisma.workflowRun.count({ select: { _all: true } }),
            ],
            ["count with take", () => prisma.workflowRun.count({ take: 1 })],
            [
              "_count: true",
              () => prisma.workflowRun.aggregate({ _count: true }),
            ],
            [
              "_count of a column",
              () => prisma.workflowRun.aggregate({ _count: { id: true } }),
            ],
            [
              "_sum",
              () => prisma.workflowRun.aggregate({ _sum: { priority: true } }),
            ],
            [
              "_avg",
              () => prisma.workflowRun.aggregate({ _avg: { priority: true } }),
            ],
            [
              "aggregate with take",
              () =>
                prisma.workflowRun.aggregate({
                  take: 1,
                  _max: { priority: true },
                }),
            ],
            [
              "aggregate with orderBy",
              () =>
                prisma.workflowRun.aggregate({
                  orderBy: { id: "asc" },
                  _max: { priority: true },
                }),
            ],
            [
              "groupBy of a string",
              () => prisma.workflowRun.groupBy({ by: "status" }),
            ],
            [
              "groupBy with having",
              () =>
                prisma.workflowRun.groupBy({
                  by: ["status"],
                  having: { status: "RUNNING" },
                }),
            ],
            [
              "groupBy with orderBy",
              () =>
                prisma.workflowRun.groupBy({
                  by: ["status"],
                  orderBy: { status: "asc" },
                }),
            ],
            [
              "groupBy with take",
              () =>
                prisma.workflowRun.groupBy({
                  by: ["status"],
                  take: 1,
                  orderBy: { status: "asc" },
                }),
            ],
          ];
        it.runIf(isPrisma8).each(UNSUPPORTED_READS_ON_8)(
          "does not take %s on Prisma 8",
          async (_name, read) => {
            await expect(read()).rejects.toThrow(REJECTED);
          },
        );
      });

      describe("writes", () => {
        beforeEach(seed);

        const row = (id = "a") =>
          prisma.workflowRun.findUnique({
            where: { id },
            select: {
              priority: true,
              metadata: true,
              input: true,
              startedAt: true,
              definitionVersion: true,
            },
          });
        const updatedAt = async (id = "a") =>
          (
            await prisma.workflowRun.findUnique({
              where: { id },
              select: { updatedAt: true },
            })
          ).updatedAt.getTime();
        const blobs = async () =>
          (
            await prisma.workflowBlob.findMany({
              select: { key: true, data: true },
            })
          ).sort((a: { key: string }, b: { key: string }) =>
            a.key.localeCompare(b.key),
          );
        const X = { key: "x", data: 1 };
        const Y = { key: "y", data: 2 };
        const blobStage = { stageName: "s", stageNumber: 1, executionGroup: 1 };
        const ROW = {
          priority: 1,
          metadata: null,
          input: {},
          startedAt: null,
          definitionVersion: "x",
        };

        // [name, data, row after, whether updatedAt moved]
        const UPDATES: Array<[string, unknown, unknown, boolean]> = [
          ["data: {}", {}, ROW, false],
          ["only undefined values", { priority: undefined }, ROW, false],
          [
            "undefined beside a value",
            { priority: undefined, workflowName: "n" },
            ROW,
            true,
          ],
          ["null JSON", { metadata: null }, ROW, true],
          [
            "a JSON object",
            { metadata: { z: 1 } },
            { ...ROW, metadata: { z: 1 } },
            true,
          ],
          ["a JSON string", { metadata: "s" }, { ...ROW, metadata: "s" }, true],
          [
            "a JSON { set }, as a value",
            { metadata: { set: 1 } },
            { ...ROW, metadata: { set: 1 } },
            true,
          ],
          [
            "a JSON { increment }, as a value",
            { metadata: { increment: 1 } },
            { ...ROW, metadata: { increment: 1 } },
            true,
          ],
          [
            "null JSON on a required column",
            { input: null },
            { ...ROW, input: null },
            true,
          ],
          [
            "{ increment }",
            { priority: { increment: 2 } },
            { ...ROW, priority: 3 },
            true,
          ],
          [
            "{ decrement }",
            { priority: { decrement: 2 } },
            { ...ROW, priority: -1 },
            true,
          ],
          ["{ increment: 0 }", { priority: { increment: 0 } }, ROW, true],
          ["{ set }", { priority: { set: 7 } }, { ...ROW, priority: 7 }, true],
          [
            "{ set: null }",
            { definitionVersion: { set: null } },
            { ...ROW, definitionVersion: null },
            true,
          ],
          [
            "null on a nullable column",
            { definitionVersion: null },
            { ...ROW, definitionVersion: null },
            true,
          ],
          ["a Date", { startedAt: D2 }, { ...ROW, startedAt: D2 }, true],
          ["a null Date", { startedAt: null }, ROW, true],
        ];
        it.each(
          UPDATES,
        )("updates with %s", async (_name, data, expected, bumped) => {
          const before = await updatedAt();
          await new Promise((resolve) => setTimeout(resolve, 5));
          expect(
            await prisma.workflowRun.update({
              where: { id: "a" },
              data,
              select: { id: true },
            }),
          ).toEqual({ id: "a" });
          expect(await row()).toEqual(expected);
          expect((await updatedAt()) !== before).toBe(bumped);
        });

        const WRITES: Array<[string, () => Promise<unknown>, unknown]> = [
          ...(
            [
              ["a fractional int", { priority: 562.5 }, 562],
              ["a negative fractional int", { priority: -5.5 }, -5],
              ["the smallest int", { priority: -(2 ** 31) }, -(2 ** 31)],
              [
                "a fractional { increment }",
                { priority: { increment: 1.5 } },
                2,
              ],
            ] as Array<[string, Record<string, unknown>, number]>
          ).map(
            ([name, data, priority]): [
              string,
              () => Promise<unknown>,
              unknown,
            ] => [
              `update with ${name}`,
              () =>
                prisma.workflowRun.update({
                  where: { id: "a" },
                  data,
                  select: { priority: true },
                }),
              { priority },
            ],
          ),
          [
            "update with a matching fence",
            () =>
              prisma.workflowRun.update({
                where: { id: "a", version: 1 },
                data: { priority: 99 },
                select: { priority: true },
              }),
            { priority: 99 },
          ],
          [
            "update with an operator fence",
            () =>
              prisma.workflowRun.update({
                where: { id: "a", status: { in: ["PENDING"] } },
                data: { priority: 99 },
                select: { priority: true },
              }),
            { priority: 99 },
          ],
          [
            "update of a compound key with a fence",
            () =>
              prisma.workflowStage.update({
                where: {
                  workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
                  version: 1,
                },
                data: { duration: 1 },
                select: { id: true },
              }),
            { id: "s1" },
          ],
          [
            "data: {} on a model without updatedAt",
            () =>
              prisma.workflowAnnotation.update({
                where: { id: "n1" },
                data: {},
                select: { id: true },
              }),
            { id: "n1" },
          ],
          [
            "undefined data on a model without updatedAt",
            () =>
              prisma.workflowAnnotation.update({
                where: { id: "n1" },
                data: { key: undefined },
                select: { id: true },
              }),
            { id: "n1" },
          ],
          [
            "{ increment } on a NULL column",
            async () => {
              await prisma.workflowStage.update({
                where: { id: "s3" },
                data: { duration: { increment: 1 } },
              });
              return prisma.workflowStage.findUnique({
                where: { id: "s3" },
                select: { duration: true },
              });
            },
            { duration: null },
          ],
          [
            "{ increment } on a float",
            async () => {
              await prisma.workflowRun.update({
                where: { id: "a" },
                data: { totalCost: { increment: 0.125 } },
              });
              return prisma.workflowRun.findUnique({
                where: { id: "a" },
                select: { totalCost: true },
              });
            },
            { totalCost: 0.125 },
          ],
          [
            "an explicit updatedAt",
            async () => {
              await prisma.workflowRun.update({
                where: { id: "a" },
                data: { updatedAt: D1 },
              });
              return updatedAt();
            },
            D1.getTime(),
          ],
          [
            "updateMany matching zero rows",
            () =>
              prisma.workflowRun.updateMany({
                where: { id: "zz" },
                data: { priority: 9 },
              }),
            { count: 0 },
          ],
          [
            "updateMany of every row",
            () => prisma.workflowRun.updateMany({ data: { priority: 9 } }),
            { count: 12 },
          ],
          [
            "updateMany with an empty where",
            () =>
              prisma.workflowRun.updateMany({
                where: {},
                data: { priority: 9 },
              }),
            { count: 12 },
          ],
          [
            "updateMany of OR: []",
            () =>
              prisma.workflowRun.updateMany({
                where: { OR: [] },
                data: { priority: 9 },
              }),
            { count: 0 },
          ],
          [
            "updateMany of OR: [{}]",
            () =>
              prisma.workflowRun.updateMany({
                where: { OR: [{}] },
                data: { priority: 9 },
              }),
            { count: 0 },
          ],
          [
            "updateMany with a stale fence",
            () =>
              prisma.workflowRun.updateMany({
                where: { id: "a", version: 2 },
                data: { priority: 9 },
              }),
            { count: 0 },
          ],
          [
            "updateMany of { increment }",
            () =>
              prisma.workflowRun.updateMany({
                where: { id: "a" },
                data: { priority: { increment: 1 } },
              }),
            { count: 1 },
          ],
          [
            "updateMany of null JSON",
            () =>
              prisma.workflowRun.updateMany({
                where: { id: "a" },
                data: { metadata: null },
              }),
            { count: 1 },
          ],
          [
            "updateMany of a relation filter",
            () =>
              prisma.workflowRun.updateMany({
                where: { stages: { none: {} } },
                data: { priority: 9 },
              }),
            { count: 9 },
          ],
          [
            "delete",
            async () => [
              await prisma.workflowRun.delete({
                where: { id: "a" },
                select: { id: true },
              }),
              await prisma.workflowRun.count(),
            ],
            [{ id: "a" }, 11],
          ],
          [
            "delete with a matching fence",
            async () => [
              await prisma.workflowRun.delete({
                where: { id: "a", version: 1 },
                select: { id: true },
              }),
              await prisma.workflowRun.count(),
            ],
            [{ id: "a" }, 11],
          ],
          [
            "deleteMany matching zero rows",
            async () => [
              await prisma.workflowRun.deleteMany({ where: { id: "zz" } }),
              await prisma.workflowRun.count(),
            ],
            [{ count: 0 }, 12],
          ],
          [
            "deleteMany with no args",
            async () => [
              await prisma.workflowRun.deleteMany(),
              await prisma.workflowRun.count(),
            ],
            [{ count: 12 }, 0],
          ],
          [
            "deleteMany with an empty where",
            async () => [
              await prisma.workflowRun.deleteMany({ where: {} }),
              await prisma.workflowRun.count(),
            ],
            [{ count: 12 }, 0],
          ],
          [
            "deleteMany of OR: []",
            async () => [
              await prisma.workflowRun.deleteMany({ where: { OR: [] } }),
              await prisma.workflowRun.count(),
            ],
            [{ count: 0 }, 12],
          ],
          [
            "deleteMany of OR: [{}]",
            async () => [
              await prisma.workflowRun.deleteMany({ where: { OR: [{}] } }),
              await prisma.workflowRun.count(),
            ],
            [{ count: 0 }, 12],
          ],
          [
            "deleteMany of an undefined field",
            async () => [
              await prisma.workflowRun.deleteMany({ where: { id: undefined } }),
              await prisma.workflowRun.count(),
            ],
            [{ count: 12 }, 0],
          ],
          [
            "deleteMany of a no-op",
            async () => [
              await prisma.workflowRun.deleteMany({ where: { id: {} } }),
              await prisma.workflowRun.count(),
            ],
            [{ count: 12 }, 0],
          ],
          [
            "deleteMany of in: []",
            async () => [
              await prisma.workflowRun.deleteMany({
                where: { id: { in: [] } },
              }),
              await prisma.workflowRun.count(),
            ],
            [{ count: 0 }, 12],
          ],
          [
            "deleteMany of a relation filter",
            async () => [
              await prisma.workflowRun.deleteMany({
                where: { stages: { none: {} } },
              }),
              await prisma.workflowRun.count(),
            ],
            [{ count: 9 }, 3],
          ],
          [
            "upsert with equal keys over a row",
            async () => [
              await prisma.workflowBlob.upsert({
                where: { key: "x" },
                create: { key: "x", data: 3 },
                update: { data: 4 },
                select: { key: true },
              }),
              await blobs(),
            ],
            [{ key: "x" }, [{ key: "x", data: 4 }, Y]],
          ],
          [
            "upsert with equal keys and no row",
            async () => [
              (
                await prisma.workflowBlob.upsert({
                  where: { key: "n" },
                  create: { key: "n", data: 3 },
                  update: { data: 4 },
                })
              ).data,
              await blobs(),
            ],
            [3, [{ key: "n", data: 3 }, X, Y]],
          ],
          [
            "upsert with differing keys over a row",
            async () => [
              (
                await prisma.workflowBlob.upsert({
                  where: { key: "x" },
                  create: { key: "y", data: 3 },
                  update: { data: 4 },
                })
              ).key,
              await blobs(),
            ],
            ["x", [{ key: "x", data: 4 }, Y]],
          ],
          [
            "upsert with differing keys and no row",
            async () => [
              (
                await prisma.workflowBlob.upsert({
                  where: { key: "n" },
                  create: { key: "m", data: 3 },
                  update: { data: 4 },
                })
              ).key,
              await blobs(),
            ],
            ["m", [{ key: "m", data: 3 }, X, Y]],
          ],
          [
            "upsert with update: {} and equal keys over a row",
            async () => [
              (
                await prisma.workflowBlob.upsert({
                  where: { key: "x" },
                  create: { key: "x", data: 3 },
                  update: {},
                })
              ).data,
              await blobs(),
            ],
            [1, [X, Y]],
          ],
          [
            "upsert with update: {} and equal keys and no row",
            async () => [
              (
                await prisma.workflowBlob.upsert({
                  where: { key: "n" },
                  create: { key: "n", data: 3 },
                  update: {},
                })
              ).data,
              await blobs(),
            ],
            [3, [{ key: "n", data: 3 }, X, Y]],
          ],
          [
            "upsert with update: {} and differing keys over a row",
            async () => [
              (
                await prisma.workflowBlob.upsert({
                  where: { key: "x" },
                  create: { key: "y", data: 3 },
                  update: {},
                })
              ).key,
              await blobs(),
            ],
            ["x", [X, Y]],
          ],
          [
            "upsert with update: {} and differing keys and no row",
            async () => [
              (
                await prisma.workflowBlob.upsert({
                  where: { key: "n" },
                  create: { key: "m", data: 3 },
                  update: {},
                })
              ).key,
              await blobs(),
            ],
            ["m", [{ key: "m", data: 3 }, X, Y]],
          ],
          [
            "upsert with update of undefined",
            async () => [
              (
                await prisma.workflowBlob.upsert({
                  where: { key: "x" },
                  create: { key: "x", data: 3 },
                  update: { data: undefined },
                })
              ).data,
              await blobs(),
            ],
            [1, [X, Y]],
          ],
          [
            "upsert leaving updatedAt with update: {}",
            async () => {
              const stamp = async () =>
                (
                  await prisma.workflowBlob.findUnique({ where: { key: "x" } })
                ).updatedAt.getTime();
              const before = await stamp();
              await new Promise((resolve) => setTimeout(resolve, 5));
              await prisma.workflowBlob.upsert({
                where: { key: "x" },
                create: { key: "x", data: 3 },
                update: {},
              });
              await prisma.workflowBlob.upsert({
                where: { key: "x" },
                create: { key: "y", data: 3 },
                update: {},
              });
              return (await stamp()) === before;
            },
            true,
          ],
          [
            "upsert changing the key",
            async () => [
              (
                await prisma.workflowBlob.upsert({
                  where: { key: "x" },
                  create: { key: "x", data: 3 },
                  update: { key: "z" },
                })
              ).key,
              await blobs(),
            ],
            ["z", [Y, { key: "z", data: 1 }]],
          ],
          [
            "upsert writing null JSON",
            async () => [
              (
                await prisma.workflowBlob.upsert({
                  where: { key: "x" },
                  create: { key: "x", data: 3 },
                  update: { data: null },
                })
              ).data,
              await blobs(),
            ],
            [null, [{ key: "x", data: null }, Y]],
          ],
          [
            "upsert creating null JSON",
            async () => [
              (
                await prisma.workflowBlob.upsert({
                  where: { key: "n" },
                  create: { key: "n", data: null },
                  update: { data: 4 },
                })
              ).data,
              await blobs(),
            ],
            [null, [{ key: "n", data: null }, X, Y]],
          ],
          [
            "upsert with update: {} on a model without updatedAt",
            () =>
              prisma.workflowAnnotation.upsert({
                where: { id: "n1" },
                create: annotation("n1", "a", null),
                update: {},
                select: { key: true },
              }),
            { key: "n1" },
          ],
          [
            "upsert with update: {} and differing keys on a model without updatedAt",
            () =>
              prisma.workflowAnnotation.upsert({
                where: { id: "n1" },
                create: annotation("zz", "a", null),
                update: {},
                select: { key: true },
              }),
            { key: "n1" },
          ],
          [
            "upsert with a generated key",
            async () => {
              const { id: _id, ...create } = run("x");
              const created = await prisma.workflowRun.upsert({
                where: { id: "new" },
                create,
                update: { priority: 2 },
              });
              return [created.id === "new", await prisma.workflowRun.count()];
            },
            [false, 13],
          ],
          [
            "upsert of a compound key over a row",
            () =>
              prisma.workflowStage.upsert({
                where: {
                  workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
                },
                create: { workflowRunId: "a", stageId: "s", ...blobStage },
                update: { version: { increment: 1 } },
                select: { id: true, version: true },
              }),
            { id: "s1", version: 2 },
          ],
          [
            "upsert of a compound key differing from create",
            () =>
              prisma.workflowStage.upsert({
                where: {
                  workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
                },
                create: { workflowRunId: "a", stageId: "t", ...blobStage },
                update: { version: { increment: 1 } },
                select: { id: true, version: true },
              }),
            { id: "s1", version: 2 },
          ],
          [
            "upsert of a compound key differing from create, with no row",
            () =>
              prisma.workflowStage.upsert({
                where: {
                  workflowRunId_stageId: { workflowRunId: "a", stageId: "new" },
                },
                create: { workflowRunId: "a", stageId: "newer", ...blobStage },
                update: { version: { increment: 1 } },
                select: { stageId: true, version: true },
              }),
            { stageId: "newer", version: 1 },
          ],
          [
            "concurrent upserts with equal keys",
            async () => {
              await Promise.all(
                Array.from({ length: 16 }, (_, i) =>
                  prisma.workflowBlob.upsert({
                    where: { key: "race" },
                    create: { key: "race", data: i },
                    update: { data: 100 + i },
                  }),
                ),
              );
              return prisma.workflowBlob.count({ where: { key: "race" } });
            },
            1,
          ],
          [
            // An empty update takes the read-then-insert path, so a loser may
            // hit the unique key; that is why this is not `ON CONFLICT` on 8.
            "concurrent upserts with equal keys and update: {}",
            async () => {
              const settled = await Promise.allSettled(
                Array.from({ length: 16 }, (_, i) =>
                  prisma.workflowBlob.upsert({
                    where: { key: "race" },
                    create: { key: "race", data: i },
                    update: {},
                  }),
                ),
              );
              return [
                settled.every(
                  (s) =>
                    s.status === "fulfilled" || isUniqueViolation(s.reason),
                ),
                await prisma.workflowBlob.count({ where: { key: "race" } }),
              ];
            },
            [true, 1],
          ],
          [
            "concurrent upserts with differing keys, where one wins and the rest hit the unique key",
            async () => {
              const settled = await Promise.allSettled(
                Array.from({ length: 8 }, (_, i) =>
                  prisma.workflowBlob.upsert({
                    where: { key: "race-where" },
                    create: { key: "race-create", data: i },
                    update: {},
                  }),
                ),
              );
              return [
                settled.filter((s) => s.status === "fulfilled").length,
                settled.filter(
                  (s) => s.status === "rejected" && isUniqueViolation(s.reason),
                ).length,
              ];
            },
            [1, 7],
          ],
          [
            "create with null JSON",
            async () => {
              const created = await prisma.workflowRun.create({
                data: run("n", { metadata: null }),
              });
              return [
                created.metadata,
                await runs({ id: "n", metadata: { equals: null } }),
              ];
            },
            [null, "n"],
          ],
          [
            "create with null JSON on a required column",
            async () =>
              (
                await prisma.workflowRun.create({
                  data: run("n", { input: null }),
                })
              ).input,
            null,
          ],
          [
            "create with undefined JSON, which is DB NULL",
            async () => {
              await prisma.workflowRun.create({
                data: run("n", { metadata: undefined }),
              });
              return runs({ id: "n", metadata: { equals: null } });
            },
            "",
          ],
          [
            "createMany of no rows",
            () => prisma.workflowRun.createMany({ data: [] }),
            { count: 0 },
          ],
          [
            "createMany skipping a duplicate",
            () =>
              prisma.workflowRun.createMany({
                data: [run("a"), run("n")],
                skipDuplicates: true,
              }),
            { count: 1 },
          ],
          [
            "createMany of rows with different columns",
            () =>
              prisma.workflowRun.createMany({
                data: [run("n"), run("m", { metadata: { z: 1 } })],
              }),
            { count: 2 },
          ],
          [
            "createMany filling the bind limit",
            async () => [
              await prisma.workflowBlob.createMany({ data: blobRows(16_383) }),
              await prisma.workflowBlob.count(),
            ],
            [{ count: 16_383 }, 16_385],
          ],
          [
            "createMany one row over the bind limit",
            async () => [
              await prisma.workflowBlob.createMany({ data: blobRows(16_384) }),
              await prisma.workflowBlob.count(),
            ],
            [{ count: 16_384 }, 16_386],
          ],
          [
            "createMany of 40,000 rows",
            async () => [
              await prisma.workflowBlob.createMany({ data: blobRows(40_000) }),
              await prisma.workflowBlob.count(),
            ],
            [{ count: 40_000 }, 40_002],
          ],
          [
            "createMany skipping duplicates across the bind limit",
            async () => [
              await prisma.workflowBlob.createMany({
                data: [
                  { key: "x", data: 9 },
                  ...blobRows(20_000),
                  { key: "bulk-0", data: -1 },
                  { key: "y", data: 9 },
                ],
                skipDuplicates: true,
              }),
              await blobs().then((all) => all.length),
              (await prisma.workflowBlob.findUnique({ where: { key: "x" } }))
                .data,
              (
                await prisma.workflowBlob.findUnique({
                  where: { key: "bulk-0" },
                })
              ).data,
            ],
            [{ count: 20_000 }, 20_002, 1, 0],
          ],
        ];
        it.each(WRITES)("writes %s", async (_name, write, expected) => {
          expect(await write()).toEqual(expected);
        });

        const FAILS: Array<[string, () => Promise<unknown>, string]> = [
          [
            "update of a missing row",
            () =>
              prisma.workflowRun.update({
                where: { id: "zz" },
                data: { priority: 9 },
              }),
            "P2025",
          ],
          [
            "update with a stale fence",
            () =>
              prisma.workflowRun.update({
                where: { id: "a", version: 2 },
                data: { priority: 9 },
              }),
            "P2025",
          ],
          [
            "update beside OR: []",
            () =>
              prisma.workflowRun.update({
                where: { id: "a", OR: [] },
                data: { priority: 9 },
              }),
            "P2025",
          ],
          [
            "update with data: {} of a missing row",
            () => prisma.workflowRun.update({ where: { id: "zz" }, data: {} }),
            "P2025",
          ],
          [
            "update with data: {} of a missing row on a model without updatedAt",
            () =>
              prisma.workflowAnnotation.update({
                where: { id: "zz" },
                data: {},
              }),
            "P2025",
          ],
          [
            "update of a compound key with a stale fence",
            () =>
              prisma.workflowStage.update({
                where: {
                  workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
                  version: 2,
                },
                data: { duration: 1 },
              }),
            "P2025",
          ],
          [
            "delete of a missing row",
            () => prisma.workflowRun.delete({ where: { id: "zz" } }),
            "P2025",
          ],
          [
            "delete with a stale fence",
            () => prisma.workflowRun.delete({ where: { id: "a", version: 2 } }),
            "P2025",
          ],
        ];
        it.each(FAILS)("fails %s", async (_name, write, code) => {
          await expect(write()).rejects.toMatchObject({ code });
          expect(
            await prisma.workflowRun.count({ where: { priority: 9 } }),
          ).toBe(1);
          expect(await prisma.workflowRun.count()).toBe(12);
        });

        const UNIQUE_VIOLATIONS: Array<[string, () => Promise<unknown>]> = [
          [
            "create of a taken id",
            () => prisma.workflowRun.create({ data: run("a") }),
          ],
          [
            "createMany of a taken id",
            () => prisma.workflowRun.createMany({ data: [run("a")] }),
          ],
          [
            "upsert with no row and a taken create key",
            () =>
              prisma.workflowBlob.upsert({
                where: { key: "n" },
                create: { key: "y", data: 3 },
                update: { data: 4 },
              }),
          ],
          [
            "upsert changing to a taken key",
            () =>
              prisma.workflowBlob.upsert({
                where: { key: "x" },
                create: { key: "x", data: 3 },
                update: { key: "y" },
              }),
          ],
          [
            "createMany across the bind limit ending in a taken key",
            () =>
              prisma.workflowBlob.createMany({
                data: [...blobRows(20_000), { key: "x", data: 3 }],
              }),
          ],
        ];
        it.each(
          UNIQUE_VIOLATIONS,
        )("hits the unique key on %s", async (_name, write) => {
          const error = await write().catch((e: unknown) => e);
          expect(isUniqueViolation(error)).toBe(true);
          expect(await blobs()).toEqual([X, Y]);
        });

        // Rejected on every major, and nothing is written: [name, the call].
        const INVALID_WRITES: Array<[string, () => Promise<unknown>]> = [
          ["update with no args", () => prisma.workflowRun.update()],
          [
            "update with no where",
            () => prisma.workflowRun.update({ data: { priority: 99 } }),
          ],
          [
            "update with an empty where",
            () =>
              prisma.workflowRun.update({ where: {}, data: { priority: 99 } }),
          ],
          [
            "update of an undefined key",
            () =>
              prisma.workflowRun.update({
                where: { id: undefined },
                data: { priority: 99 },
              }),
          ],
          [
            "update of no key",
            () =>
              prisma.workflowRun.update({
                where: { workflowId: "wf" },
                data: { priority: 99 },
              }),
          ],
          [
            "update of a null key",
            () =>
              prisma.workflowRun.update({
                where: { id: null },
                data: { priority: 99 },
              }),
          ],
          [
            "update of a filter on the key",
            () =>
              prisma.workflowRun.update({
                where: { id: { equals: "a" } },
                data: { priority: 99 },
              }),
          ],
          [
            "update of OR alone",
            () =>
              prisma.workflowRun.update({
                where: { OR: [{ id: "a" }] },
                data: { priority: 99 },
              }),
          ],
          [
            "update of an incomplete compound key",
            () =>
              prisma.workflowStage.update({
                where: {
                  workflowRunId_stageId: {
                    workflowRunId: "a",
                    stageId: undefined,
                  },
                },
                data: { duration: 99 },
              }),
          ],
          [
            "update with no data",
            () => prisma.workflowRun.update({ where: { id: "a" } }),
          ],
          [
            "update with an empty select",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { priority: 99 },
                select: {},
              }),
          ],
          [
            "{ increment: undefined }",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { priority: { increment: undefined } },
              }),
          ],
          [
            "{ increment } and { decrement } at once",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { priority: { increment: 1, decrement: 1 } },
              }),
          ],
          [
            "{ increment } of a string",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { priority: { increment: "1" } },
              }),
          ],
          [
            "{ increment } on text",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { workflowName: { increment: 1 } },
              }),
          ],
          [
            "{ set: undefined }",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { priority: { set: undefined } },
              }),
          ],
          [
            "{ set: null } on a required column",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { priority: { set: null } },
              }),
          ],
          [
            "an empty update operator",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { priority: {} },
              }),
          ],
          [
            "null for a required column",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { workflowName: null },
              }),
          ],
          [
            "a string for an int",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { priority: "1" },
              }),
          ],
          [
            "a number for text",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { workflowName: 5 },
              }),
          ],
          [
            "a date-only string",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { startedAt: "2026-02-01" },
              }),
          ],
          [
            "an unknown enum value",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { status: "NOPE" },
              }),
          ],
          [
            "an unknown column",
            () =>
              prisma.workflowRun.update({
                where: { id: "a" },
                data: { nope: 1 },
              }),
          ],
          [
            "updateMany with no data",
            () => prisma.workflowRun.updateMany({ where: { id: "a" } }),
          ],
          ["delete with no args", () => prisma.workflowRun.delete()],
          [
            "delete with an empty where",
            () => prisma.workflowRun.delete({ where: {} }),
          ],
          [
            "delete of an undefined key",
            () => prisma.workflowRun.delete({ where: { id: undefined } }),
          ],
          [
            "delete of no key",
            () => prisma.workflowRun.delete({ where: { workflowId: "wf" } }),
          ],
          [
            "delete of a null key",
            () => prisma.workflowRun.delete({ where: { id: null } }),
          ],
          [
            "delete of OR alone",
            () => prisma.workflowRun.delete({ where: { OR: [{ id: "a" }] } }),
          ],
          [
            "delete of an incomplete compound key",
            () =>
              prisma.workflowStage.delete({
                where: {
                  workflowRunId_stageId: {
                    workflowRunId: "a",
                    stageId: undefined,
                  },
                },
              }),
          ],
          [
            "upsert with no where",
            () =>
              prisma.workflowBlob.upsert({ create: X, update: { data: 4 } }),
          ],
          [
            "upsert with an empty where",
            () =>
              prisma.workflowBlob.upsert({
                where: {},
                create: X,
                update: { data: 4 },
              }),
          ],
          [
            "upsert of an undefined key",
            () =>
              prisma.workflowBlob.upsert({
                where: { key: undefined },
                create: { key: "n", data: 3 },
                update: { data: 4 },
              }),
          ],
          [
            "upsert of a null key",
            () =>
              prisma.workflowBlob.upsert({
                where: { key: null },
                create: { key: "n", data: 3 },
                update: { data: 4 },
              }),
          ],
          [
            "upsert of a filter on the key",
            () =>
              prisma.workflowBlob.upsert({
                where: { key: { equals: "x" } },
                create: X,
                update: { data: 4 },
              }),
          ],
          [
            "upsert with no update",
            () =>
              prisma.workflowBlob.upsert({ where: { key: "x" }, create: X }),
          ],
          [
            "upsert with no create",
            () =>
              prisma.workflowBlob.upsert({
                where: { key: "x" },
                update: { data: 3 },
              }),
          ],
          [
            "upsert with a bad update over no row",
            () =>
              prisma.workflowBlob.upsert({
                where: { key: "n" },
                create: { key: "m", data: 3 },
                update: { nope: 1 },
              }),
          ],
          [
            "upsert with a bad create over a row",
            () =>
              prisma.workflowBlob.upsert({
                where: { key: "x" },
                create: { key: "y", nope: 1 },
                update: { data: 4 },
              }),
          ],
          [
            "upsert of an incomplete compound key",
            () =>
              prisma.workflowStage.upsert({
                where: {
                  workflowRunId_stageId: {
                    workflowRunId: "a",
                    stageId: undefined,
                  },
                },
                create: { workflowRunId: "a", stageId: "s", ...blobStage },
                update: { version: 9 },
              }),
          ],
          ["create with no data", () => prisma.workflowRun.create({})],
          [
            "create of a string for an int",
            () =>
              prisma.workflowRun.create({ data: run("n", { priority: "1" }) }),
          ],
          [
            "create of null for a required column",
            () =>
              prisma.workflowRun.create({
                data: run("n", { workflowName: null }),
              }),
          ],
          [
            "create of an unknown enum value",
            () =>
              prisma.workflowRun.create({ data: run("n", { status: "NOPE" }) }),
          ],
          [
            "create of an unknown column",
            () => prisma.workflowRun.create({ data: run("n", { nope: 1 }) }),
          ],
          ["createMany with no data", () => prisma.workflowRun.createMany({})],
          [
            "createMany of an undefined row",
            () => prisma.workflowRun.createMany({ data: [undefined] }),
          ],
          [
            "createMany of a string for an int",
            () =>
              prisma.workflowRun.createMany({
                data: [run("n", { priority: "1" })],
              }),
          ],
        ];
        it.each(INVALID_WRITES)("rejects %s", async (_name, write) => {
          const before = await prisma.workflowRun.findMany({
            orderBy: { id: "asc" },
          });
          await expect(write()).rejects.toThrow(REJECTED);
          expect(
            await prisma.workflowRun.findMany({ orderBy: { id: "asc" } }),
          ).toEqual(before);
          expect(await blobs()).toEqual([X, Y]);
        });

        // 6 and 7 accept these. 6 counts no rows for an empty updateMany and 7
        // counts the rows matched, so there is no one result to match; the
        // rest have no adapter caller, so the bridge rejects them.
        const UNSUPPORTED_WRITES_ON_8: Array<[string, () => Promise<unknown>]> =
          [
            [
              "updateMany with data: {}",
              () =>
                prisma.workflowRun.updateMany({ where: { id: "a" }, data: {} }),
            ],
            [
              "updateMany with only undefined data",
              () =>
                prisma.workflowRun.updateMany({
                  where: { id: "a" },
                  data: { priority: undefined },
                }),
            ],
            [
              "updateMany with limit",
              () =>
                prisma.workflowRun.updateMany({
                  data: { priority: 9 },
                  limit: 1,
                }),
            ],
            [
              "deleteMany with limit",
              () => prisma.workflowRun.deleteMany({ limit: 1 }),
            ],
            [
              "{ multiply }",
              () =>
                prisma.workflowRun.update({
                  where: { id: "a" },
                  data: { priority: { multiply: 2 } },
                }),
            ],
            [
              "an ISO string for a Date",
              () =>
                prisma.workflowRun.update({
                  where: { id: "a" },
                  data: { startedAt: "2026-02-01T12:00:00.500+02:00" },
                }),
            ],
            [
              "a nested relation write",
              () =>
                prisma.workflowRun.update({
                  where: { id: "a" },
                  data: { stages: { create: [] } },
                }),
            ],
            [
              "update with include",
              () =>
                prisma.workflowRun.update({
                  where: { id: "a" },
                  data: { priority: 2 },
                  include: { stages: true },
                }),
            ],
            [
              "update selecting a relation",
              () =>
                prisma.workflowRun.update({
                  where: { id: "a" },
                  data: { priority: 2 },
                  select: { stages: { select: { id: true } } },
                }),
            ],
            [
              "upsert with a filter beside the key",
              () =>
                prisma.workflowBlob.upsert({
                  where: { key: "x", data: { path: ["a"], equals: 1 } },
                  create: X,
                  update: { data: 4 },
                }),
            ],
            [
              "upsert of two keys",
              () =>
                prisma.workflowStage.upsert({
                  where: {
                    id: "s1",
                    workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
                  },
                  create: {
                    id: "s1",
                    workflowRunId: "a",
                    stageId: "s",
                    ...blobStage,
                  },
                  update: { version: 9 },
                }),
            ],
            [
              "create with select",
              () =>
                prisma.workflowRun.create({
                  data: run("n"),
                  select: { id: true },
                }),
            ],
            [
              "createMany of one object",
              () => prisma.workflowRun.createMany({ data: run("n") }),
            ],
          ];
        it.runIf(isPrisma8).each(UNSUPPORTED_WRITES_ON_8)(
          "does not take %s on Prisma 8",
          async (_name, write) => {
            await expect(write()).rejects.toThrow(REJECTED);
          },
        );
      });

      describe("transactions", () => {
        beforeEach(seed);

        const sleep = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        const store = createPrismaBlobStore(prisma);
        const value = async () =>
          (await prisma.workflowBlob.findUnique({ where: { key: "x" } })).data;

        // [name, the callback, its timeout]: each writes x = 5 through the real
        // blob store, then runs out of time in its own way.
        const TIMEOUTS: Array<
          [string, (tx: any) => Promise<unknown>, number | undefined]
        > = [
          ["waiting in the callback", () => sleep(200), 50],
          [
            "a slow statement",
            (tx) => tx.$executeRawUnsafe(`SELECT pg_sleep(0.2)`),
            50,
          ],
          [
            "a caught timeout",
            async (tx) => {
              await sleep(200);
              await tx.workflowBlob.count().catch(() => {});
            },
            50,
          ],
          ["the default timeout", () => sleep(5300), undefined],
        ];
        it.each(TIMEOUTS)(
          "rolls back after %s",
          async (_name, work, timeout) => {
            await expect(
              prisma.$transaction(
                async (tx: any) => {
                  await createPrismaBlobStore(tx).put("x", 5);
                  await work(tx);
                },
                { timeout },
              ),
            ).rejects.toMatchObject({ code: "P2028" });
            expect(await store.get("x")).toBe(1);
          },
          10_000,
        );

        it("lets a callback's own error through inside the timeout", async () => {
          await expect(
            prisma.$transaction(
              async (tx: any) => {
                await tx.workflowBlob.update({
                  where: { key: "x" },
                  data: { data: 5 },
                });
                await sleep(5);
                throw new Error("mine");
              },
              { timeout: 2000 },
            ),
          ).rejects.toThrow("mine");
          expect(await value()).toBe(1);
        });

        // 6 and 7 keep the caller waiting for the callback, so a late error is
        // the callback's own; 8 rejects at the deadline, which is what frees
        // the connection of a callback that never settles.
        it("rolls back a callback that fails after the timeout", async () => {
          await expect(
            prisma.$transaction(
              async (tx: any) => {
                await tx.workflowBlob.update({
                  where: { key: "x" },
                  data: { data: 5 },
                });
                await sleep(100);
                throw new Error("mine");
              },
              { timeout: 20 },
            ),
          ).rejects.toThrow(isPrisma8 ? "Transaction already closed" : "mine");
          expect(await value()).toBe(1);
        });

        it("frees the connection of a callback that never settles", async () => {
          const own = createPostgresClient(DATABASE_URL);
          try {
            // More than the default pool of 10 holds.
            for (let i = 0; i < 12; i++) {
              void own
                .$transaction(
                  async (tx: any) => {
                    await tx.workflowBlob.count();
                    await new Promise(() => {});
                  },
                  { timeout: 100 },
                )
                .catch(() => {});
            }
            await sleep(500);
            expect(
              await Promise.race([
                own.workflowBlob.count(),
                sleep(2000).then(() => "hung"),
              ]),
            ).toBe(2);
          } finally {
            await own.$disconnect();
          }
        }, 10_000);

        it("fails every statement after the timeout, and leaves nothing unhandled", async () => {
          const unhandled: unknown[] = [];
          const onUnhandled = (reason: unknown) => unhandled.push(reason);
          process.on("unhandledRejection", onUnhandled);
          try {
            const codes: unknown[] = [];
            await prisma
              .$transaction(
                async (tx: any) => {
                  await sleep(100);
                  for (let i = 0; i < 3; i++) {
                    await tx.workflowBlob
                      .update({ where: { key: "x" }, data: { data: 5 } })
                      .catch((e: any) => codes.push(e.code));
                    await tx
                      .$executeRawUnsafe(`SELECT 1`)
                      .catch((e: any) => codes.push(e.code));
                  }
                  throw new Error("late");
                },
                { timeout: 20 },
              )
              .catch(() => {});
            await sleep(300);
            expect(codes).toEqual(Array(6).fill("P2028"));
            expect(unhandled).toEqual([]);
            expect(await value()).toBe(1);
          } finally {
            process.off("unhandledRejection", onUnhandled);
          }
        });

        it("leaves no timer behind", async () => {
          const timers = () =>
            process.getActiveResourcesInfo().filter((r) => r === "Timeout")
              .length;
          await prisma.$transaction((tx: any) => tx.workflowBlob.count());
          const before = timers();
          for (let i = 0; i < 200; i++) {
            await prisma.$transaction((tx: any) => tx.workflowBlob.count());
          }
          expect(timers()).toBeLessThanOrEqual(before);
        });

        it("commits inside the timeout", async () => {
          await prisma.$transaction(
            async (tx: any) => {
              await tx.workflowBlob.update({
                where: { key: "x" },
                data: { data: 5 },
              });
              await sleep(5);
            },
            { timeout: 2000 },
          );
          expect(await value()).toBe(5);
          await prisma.$transaction((tx: any) =>
            tx.workflowBlob.update({ where: { key: "x" }, data: { data: 6 } }),
          );
          expect(await value()).toBe(6);
        });

        it("runs a createMany across the bind limit inside the caller's transaction", async () => {
          await expect(
            prisma.$transaction(async (tx: any) => {
              await tx.workflowBlob.createMany({ data: blobRows(20_000) });
              throw new Error("mine");
            }),
          ).rejects.toThrow("mine");
          expect(await prisma.workflowBlob.count()).toBe(2);
          expect(
            await prisma.$transaction([
              prisma.workflowBlob.createMany({ data: blobRows(20_000) }),
              prisma.workflowBlob.count(),
            ]),
          ).toEqual([{ count: 20_000 }, 20_002]);
        });

        it("keeps the array form free of the default timeout", async () => {
          expect(await prisma.$transaction([])).toEqual([]);
          const [, count] = await prisma.$transaction([
            prisma.workflowBlob.update({
              where: { key: "x" },
              data: { data: 7 },
            }),
            prisma.workflowBlob.count(),
          ]);
          expect(count).toBe(2);
          expect(await value()).toBe(7);
        });
      });

      describe("through the real adapters", () => {
        beforeEach(seed);

        it("upsertStage updates the stage it selects, not the one in create", async () => {
          const persistence = createPrismaWorkflowPersistence(prisma);
          const created = await persistence.createRun({
            workflowId: "wf",
            workflowName: "wf",
            workflowType: "t",
            input: {},
          });
          const base = {
            workflowRunId: created.id,
            stageName: "stage",
            stageNumber: 1,
            executionGroup: 1,
          };
          await persistence.createStage({ ...base, stageId: "target" });
          await persistence.createStage({ ...base, stageId: "other" });
          const returned = await persistence.upsertStage({
            workflowRunId: created.id,
            stageId: "target",
            create: { ...base, stageId: "other" },
            update: { errorMessage: "changed" },
          });
          expect(returned.stageId).toBe("target");
          expect(
            await prisma.workflowStage.findMany({
              where: { workflowRunId: created.id },
              select: { stageId: true, errorMessage: true, version: true },
              orderBy: { stageId: "asc" },
            }),
          ).toEqual([
            { stageId: "other", errorMessage: null, version: 1 },
            { stageId: "target", errorMessage: "changed", version: 2 },
          ]);
        });

        it("updateStage stores the fractional delay a retry backoff produces", async () => {
          const persistence = createPrismaWorkflowPersistence(prisma);
          const run = await persistence.createRun({
            workflowId: "wf",
            workflowName: "wf",
            workflowType: "t",
            input: {},
          });
          const stage = await persistence.createStage({
            workflowRunId: run.id,
            stageId: "s",
            stageName: "stage",
            stageNumber: 1,
            executionGroup: 1,
          });
          await persistence.updateStage(stage.id, { pollInterval: 562.5 });
          const { pollInterval } = await prisma.workflowStage.findUnique({
            where: { id: stage.id },
            select: { pollInterval: true },
          });
          expect(pollInterval).toBe(562);
        });

        it("the AI call logger's stats treat a prefix as a LIKE pattern", async () => {
          await prisma.$executeRawUnsafe(`TRUNCATE "ai_calls"`);
          const logger = createPrismaAICallLogger(prisma);
          const call = {
            callType: "c",
            modelKey: "m",
            modelId: "m",
            prompt: "p",
            response: "r",
          };
          await logger.logBatchResults("costs", [
            {
              ...call,
              topic: "cost_",
              inputTokens: 2,
              outputTokens: 3,
              cost: 0.125,
              requestId: "1",
            },
            {
              ...call,
              topic: "costX",
              inputTokens: 4,
              outputTokens: 5,
              cost: 0.25,
              requestId: "2",
            },
          ]);
          const stats = await logger.getStats("cost_");
          expect(stats.totalCalls).toBe(2);
          expect(stats.totalCost).toBe(0.375);
        });

        it("the AI call logger records a batch above the bind limit", async () => {
          await prisma.$executeRawUnsafe(`TRUNCATE "ai_calls"`);
          await createPrismaAICallLogger(prisma).logBatchResults(
            "big",
            Array.from({ length: 4_700 }, (_, i) => ({
              callType: "c",
              modelKey: "m",
              modelId: "m",
              prompt: "p",
              response: "r",
              topic: "t",
              inputTokens: 1,
              outputTokens: 1,
              cost: 0,
              requestId: `r${i}`,
            })),
          );
          expect(await prisma.aICall.count()).toBe(4_700);
        });

        it("the blob store lists a prefix as a LIKE pattern", async () => {
          const store = createPrismaBlobStore(prisma);
          await store.put("prefix_1", {});
          await store.put("prefixX2", {});
          expect(await store.list("prefix_")).toEqual(
            expect.arrayContaining(["prefix_1", "prefixX2"]),
          );
        });
      });
    });

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

    // ==========================================================================
    // Error classification (PG-only): the same Postgres failure reaches us as
    // a different error shape on each Prisma major (`meta.code` on 6,
    // `meta.driverAdapterError.cause.originalCode` on 7), so every check goes
    // through `sqlStateOf`. These drive real driver errors, not fixtures.
    // ==========================================================================

    describe("SQLSTATE classification of driver errors", () => {
      const caught = (run: () => Promise<unknown>) =>
        run().then(
          () => {
            throw new Error("expected the statement to fail");
          },
          (error: unknown) => error,
        );

      it("reads a unique violation from raw SQL", async () => {
        const workflowId = `sqlstate-raw-${crypto.randomUUID()}`;
        const insert = () =>
          prisma.$executeRaw`
            INSERT INTO "workflow_definitions"
              ("workflowId", version, snapshot, "structureHash")
            VALUES (${workflowId}, 'v1', '{}'::jsonb, 'h')
          `;
        try {
          await insert();
          const error = await caught(insert);
          expect(sqlStateOf(error)).toBe("23505");
          expect(isUniqueViolation(error)).toBe(true);
          expect(isSerializationFailure(error)).toBe(false);
        } finally {
          await prisma.workflowDefinition.deleteMany({ where: { workflowId } });
        }
      });

      it("reads a unique violation from the model API", async () => {
        const workflowId = `sqlstate-model-${crypto.randomUUID()}`;
        const data = {
          workflowId,
          version: "v1",
          snapshot: {},
          structureHash: "h",
        };
        try {
          await prisma.workflowDefinition.create({ data });
          const error = await caught(() =>
            prisma.workflowDefinition.create({ data }),
          );
          expect(sqlStateOf(error)).toBe("23505");
          expect(isUniqueViolation(error)).toBe(true);
        } finally {
          await prisma.workflowDefinition.deleteMany({ where: { workflowId } });
        }
      });

      it("reads a cancelled statement from raw SQL", async () => {
        const error = await caught(() =>
          prisma.$transaction(async (tx: typeof prisma) => {
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 20");
            await rawFor(tx, {}).$queryRawUnsafe("SELECT pg_sleep(2)");
          }),
        );
        expect(sqlStateOf(error)).toBe("57014");
        expect(isUniqueViolation(error)).toBe(false);
      });
    });

    describe("session timezone independence", () => {
      // UTC+14, no DST: a session-timezone slip shows up as a 14-hour jump,
      // and the case still proves its point on a database whose own default
      // timezone is already something other than UTC.
      const tzUrl = new URL(DATABASE_URL);
      tzUrl.searchParams.set("options", "-c timezone=Pacific/Kiritimati");
      tzUrl.searchParams.set("connection_limit", "1");
      const tzPrisma = createPostgresClient(tzUrl.toString());

      beforeEach(async () => {
        await truncateAll();
      });

      afterAll(async () => {
        await tzPrisma.$disconnect();
      });

      it("runs its statements on a session that is not on UTC", async () => {
        const rows = (await rawFor(tzPrisma, {
          tz: "text",
        }).$queryRawUnsafe(
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

      it("claims a pending run through the tagged-template fallback on a non-UTC session", async () => {
        // A client without $queryRawUnsafe takes the template path, which
        // binds the clock on its own.
        const templateOnly = new Proxy(tzPrisma, {
          get: (target, property) =>
            property === "$queryRawUnsafe"
              ? undefined
              : Reflect.get(target, property),
        });
        const persistence = createPrismaWorkflowPersistence(templateOnly);
        const run = await persistence.createRun({
          workflowId: "tz-template-workflow",
          workflowName: "TZ Template",
          workflowType: "tz",
          input: { value: "x" },
        });

        const claimed = await persistence.claimNextPendingRun();
        expect(claimed?.id).toBe(run.id);
        const lag =
          (claimed?.startedAt?.getTime() ?? 0) - run.createdAt.getTime();
        expect(lag).toBeGreaterThanOrEqual(0);
        expect(lag).toBeLessThan(60_000);
      });

      it("stamps publishedAt in UTC when the outbox sweep claims events on a non-UTC session", async () => {
        const persistence = createPrismaWorkflowPersistence(tzPrisma);
        await persistence.appendOutboxEvents([
          {
            workflowRunId: "tz-outbox-run",
            eventType: "run.started",
            payload: {},
            causationId: "tz-outbox",
            occurredAt: new Date(),
          },
        ]);

        const before = Date.now();
        const [claimed] = await persistence.claimUnpublishedOutboxEvents();
        expect(claimed?.workflowRunId).toBe("tz-outbox-run");
        expect(
          Math.abs((claimed?.publishedAt?.getTime() ?? 0) - before),
        ).toBeLessThan(60_000);
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
        const jobs = await prisma.jobQueue.findMany({
          select: { lastError: true },
        });
        const discarded = jobs.filter((job: { lastError: string | null }) =>
          job.lastError?.includes("ghost job discarded"),
        );
        expect(discarded).toHaveLength(0);
      }, 40_000);
    });
  });
}

// The fixture generates a separate, minimal SQLite client without changing the
// shipped schema or replacing the Postgres client used by the suites above.
// Prisma 8 is Postgres-only, so there is no SQLite client to test there.
describe.skipIf(isPrisma8)("definition registration on real SQLite", () => {
  const require = createRequire(import.meta.url);
  let directory: string;
  let prisma: any;
  beforeAll(async () => {
    directory = await mkdtemp(
      join(tmpdir(), "definition-registration-sqlite-"),
    );
    const {
      createSqliteClient,
    } = require("../../../../prisma-fixtures/index.cjs");
    prisma = createSqliteClient(join(directory, "test.db"));
  }, 30_000);
  afterAll(async () => {
    await prisma?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("returns the immutable winner, including different-hash registrations in an outer transaction", async () => {
    const input = {
      workflowId: "sqlite-definition",
      version: "v1",
      snapshot: { format: 1, stages: [] },
      structureHash: "first-hash",
    };
    await prisma.$transaction(async (tx: any) => {
      const adapter = createPrismaWorkflowPersistence(tx, {
        databaseType: "sqlite",
        definitionVersioning: true,
      });
      const first = await adapter.insertDefinitionIfAbsent(input);
      expect(first).toMatchObject(input);
      expect(first?.createdAt).toBeInstanceOf(Date);
      expect(await adapter.insertDefinitionIfAbsent(input)).toEqual(first);
      expect(
        await adapter.insertDefinitionIfAbsent({
          ...input,
          structureHash: "different",
          snapshot: { stages: ["drift"] },
        }),
      ).toEqual(first);
      expect(
        await adapter.getDefinition(input.workflowId, input.version),
      ).toEqual(first);
    });
    expect(await prisma.workflowDefinition.count()).toBe(1);
  });

  it("stores a raw-inserted createdAt the way the model API stores one", async () => {
    // The raw insert binds a Date, where the Postgres statements bind an ISO
    // string: SQLite keeps an integer on 6 and ISO text on 7, and the raw
    // statement must land on whichever one the model API writes.
    await prisma.workflowDefinition.create({
      data: {
        workflowId: "sqlite-model",
        version: "v1",
        snapshot: {},
        structureHash: "h",
      },
    });
    await createPrismaWorkflowPersistence(prisma, {
      databaseType: "sqlite",
      definitionVersioning: true,
    }).insertDefinitionIfAbsent({
      workflowId: "sqlite-raw",
      version: "v1",
      snapshot: {},
      structureHash: "h",
    });
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT "workflowId" AS id, typeof("createdAt") AS type FROM "workflow_definitions" WHERE "workflowId" IN ('sqlite-model', 'sqlite-raw')`,
    )) as Array<{ id: string; type: string }>;
    const types = Object.fromEntries(rows.map((row) => [row.id, row.type]));
    expect(types["sqlite-raw"]).toBe(types["sqlite-model"]);
  });
});
