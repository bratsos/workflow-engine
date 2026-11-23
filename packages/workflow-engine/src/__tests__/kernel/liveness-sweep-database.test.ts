/**
 * Prisma-backed crash-window subset. These drives use adapter transactions and
 * the same scenarios as the exhaustive in-memory sweep; only writes belonging
 * to release-changed handler paths are faulted here.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CollectingEventSink } from "../../kernel/testing/index.js";
import {
  type KernelDatabase,
  kernelDatabase,
  realDatabase,
  sqlite,
} from "../sqlite8-kernel-utils.js";
import { yieldToHost } from "../utils/yield-to-host.js";
import {
  drive,
  lateDeliveryAfterRedriveErrors,
  type Mode,
  SCENARIOS,
  type SweepAdapter,
  type SweepHarness,
  type SweepResult,
} from "./liveness-sweep-shared.js";

const DATABASE_SWEEP_TIMEOUT_MS = 240_000;
const RELEASE_HANDLER_COMMANDS = [
  "job.execute",
  "stage.pollSuspended",
  "run.cancel",
  "run.redrive",
] as const;
const RELEASE_WRITE_LABELS = [
  "persistence.commit",
  "persistence.createStage",
  "persistence.deleteStage",
  "persistence.upsertStage",
  "persistence.updateRun",
  "persistence.updateStage",
  "persistence.createLog",
  "persistence.appendOutboxEvents",
  "persistence.acquireIdempotencyKey",
  "persistence.completeIdempotencyKey",
  "persistence.releaseIdempotencyKey",
  "persistence.appendAnnotations",
  "persistence.saveStageOutput",
  "persistence.insertDefinitionIfAbsent",
  "jobs.enqueueParallel",
  "jobs.deleteByRunAndStages",
  "jobs.complete",
  "jobs.fail",
  "jobs.suspend",
  "jobs.defer",
  "jobs.cancelByRun",
  "ledger.claim",
  "ledger.update",
  "ledger.compareAndSet",
  "ledger.clear",
  "ledger.clearExcept",
  "blobs.put",
  "blobs.delete",
  "aiLogger.logBatchResults",
  "events.emit",
  "batch.start",
  "batch.cancel",
] as const;

async function invariantErrors(result: SweepResult): Promise<string[]> {
  if (!result.runId) return ["run was never created"];
  const errors =
    (await result.scenario.validate?.(result.harness, result.runId, {
      faulted: result.faults.firedAt !== undefined,
      ...(result.faults.firedAt ? { faultAt: result.faults.firedAt } : {}),
    })) ?? [];
  if (result.harness.duplicateOutboxEventIds?.length) {
    errors.push(
      `outbox events were emitted more than once: ${result.harness.duplicateOutboxEventIds.join(", ")}`,
    );
  }
  return errors;
}

function sameOutcome(left: SweepResult, right: SweepResult): boolean {
  return (
    left.status === right.status &&
    JSON.stringify(left.output) === JSON.stringify(right.output)
  );
}

describe.skipIf(!realDatabase)(
  `liveness sweep against Prisma ${sqlite ? "SQLite" : "Postgres"}`,
  () => {
    let db: KernelDatabase;
    let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
    let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
    const adapter: SweepAdapter = {
      databaseTransactions: true,
      async prepare() {
        await db.reset();
        // One macrotask per drive: a sweep is a single test of 40 s and more.
        await yieldToHost();
      },
      async advanceTime(clock) {
        // The Prisma queue stamps a retry deadline from the host clock and
        // compares it with the database's clock when it dequeues. Make the
        // deadlines that have elapsed on the sweep's virtual clock due on any
        // database clock: restamping them with the host's current time left
        // them in the future whenever the database clock ran behind the host
        // by more than the real time of fifteen ticks, and the reaper then
        // failed the run (STUCK_RUN_REAPED, its job still PENDING).
        await db.client.jobQueue.updateMany({
          where: {
            status: "PENDING",
            nextPollAt: { lte: clock.now() },
          },
          data: { nextPollAt: new Date(0) },
        });
      },
      create(scenario, clock) {
        const eventSink = new CollectingEventSink();
        const kernel = db.makeKernel({
          registry: {
            getWorkflow: (id) =>
              id === scenario.workflow.id ? scenario.workflow : undefined,
            listWorkflows: () => [scenario.workflow],
          },
          clock,
          eventSink,
          services: {
            aiLogger: db.aiLogger,
            ...scenario.services,
          },
        });
        return {
          ...db,
          kernel,
          eventSink,
          clock,
          jobQueue: db.jobTransport,
          async readLogs() {
            const rows = await db.client.workflowLog.findMany({
              select: { level: true, message: true },
            });
            return rows;
          },
        } as unknown as SweepHarness;
      },
    };

    beforeAll(async () => {
      db = await kernelDatabase();
      // The Prisma 8 SQLite shim defaults interactive transactions to 5s.
      // A single exhaustive crash sweep can exceed that on a busy host even
      // though the transaction is making progress; give this test adapter
      // bounded headroom for a long callback.
      if (sqlite && process.env.PRISMA_MAJOR === "8") {
        const transaction = db.client.$transaction.bind(db.client);
        db.client.$transaction = (callback: unknown, options: object = {}) =>
          transaction(callback, { ...options, timeout: 30_000 });
      }
    }, 120_000);
    afterAll(async () => {
      await db?.close();
      errorSpy?.mockRestore();
      warnSpy?.mockRestore();
    });
    beforeAll(() => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const { build, databaseKnownDefect, backendKnownDefects } = scenario;
      const test = (kind: "clean" | Mode) =>
        databaseKnownDefect?.[kind] ||
        backendKnownDefects?.[sqlite ? "sqlite" : "postgres"]?.[kind]
          ? it.fails
          : it;

      describe(name, () => {
        test("clean")(
          "reaches its fault-free terminal outcome",
          async () => {
            const clean = await drive(
              build,
              -1,
              "error",
              adapter,
              RELEASE_WRITE_LABELS,
              RELEASE_HANDLER_COMMANDS,
            );
            expect(
              ["COMPLETED", "FAILED", "CANCELLED"],
              await clean.describe(),
            ).toContain(clean.status);
            expect(clean.faults.points).toBeGreaterThan(0);
            expect(await invariantErrors(clean)).toEqual([]);
          },
          DATABASE_SWEEP_TIMEOUT_MS,
        );

        for (const mode of ["error", "crash"] as const) {
          test(mode)(
            `recovers from each release-handler write fault (${mode})`,
            async () => {
              const clean = await drive(
                build,
                -1,
                "error",
                adapter,
                RELEASE_WRITE_LABELS,
                RELEASE_HANDLER_COMMANDS,
              );
              const failures: string[] = [];
              for (let point = 1; point <= clean.faults.points; point++) {
                const result = await drive(
                  build,
                  point,
                  mode,
                  adapter,
                  RELEASE_WRITE_LABELS,
                  RELEASE_HANDLER_COMMANDS,
                );
                if (!result.faults.firedAt) continue;
                const invariants = await invariantErrors(result);
                const accepted =
                  (await result.scenario.acceptsFaultOutcome?.(
                    result,
                    mode,
                    clean,
                  )) ?? false;
                if (
                  (!sameOutcome(result, clean) && !accepted) ||
                  invariants.length > 0
                ) {
                  failures.push(
                    `#${point} ${result.faults.firedAt} -> ${await result.describe()}${invariants.length ? `; invariant failures: ${invariants.join(", ")}` : ""}`,
                  );
                }
              }
              expect(failures, failures.join("\n")).toEqual([]);
            },
            DATABASE_SWEEP_TIMEOUT_MS,
          );
        }

        for (const fault of scenario.databaseKnownFaults ?? []) {
          it.fails(
            `known defect: ${fault.command} ${fault.label} (${fault.mode})`,
            async () => {
              const clean = await drive(build, -1, "error", adapter);
              const result = await drive(
                build,
                1,
                fault.mode,
                adapter,
                [fault.label],
                [fault.command],
              );
              expect(result.faults.firedAt).toBe(fault.label);
              expect(result.faults.firedCommand).toBe(fault.command);
              expect(sameOutcome(result, clean), fault.reason).toBe(true);
              expect(await invariantErrors(result)).toEqual([]);
            },
            DATABASE_SWEEP_TIMEOUT_MS,
          );
        }
      });
    }

    it(
      "runs the stage once when a cancelled job is delivered after the redrive",
      async () => {
        expect(await lateDeliveryAfterRedriveErrors(adapter)).toEqual([]);
      },
      DATABASE_SWEEP_TIMEOUT_MS,
    );
  },
);
