/**
 * Liveness sweep: a run that was created reaches the outcome a fault-free
 * run reaches, whichever single write fails on the way.
 *
 * For each scenario the fault-free run counts its fault points; the sweep
 * then replays the scenario once per point and per mode:
 *
 *  - `error`: that one write throws and the process carries on (a store
 *    error, a dropped connection).
 *  - `crash`: that write throws and so does every write after it, until the
 *    next loop iteration "restarts the process".
 *
 * A fault point is a write that commits on its own in production: a write
 * to the job queue, the step ledger or the blob store, a persistence write
 * outside a transaction, or the commit of a kernel transaction. Writes
 * inside a transaction are not points of their own, because the in-memory
 * persistence is given real rollback here (it has none: `withTransaction`
 * is `fn(this)`).
 *
 * The loop is the host's: claim, drain jobs, poll suspended stages, reap
 * stale leases, flush the outbox, reap stuck runs, with the production
 * thresholds, every port on one fake clock that moves a minute at a time.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { defineWorkflow, type Workflow } from "../../core/workflow.js";
import { IdempotencyInProgressError } from "../../kernel/errors.js";
import {
  executeJobWithHeartbeat,
  HOST_DEFAULTS,
} from "../../kernel/helpers/host-support.js";
import { FakeClock } from "../../kernel/testing/index.js";
import { createTestHarness } from "../../testing/index.js";

type Harness = ReturnType<typeof createTestHarness>;
type Mode = "error" | "crash";

const STEP_MS = 60_000;
const MAX_ITERATIONS = 400;
const STALE_MS = HOST_DEFAULTS.staleLeaseThresholdMs;
// The hosts' default: max(3 * staleLeaseThresholdMs, 5 minutes).
const STUCK_MS = Math.max(3 * STALE_MS, 300_000);

const PERSISTENCE_WRITES = [
  "createRun",
  "updateRun",
  "deleteRun",
  "claimPendingRun",
  "claimNextPendingRun",
  "createStage",
  "upsertStage",
  "updateStage",
  "updateStageByRunAndStageId",
  "deleteStage",
  "createLog",
  "appendOutboxEvents",
  "claimUnpublishedOutboxEvents",
  "releaseOutboxEvents",
  "markOutboxEventsPublished",
  "incrementOutboxRetryCount",
  "moveOutboxEventToDLQ",
  "replayDLQEvents",
  "acquireIdempotencyKey",
  "completeIdempotencyKey",
  "releaseIdempotencyKey",
  "saveArtifact",
  "deleteArtifact",
  "appendAnnotations",
  "saveStageOutput",
  "insertDefinitionIfAbsent",
];
const JOB_QUEUE_WRITES = [
  "enqueue",
  "enqueueParallel",
  "deleteByRunAndStages",
  "dequeue",
  "complete",
  "suspend",
  "defer",
  "fail",
  "releaseStaleJobs",
  "expireRunawayJobs",
  "touchJob",
  "cancelByRun",
];
const LEDGER_WRITES = [
  "claim",
  "update",
  "compareAndSet",
  "clear",
  "clearExcept",
];
const BLOB_WRITES = ["put", "delete"];

class InjectedFault extends Error {}

type AnyFn = (...args: unknown[]) => unknown;
type Patchable = Record<string, unknown>;

function injectFaults(h: Harness, failAt: number, mode: Mode) {
  const state = {
    points: 0,
    dead: false,
    /** A fault was thrown since the caller last cleared this. */
    dirty: false,
    firedAt: undefined as string | undefined,
  };
  let txDepth = 0;

  const fault = (label: string): never => {
    state.dirty = true;
    throw new InjectedFault(label);
  };
  const point = (label: string) => {
    if (state.dead) fault(`dead: ${label}`);
    state.points++;
    if (state.points === failAt) {
      state.firedAt = label;
      if (mode === "crash") state.dead = true;
      fault(label);
    }
  };

  const patch = (
    port: string,
    target: Patchable,
    names: string[],
    insideTx: () => boolean,
  ) => {
    for (const name of names) {
      const original = target[name];
      if (typeof original !== "function") continue;
      target[name] = async (...args: unknown[]) => {
        const label = `${port}.${name}`;
        if (insideTx()) {
          if (state.dead) fault(`dead: ${label}`);
        } else {
          point(label);
        }
        return (original as AnyFn).apply(target, args);
      };
    }
  };

  const persistence = h.persistence as unknown as Patchable;
  // One clone call, so a record stored under two keys stays one record.
  const snapshot = () =>
    structuredClone(
      Object.fromEntries(
        Object.entries(persistence).filter(
          ([, value]) => typeof value !== "function",
        ),
      ),
    );
  persistence.withTransaction = async (
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    if (txDepth > 0) return fn(persistence);
    if (state.dead) fault("dead: persistence.begin");
    const before = snapshot();
    txDepth++;
    try {
      const result = await fn(persistence);
      point("persistence.commit");
      return result;
    } catch (error) {
      Object.assign(persistence, before);
      throw error;
    } finally {
      txDepth--;
    }
  };

  patch("persistence", persistence, PERSISTENCE_WRITES, () => txDepth > 0);
  const never = () => false;
  patch("jobs", h.jobQueue as unknown as Patchable, JOB_QUEUE_WRITES, never);
  patch("ledger", h.stepLedger as unknown as Patchable, LEDGER_WRITES, never);
  patch("blobs", h.blobStore as unknown as Patchable, BLOB_WRITES, never);

  return state;
}

