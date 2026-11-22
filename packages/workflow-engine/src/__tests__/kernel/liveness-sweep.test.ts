/**
 * In-memory crash-window sweep. The shared runner snapshots the in-memory
 * persistence around each transaction and cuts off one write per replay.
 * Database-backed transaction and adapter coverage lives beside this file.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAsyncBatchStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  executeJobWithHeartbeat,
  HOST_DEFAULTS,
} from "../../kernel/helpers/host-support.js";
import { FakeClock } from "../../kernel/testing/index.js";
import { createTestHarness } from "../../testing/index.js";
import {
  describeRun,
  drive,
  injectFaults,
  lateDeliveryAfterRedriveErrors,
  type Mode,
  SCENARIOS,
  STALE_MS,
  STUCK_MS,
  type SweepHarness,
  type SweepResult,
  type SweepScenario,
  trackOutboxDeliveries,
} from "./liveness-sweep-shared.js";

const SWEEP_TIMEOUT_MS = 180_000;

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

describe("liveness sweep", () => {
  beforeAll(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(() => vi.restoreAllMocks());

  for (const [name, { build, knownDefect }] of Object.entries(SCENARIOS)) {
    const test = (kind: "clean" | Mode) =>
      knownDefect?.[kind] ? it.fails : it;

    describe(name, () => {
      test("clean")(
        "reaches its fault-free terminal outcome",
        async () => {
          const clean = await drive(build, -1, "error");
          expect(
            ["COMPLETED", "FAILED", "CANCELLED"],
            await clean.describe(),
          ).toContain(clean.status);
          expect(clean.faults.points).toBeGreaterThan(0);
          expect(await invariantErrors(clean)).toEqual([]);
        },
        SWEEP_TIMEOUT_MS,
      );

      for (const mode of ["error", "crash"] as const) {
        test(mode)(
          `reaches the same outcome when any one write fails (${mode})`,
          async () => {
            const clean = await drive(build, -1, "error");
            const failures: string[] = [];
            for (let point = 1; point <= clean.faults.points; point++) {
              const result = await drive(build, point, mode);
              if (!result.faults.firedAt) continue;
              const invariants = await invariantErrors(result);
              const same = sameOutcome(result, clean);
              const accepted =
                (await result.scenario.acceptsFaultOutcome?.(
                  result,
                  mode,
                  clean,
                )) ?? false;
              if ((!same && !accepted) || invariants.length > 0) {
                failures.push(
                  `#${point} ${result.faults.firedAt} -> outcome ${result.status}: ${await result.describe()}${invariants.length ? `; invariant failures: ${invariants.join(", ")}` : ""}`,
                );
              }
            }
            expect(
              failures.length,
              `${failures.length} fault points failed:\n${failures.slice(0, 20).join("\n")}`,
            ).toBe(0);
          },
          SWEEP_TIMEOUT_MS,
        );
      }
    });
  }
});

describe("focused provider batch recovery", () => {
  it(
    "adopts the batch created before a submit crash instead of creating another",
    async () => {
      const result = await drive(
        SCENARIOS["an AI batch map with adoption"]!.build,
        1,
        "crash",
        undefined,
        ["batch.start"],
      );
      expect(result.faults.firedAt).toBe("batch.start");
      expect(result.status).toBe("COMPLETED");
      expect(await invariantErrors(result)).toEqual([]);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    "returns the documented refusal when submit replay cannot adopt",
    async () => {
      const result = await drive(
        SCENARIOS["an AI batch map without adoption"]!.build,
        1,
        "crash",
        undefined,
        ["batch.start"],
      );
      expect(result.faults.firedAt).toBe("batch.start");
      expect(result.status).toBe("FAILED");
      expect(await invariantErrors(result)).toEqual([]);
    },
    SWEEP_TIMEOUT_MS,
  );
});

type WorkerId = "worker-A" | "worker-B";
type TickCommand =
  | "claim"
  | "dequeue+execute"
  | "stage.pollSuspended"
  | "run.transition"
  | "lease.reapStale"
  | "outbox.flush"
  | "run.reapStuck";
interface InterleavedCommand {
  worker: WorkerId;
  command: TickCommand;
}

function enumerateInterleavings(
  first: readonly TickCommand[],
  second: readonly TickCommand[],
): InterleavedCommand[][] {
  const schedules: InterleavedCommand[][] = [];
  const visit = (
    left: number,
    right: number,
    current: InterleavedCommand[],
  ) => {
    if (left === first.length && right === second.length) {
      schedules.push(current);
      return;
    }
    if (left < first.length) {
      visit(left + 1, right, [
        ...current,
        { worker: "worker-A", command: first[left]! },
      ]);
    }
    if (right < second.length) {
      visit(left, right + 1, [
        ...current,
        { worker: "worker-B", command: second[right]! },
      ]);
    }
  };
  visit(0, 0, []);
  return schedules;
}

const ONE_TICK_COMMANDS: readonly TickCommand[] = [
  "claim",
  "dequeue+execute",
  "stage.pollSuspended",
  "run.transition",
  "lease.reapStale",
  "outbox.flush",
  "run.reapStuck",
];
const ALL_TICK_INTERLEAVINGS = enumerateInterleavings(
  ONE_TICK_COMMANDS,
  ONE_TICK_COMMANDS,
);

function boundedInterleavings(count: number): InterleavedCommand[][] {
  return Array.from({ length: count }, (_, index) => {
    const position = Math.round(
      (index * (ALL_TICK_INTERLEAVINGS.length - 1)) / (count - 1),
    );
    return ALL_TICK_INTERLEAVINGS[position]!;
  });
}

async function runTwoWorkerSchedule(
  build: () => SweepScenario,
  schedule: readonly InterleavedCommand[],
  mode: Mode,
): Promise<SweepResult> {
  const scenario = build();
  const clock = new FakeClock(new Date());
  const h = createTestHarness({
    workflows: [scenario.workflow],
    clock,
    services: scenario.services,
  }) as SweepHarness;
  trackOutboxDeliveries(h);
  Object.assign(h.persistence, { now: () => clock.now() });
  Object.assign(h.jobQueue, { now: () => clock.now() });
  let currentWorker = "outside";
  let currentCommand = "outside";
  const asWorker = async <T>(
    worker: string,
    command: string,
    action: () => Promise<T>,
  ) => {
    const oldWorker = currentWorker;
    const oldCommand = currentCommand;
    currentWorker = worker;
    currentCommand = command;
    try {
      return await action();
    } finally {
      currentWorker = oldWorker;
      currentCommand = oldCommand;
    }
  };
  const faults = injectFaults(h, 1, mode, {
    currentWorker: () => currentWorker,
    faultWorkerId: "worker-A",
  });
  h.withWorkerContext = asWorker;
  h.readLogs ??= async () =>
    (
      h.persistence as unknown as {
        getAllLogs(): Promise<Array<{ level?: string; message?: string }>>;
      }
    ).getAllLogs();

  let runId: string | undefined;
  let workedThisRound = false;
  const resumedByWorker = new Map<WorkerId, string[]>();
  try {
    runId = (
      await h.kernel.dispatch({
        type: "run.create",
        idempotencyKey: "two-worker-sweep",
        workflowId: scenario.workflow.id,
        input: scenario.input,
      })
    ).workflowRunId;
    scenario.onRunCreated?.(h, runId);
  } catch (error) {
    if (!faults.dirty) throw error;
  }

  const action = async (worker: WorkerId, command: TickCommand) =>
    asWorker(worker, command, async () => {
      if (command === "claim") {
        const result = await h.kernel.dispatch({
          type: "run.claimPending",
          workerId: worker,
          maxClaims: 50,
        });
        workedThisRound ||= result.claimed.length > 0;
        return;
      }
      if (command === "dequeue+execute") {
        const queue = h.jobQueue as unknown as { workerId?: string };
        for (;;) {
          const previousWorker = queue.workerId;
          queue.workerId = worker;
          let job;
          try {
            job = await h.jobQueue.dequeue();
          } finally {
            queue.workerId = previousWorker;
          }
          if (!job) break;
          workedThisRound = true;
          await executeJobWithHeartbeat(h.kernel, {
            jobTransport: h.jobQueue,
            job: {
              jobId: job.jobId,
              workflowRunId: job.workflowRunId,
              workflowId: job.workflowId,
              stageId: job.stageId,
              attempt: job.attempt,
              maxAttempts: job.maxAttempts,
              payload: job.payload,
              startedAt: job.startedAt,
            },
            jobHeartbeatIntervalMs: 2 ** 30,
            logPrefix: `[${worker}]`,
          });
        }
        return;
      }
      if (command === "stage.pollSuspended") {
        const polled = await h.kernel.dispatch({
          type: "stage.pollSuspended",
          maxChecks: 50,
        });
        resumedByWorker.set(worker, polled.resumedWorkflowRunIds);
        workedThisRound ||= polled.resumedWorkflowRunIds.length > 0;
        return;
      }
      if (command === "run.transition") {
        const resumed = resumedByWorker.get(worker) ?? [];
        for (const workflowRunId of resumed) {
          await h.kernel.dispatch({ type: "run.transition", workflowRunId });
        }
        workedThisRound ||= resumed.length > 0;
        return;
      }
      if (command === "lease.reapStale") {
        await h.kernel.dispatch({
          type: "lease.reapStale",
          staleThresholdMs: STALE_MS,
          absoluteTimeoutMs: HOST_DEFAULTS.jobAbsoluteTimeoutMs,
        });
        return;
      }
      if (command === "outbox.flush") {
        const result = await h.kernel.dispatch({
          type: "outbox.flush",
          maxEvents: 500,
        });
        workedThisRound ||= result.published > 0;
        return;
      }
      await h.kernel.dispatch({
        type: "run.reapStuck",
        stuckThresholdMs: STUCK_MS,
      });
    });

  for (let round = 0; round < 64; round++) {
    workedThisRound = false;
    if (runId) {
      currentWorker = "outside";
      currentCommand = "external";
      await scenario.external?.(h, runId);
    }
    for (const entry of schedule) {
      faults.dirty = false;
      try {
        await action(entry.worker, entry.command);
      } catch (error) {
        if (!faults.dirty) throw error;
      }
      // A crash stops that worker's current command. The next scheduled
      // command is a fresh tick by whichever worker owns it.
      faults.dead = false;
    }
    if (!workedThisRound) clock.advance(60_000);
    const run = runId ? await h.persistence.getRun(runId) : null;
    if (
      run &&
      ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status) &&
      (await (scenario.settled?.(h, runId!) ?? true))
    ) {
      return {
        faults,
        status: run.status,
        output: run.output,
        runId,
        scenario,
        harness: h,
        describe: async () => describeRun(h, runId),
      };
    }
  }
  return {
    faults,
    status: "WEDGED",
    output: undefined,
    runId,
    scenario,
    harness: h,
    describe: async () => describeRun(h, runId),
  };
}

async function assertInterleavings(
  build: () => SweepScenario,
  schedules: readonly InterleavedCommand[][],
  mode: Mode,
): Promise<number> {
  const clean = await drive(build, -1, "error");
  const failures: string[] = [];
  let knownClaimCrashReproductions = 0;

  for (let index = 0; index < schedules.length; index++) {
    const result = await runTwoWorkerSchedule(build, schedules[index]!, mode);
    const errors = await invariantErrors(result);
    const accepted =
      (await result.scenario.acceptsFaultOutcome?.(result, mode, clean)) ??
      false;
    const persisted = result.runId
      ? await result.harness.persistence.getRun(result.runId)
      : null;
    const outputError = (
      persisted?.output as { error?: { code?: string } } | undefined
    )?.error;
    // Registered below as a focused it.fails reproduction. At the threshold,
    // both workers have already dequeued; worker A's reaper enqueues the
    // missing job, then worker B's reaper can fail its still-PENDING stage
    // before either worker dequeues again.
    if (
      mode === "crash" &&
      result.faults.firedAt === "persistence.commit" &&
      persisted?.status === "FAILED" &&
      outputError?.code === "STUCK_RUN_REAPED"
    ) {
      knownClaimCrashReproductions++;
      continue;
    }
    if (
      !result.faults.firedAt ||
      (!sameOutcome(result, clean) && !accepted) ||
      errors.length > 0
    ) {
      failures.push(
        `schedule ${index} fault ${result.faults.firedAt ?? "did not fire"}: ${await result.describe()}${errors.length ? `; ${errors.join(", ")}` : ""}`,
      );
    }
  }

  expect(
    failures.length,
    `${failures.length} interleavings failed:\n${failures.slice(0, 12).join("\n")}`,
  ).toBe(0);
  return knownClaimCrashReproductions;
}

describe("two interleaved host workers", () => {
  const small = new Set(["a single durable step", "a parallel group"]);

  // Keep each exhaustive pass in a separate Vitest task. Every one still
  // covers all C(14, 7) command-level merges, while worker RPC updates remain
  // timely on busy CI hosts.
  for (const name of small) {
    for (const mode of ["error", "crash"] as const) {
      it(`${name}: enumerates every small interleaving (${mode})`, async () => {
        const { build } = SCENARIOS[name]!;
        await assertInterleavings(build, ALL_TICK_INTERLEAVINGS, mode);
      }, 300_000);
    }
  }

  it("survives one fault across bounded large schedules", async () => {
    const bounded = boundedInterleavings(8);
    let knownClaimCrashReproductions = 0;
    for (const [name, { build }] of Object.entries(SCENARIOS)) {
      if (small.has(name)) continue;
      for (const mode of ["error", "crash"] as const) {
        knownClaimCrashReproductions += await assertInterleavings(
          build,
          bounded,
          mode,
        );
      }
    }
    expect(knownClaimCrashReproductions).toBeGreaterThan(0);
  }, 300_000);

  // Known defect: after the threshold, worker A's run.reapStuck re-enqueues
  // the missing job; worker B's later run.reapStuck can fail the still-PENDING
  // stage before either worker gets another dequeue command. Cause:
  // run-reap-stuck.ts refreshes the run's activity after a re-enqueue only when
  // the job transport is transaction-read-bound (the Prisma queue is, the
  // in-memory one is not), so the run still looks stuck, and the second pass,
  // which no longer sees a missing job, falls through to the reap.
  it.fails(
    "known defect: a second stuck-run reaper fails the recovered PENDING job before dequeue",
    async () => {
      const result = await runTwoWorkerSchedule(
        SCENARIOS["two sequential stages"]!.build,
        boundedInterleavings(8)[1]!,
        "crash",
      );
      expect(result.faults.firedAt).toBe("persistence.commit");
      expect(result.status).toBe("COMPLETED");
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    "runs the stage once when a cancelled job is delivered after the redrive",
    async () => {
      expect(await lateDeliveryAfterRedriveErrors()).toEqual([]);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    "adopts the replacement batch after a crash without reusing the cancelled batch",
    async () => {
      const result = await drive(
        SCENARIOS["run.cancel then redrive replaces the batch"]!.build,
        2,
        "crash",
        undefined,
        ["batch.start"],
      );
      expect(result.faults.firedAt).toBe("batch.start");
      expect(await invariantErrors(result)).toEqual([]);
      expect(result.status).toBe("COMPLETED");
    },
    SWEEP_TIMEOUT_MS,
  );

  // A superseded poll reads the stage row again before its first write
  // (`stage.pollSuspended`, `superseded`), so on this base the worker that lost
  // its claim attempts no write and counts nothing as resumed.
  it(
    "writes nothing from a suspended-stage poll after another worker takes its expired poll claim",
    async () => {
      const inputSchema = z.object({ value: z.number() });
      const outputSchema = z.object({ value: z.number() });
      let pollCalls = 0;
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      let markFirstEntered!: () => void;
      let markSecondEntered!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const firstEntered = new Promise<void>((resolve) => {
        markFirstEntered = resolve;
      });
      const secondEntered = new Promise<void>((resolve) => {
        markSecondEntered = resolve;
      });
      const stageDef = defineAsyncBatchStage({
        id: "poll",
        name: "Poll",
        mode: "async-batch",
        schemas: {
          input: inputSchema,
          output: outputSchema,
          config: z.object({}),
        },
        async execute() {
          return { suspended: true, state: { batchId: "poll-race" } };
        },
        async checkCompletion() {
          pollCalls++;
          if (pollCalls === 1) {
            markFirstEntered();
            await firstGate;
          } else if (pollCalls === 2) {
            markSecondEntered();
            await secondGate;
          }
          return { ready: true, output: { value: 1 } };
        },
      });
      const workflow = new WorkflowBuilder(
        "poll-claim-race",
        "Poll Claim Race",
        "test",
        inputSchema,
        outputSchema,
      )
        .pipe(stageDef)
        .build();
      const clock = new FakeClock(new Date());
      const h = createTestHarness({
        workflows: [workflow],
        clock,
      }) as SweepHarness;
      Object.assign(h.persistence, { now: () => clock.now() });
      Object.assign(h.jobQueue, { now: () => clock.now() });
      let currentWorker = "setup";
      let currentCommand = "setup";
      let runId = "";
      const claimVersions = new Map<string, number>();
      const lostClaimWrites: string[] = [];
      const persistence = h.persistence as unknown as Record<string, unknown>;
      const updateStage = persistence.updateStage as (
        id: string,
        patch: Record<string, unknown>,
      ) => Promise<void>;
      persistence.updateStage = async (
        id: string,
        patch: Record<string, unknown>,
      ) => {
        const before = (await h.persistence.getStagesByRun(runId)).find(
          (stage) => stage.id === id,
        );
        const claimVersion = claimVersions.get(currentWorker);
        const lost =
          currentCommand === "stage.pollSuspended" &&
          claimVersion !== undefined &&
          before !== undefined &&
          before.version !== claimVersion;
        await updateStage.call(h.persistence, id, patch);
        const after = (await h.persistence.getStagesByRun(runId)).find(
          (stage) => stage.id === id,
        );
        if (
          currentCommand === "stage.pollSuspended" &&
          patch.status === undefined &&
          patch.expectedVersion !== undefined &&
          patch.nextPollAt !== undefined &&
          after
        ) {
          claimVersions.set(currentWorker, after.version);
        }
        if (lost)
          lostClaimWrites.push(
            `${currentWorker} wrote version ${before?.version} after claim version ${claimVersion}`,
          );
      };
      injectFaults(h, -1, "error"); // preserve the transaction rollback the in-memory port does not provide
      h.withWorkerContext = async (worker, command, action) => {
        const previousWorker = currentWorker;
        const previousCommand = currentCommand;
        currentWorker = worker;
        currentCommand = command;
        try {
          return await action();
        } finally {
          currentWorker = previousWorker;
          currentCommand = previousCommand;
        }
      };
      const created = await h.kernel.dispatch({
        type: "run.create",
        workflowId: workflow.id,
        input: { value: 1 },
        idempotencyKey: "poll-claim-race",
      });
      runId = created.workflowRunId;
      await h.kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-A",
      });
      const job = await h.jobQueue.dequeue();
      expect(job).toBeTruthy();
      await executeJobWithHeartbeat(h.kernel, {
        jobTransport: h.jobQueue,
        job: {
          jobId: job!.jobId,
          workflowRunId: job!.workflowRunId,
          workflowId: job!.workflowId,
          stageId: job!.stageId,
          attempt: job!.attempt,
          maxAttempts: job!.maxAttempts,
          payload: job!.payload,
          startedAt: job!.startedAt,
        },
        jobHeartbeatIntervalMs: 2 ** 30,
        logPrefix: "[worker-A]",
      });
      clock.advance(61_000);
      const pollA = h.withWorkerContext!(
        "worker-A",
        "stage.pollSuspended",
        () => h.kernel.dispatch({ type: "stage.pollSuspended", maxChecks: 50 }),
      );
      await firstEntered;
      clock.advance(61_000);
      const pollB = h.withWorkerContext!(
        "worker-B",
        "stage.pollSuspended",
        () => h.kernel.dispatch({ type: "stage.pollSuspended", maxChecks: 50 }),
      );
      await secondEntered;
      currentWorker = "worker-A";
      currentCommand = "stage.pollSuspended";
      releaseFirst();
      const resultA = await pollA;
      expect(resultA.resumedWorkflowRunIds).toEqual([]);
      expect(lostClaimWrites).toEqual([]);
      currentWorker = "worker-B";
      currentCommand = "stage.pollSuspended";
      releaseSecond();
      const resultB = await pollB;
      currentWorker = "outside";
      currentCommand = "outside";
      for (const workflowRunId of resultB.resumedWorkflowRunIds) {
        await h.kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      const stage = await h.persistence.getStage(runId, "poll");
      expect(stage?.status).toBe("COMPLETED");
    },
    SWEEP_TIMEOUT_MS,
  );
});