/** One round of what a host does, in the host's order. */
async function hostTick(h: Harness) {
  const { kernel, jobQueue } = h;
  let worked = false;

  const claim = await kernel.dispatch({
    type: "run.claimPending",
    workerId: "sweep-worker",
    maxClaims: 50,
  });
  worked ||= claim.claimed.length > 0;

  for (;;) {
    const job = await jobQueue.dequeue();
    if (!job) break;
    worked = true;
    await executeJobWithHeartbeat(kernel, {
      jobTransport: jobQueue,
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
      // The heartbeat runs on the wall clock and opens its own transaction;
      // keep it out of a sweep that snapshots and restores persistence.
      jobHeartbeatIntervalMs: 2 ** 30,
      logPrefix: "[Sweep]",
    });
  }

  const polled = await kernel.dispatch({
    type: "stage.pollSuspended",
    maxChecks: 50,
  });
  for (const workflowRunId of polled.resumedWorkflowRunIds) {
    worked = true;
    await kernel.dispatch({ type: "run.transition", workflowRunId });
  }

  await kernel.dispatch({
    type: "lease.reapStale",
    staleThresholdMs: STALE_MS,
    absoluteTimeoutMs: HOST_DEFAULTS.jobAbsoluteTimeoutMs,
  });
  await kernel.dispatch({ type: "outbox.flush", maxEvents: 500 });
  await kernel.dispatch({ type: "run.reapStuck", stuckThresholdMs: STUCK_MS });

  if (!worked) h.clock.advance(STEP_MS);
}

/** Why a run that did not complete is where it is. */
async function describeRun(h: Harness, runId: string | undefined) {
  if (!runId) return "run was never created";
  const run = await h.persistence.getRun(runId);
  const stages = await h.persistence.getStagesByRun(runId);
  const jobs = await h.jobQueue.getJobsByWorkflowRun(runId);
  const steps = (
    await Promise.all(stages.map((stage) => h.stepLedger.list(stage.id)))
  ).flat();
  return JSON.stringify({
    run: run?.status,
    output: run?.output,
    stages: stages.map((s) => ({
      id: s.stageId,
      status: s.status,
      nextPollAt: s.nextPollAt,
      error: s.errorMessage,
    })),
    jobs: jobs.map((j) => `${j.stageId}:${j.status}`),
    steps: steps.map((s) => `${s.stepId}:${s.kind}:${s.status}`),
  });
}

interface Scenario {
  workflow: Workflow<any, any>;
  input: Record<string, unknown>;
  /** What the outside world does between ticks (send a signal, ...). */
  external?: (h: Harness, runId: string) => Promise<void>;
  /** False while a terminal status is not yet the end (a redrive is due). */
  settled?: () => boolean;
}

async function drive(build: () => Scenario, failAt: number, mode: Mode) {
  const scenario = build();
  const clock = new FakeClock();
  const h = createTestHarness({ workflows: [scenario.workflow], clock });
  // Every port on the one clock, so the reapers' thresholds mean something.
  Object.assign(h.persistence, { now: () => clock.now() });
  Object.assign(h.jobQueue, { now: () => clock.now() });
  const faults = injectFaults(h, failAt, mode);

  let runId: string | undefined;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    faults.dirty = false;
    try {
      if (!runId) {
        // The caller of run.create retries with the same key.
        const created = await h.kernel.dispatch({
          type: "run.create",
          idempotencyKey: "sweep",
          workflowId: scenario.workflow.id,
          input: scenario.input,
        });
        runId = created.workflowRunId;
      }
      await scenario.external?.(h, runId);
      await hostTick(h);
    } catch (error) {
      // A crash inside run.create leaves its key in progress; the kernel
      // refuses the retry until the key goes stale, so the caller waits.
      if (error instanceof IdempotencyInProgressError) clock.advance(STEP_MS);
      else if (!faults.dirty) throw error;
    }
    faults.dead = false; // the process restarts

    const run = runId ? await h.persistence.getRun(runId) : null;
    if (
      run &&
      ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status) &&
      (scenario.settled?.() ?? true)
    ) {
      return {
        faults,
        status: run.status as string,
        output: run.output,
        describe: () => describeRun(h, runId),
      };
    }
  }
  return {
    faults,
    status: "WEDGED",
    output: undefined,
    describe: () => describeRun(h, runId),
  };
}

const In = z.object({ value: z.number() });
const Out = z.object({ value: z.number() });
const noConfig = z.object({});

function sequential(): Scenario {
  const workflow = defineWorkflow("sweep-sequential", { input: In })
    .stage("double", {
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        return { output: { value: ctx.input.value * 2 } };
      },
    })
    .stage("increment", {
      dependencies: ["double"],
      schemas: { input: "none", output: Out, config: noConfig },
      async execute(ctx) {
        return { output: { value: ctx.require("double").value + 1 } };
      },
    })
    .build();
  return { workflow, input: { value: 20 } };
}

function parallelGroup(): Scenario {
  const branch = (id: string, add: number) =>
    defineStage({
      id,
      name: id,
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        return { output: { value: ctx.input.value + add } };
      },
    });
  const workflow = defineWorkflow("sweep-parallel", { input: In })
    .parallel([branch("left", 1), branch("right", 2)])
    .build();
  return { workflow, input: { value: 20 } };
}

function sleepLongerThanTheStuckThreshold(): Scenario {
  const workflow = defineWorkflow("sweep-sleep", { input: In })
    .stage("nap", {
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        const a = await ctx.step.run("before", async () => ctx.input.value);
        await ctx.step.sleep("nap", "20m");
        const b = await ctx.step.run("after", async () => a + 1);
        return { output: { value: b } };
      },
    })
    .build();
  return { workflow, input: { value: 20 } };
}

function pollUntilReady(): Scenario {
  let polls = 0;
  const workflow = defineWorkflow("sweep-wait", { input: In })
    .stage("wait", {
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        const seen = await ctx.step.waitFor("ready", {
          poll: async () => ++polls,
          ready: (n) => n >= 3,
          every: "2m",
          timeout: "1h",
        });
        return { output: { value: seen >= 3 ? 1 : 0 } };
      },
    })
    .build();
  return { workflow, input: { value: 20 } };
}

function signal(): Scenario {
  let sent = false;
  const workflow = defineWorkflow("sweep-signal", { input: In })
    .stage("approve", {
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        await ctx.step.run("prepare", async () => true);
        const answer = await ctx.step.waitForSignal<{ add: number }>(
          "approval",
          { timeout: "1d" },
        );
        return { output: { value: ctx.input.value + answer.add } };
      },
    })
    .build();
  return {
    workflow,
    input: { value: 20 },
    // The sender retries until the signal is accepted, and sends it once.
    async external(h, runId) {
      if (sent) return;
      const stage = await h.persistence.getStage(runId, "approve");
      if (stage?.status !== "SUSPENDED") return;
      await h.kernel.dispatch({
        type: "step.signal",
        workflowRunId: runId,
        stageId: "approve",
        stepId: "approval",
        payload: { add: 5 },
      });
      sent = true;
    },
  };
}

function redriveFromStart(): Scenario {
  let broken = true;
  let attempted = false;
  let redriven = false;
  const workflow = defineWorkflow("sweep-redrive", { input: In })
    .stage("first", {
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        const value = await ctx.step.run("a", async () => ctx.input.value);
        return { output: { value } };
      },
    })
    .stage("second", {
      dependencies: ["first"],
      schemas: { input: "none", output: Out, config: noConfig },
      async execute(ctx) {
        const value = await ctx.step.run("b", async () => {
          if (broken) throw new Error("downstream is down");
          return ctx.require("first").value + 1;
        });
        return { output: { value } };
      },
    })
    .build();
  return {
    workflow,
    input: { value: 20 },
    settled: () => redriven,
    // The operator fixes the cause, then retries the redrive until accepted.
    async external(h, runId) {
      if (redriven) return;
      const run = await h.persistence.getRun(runId);
      if (run?.status !== "FAILED") {
        // A redrive whose call threw after its transaction committed.
        redriven = attempted;
        return;
      }
      attempted = true;
      broken = false;
      await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: runId,
        from: { kind: "start" },
        idempotencyKey: "sweep-redrive",
      });
      redriven = true;
    },
  };
}

/**
 * Open defects the sweep found. A marked case runs under `it.fails`, so it
 * goes red the day the defect is fixed: delete the entry then. While an
 * entry stands, that one case cannot catch a second defect.
 */
const REAPED_WHILE_WAITING =
  "run.reapStuck fails a run whose suspended stage is not due for longer than the stuck threshold";
const REPLAY_ERROR_IS_TERMINAL =
  "stage.pollSuspended fails the run on a transient store error during a replay, where job.execute would retry";

interface Case {
  build: () => Scenario;
  knownDefect?: Partial<Record<"clean" | Mode, string>>;
}

const SCENARIOS: Record<string, Case> = {
  "two sequential stages": { build: sequential },
  "a parallel group": { build: parallelGroup },
  "a sleep longer than the stuck-run threshold": {
    build: sleepLongerThanTheStuckThreshold,
    knownDefect: {
      clean: REAPED_WHILE_WAITING,
      error: REAPED_WHILE_WAITING,
      crash: REAPED_WHILE_WAITING,
    },
  },
  "a poll that is ready on the third try": {
    build: pollUntilReady,
    knownDefect: { error: REPLAY_ERROR_IS_TERMINAL },
  },
  "a wait for a signal": {
    build: signal,
    knownDefect: { error: REPLAY_ERROR_IS_TERMINAL },
  },
  "a redrive from the start": { build: redriveFromStart },
};

describe("liveness sweep", () => {
  // executeJobWithHeartbeat reports every injected failure on console.error.
  beforeAll(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  for (const [name, { build, knownDefect }] of Object.entries(SCENARIOS)) {
    const test = (kind: "clean" | Mode) =>
      knownDefect?.[kind] ? it.fails : it;

    describe(name, () => {
      test("clean")("completes with no fault", async () => {
        const clean = await drive(build, -1, "error");
        expect(
          clean.status === "COMPLETED" ? "COMPLETED" : await clean.describe(),
        ).toBe("COMPLETED");
        expect(clean.faults.points).toBeGreaterThan(0);
      });

      for (const mode of ["error", "crash"] as const) {
        test(mode)(
          `reaches the same outcome when any one write fails (${mode})`,
          async () => {
            const clean = await drive(build, -1, "error");
            const failures: string[] = [];
            for (let k = 1; k <= clean.faults.points; k++) {
              const result = await drive(build, k, mode);
              // A point past the end of a shorter faulted run never fires.
              if (!result.faults.firedAt) continue;
              const same =
                result.status === clean.status &&
                JSON.stringify(result.output) === JSON.stringify(clean.output);
              if (!same) {
                failures.push(
                  `#${k} ${result.faults.firedAt} -> ${await result.describe()}`,
                );
              }
            }
            expect(failures).toEqual([]);
          },
        );
      }
    });
  }
});
