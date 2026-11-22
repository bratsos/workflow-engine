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

import { z } from "zod";
import type { EngineBatchModel, EngineBatchRef } from "../../ai/batch/model.js";
import { AIBatchImpl } from "../../ai/batch-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
import { NonRetryableError } from "../../core/steps.js";
import {
  defineWorkflow,
  type Workflow,
  WorkflowBuilder,
} from "../../core/workflow.js";
import { IdempotencyInProgressError } from "../../kernel/errors.js";
import {
  executeJobWithHeartbeat,
  HOST_DEFAULTS,
} from "../../kernel/helpers/host-support.js";
import type { KernelServices } from "../../kernel/ports.js";
import { FakeClock } from "../../kernel/testing/index.js";
import { createTestHarness } from "../../testing/index.js";
import { createMockAIHelperFactory } from "../utils/index.js";

export type SweepHarness = ReturnType<typeof createTestHarness> & {
  readLogs?: () => Promise<Array<{ level?: string; message?: string }>>;
  duplicateOutboxEventIds?: string[];
  withWorkerContext?: <T>(
    workerId: string,
    command: string,
    action: () => Promise<T>,
  ) => Promise<T>;
  withCommandContext?: <T>(
    command: string,
    action: () => Promise<T>,
  ) => Promise<T>;
};
export type Mode = "error" | "crash";

export interface SweepScenario {
  workflow: Workflow<any, any>;
  input: Record<string, unknown>;
  services?: Partial<KernelServices>;
  /** What the outside world does between host ticks. */
  external?: (h: SweepHarness, runId: string) => Promise<void>;
  /** Called after run.create gives the scenario its durable run id. */
  onRunCreated?: (h: SweepHarness, runId: string) => void;
  /** False while a terminal state still needs cancellation recovery/redrive. */
  settled?: (h: SweepHarness, runId: string) => Promise<boolean> | boolean;
  /** Additional scenario-specific assertions after reaching a terminal state. */
  validate?: (
    h: SweepHarness,
    runId: string,
    context: { faulted: boolean; faultAt?: string },
  ) => Promise<string[]> | string[];
  /** External provider write targets that belong in the crash-window sweep. */
  writeTargets?: Array<{ port: string; target: Patchable; names: string[] }>;
  /** A documented outcome for a single fault point (e.g. no-adoption refusal). */
  acceptsFaultOutcome?: (
    result: SweepResult,
    mode: Mode,
    clean: SweepResult,
  ) => Promise<boolean> | boolean;
}

export interface SweepResult {
  faults: ReturnType<typeof injectFaults>;
  status: string;
  output: unknown;
  runId?: string;
  scenario: SweepScenario;
  harness: SweepHarness;
  describe: () => Promise<string>;
}

export interface SweepCase {
  build: () => SweepScenario;
  knownDefect?: Partial<Record<"clean" | Mode, string>>;
  /** A defect seen only with the transaction-backed database adapter. */
  databaseKnownDefect?: Partial<Record<"clean" | Mode, string>>;
  /** Database adapter findings can differ by backend implementation. */
  backendKnownDefects?: Partial<
    Record<"sqlite" | "postgres", Partial<Record<"clean" | Mode, string>>>
  >;
  /** Focused database-only reproductions outside the release-handler subset. */
  databaseKnownFaults?: Array<{
    mode: Mode;
    command: string;
    label: string;
    reason: string;
  }>;
  /** Smaller suite subset uses only these labels; memory mode ignores it. */
  databaseFaultLabels?: readonly string[];
}

export interface SweepAdapter {
  create(
    scenario: SweepScenario,
    clock: FakeClock,
  ): Promise<SweepHarness> | SweepHarness;
  /** True for adapters that already roll transaction failures back. */
  databaseTransactions?: boolean;
  /** Called before each independent database drive. */
  prepare?: () => Promise<void>;
  /** Translate virtual time progress for ports that use a real DB clock. */
  advanceTime?: (clock: FakeClock) => Promise<void>;
}

const STEP_MS = 60_000;
export const MAX_ITERATIONS = 400;
export const STALE_MS = HOST_DEFAULTS.staleLeaseThresholdMs;
// The hosts' default: max(3 * staleLeaseThresholdMs, 5 minutes).
export const STUCK_MS = Math.max(3 * STALE_MS, 300_000);

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

/** Match emitted payloads back to their outbox row, even when payloads repeat. */
export function trackOutboxDeliveries(h: SweepHarness): () => void {
  const persistence = h.persistence as unknown as Patchable;
  const originalClaim = persistence.claimUnpublishedOutboxEvents as AnyFn;
  const pending = new Map<string, unknown>();
  const delivered = new Set<string>();
  const deliveredPayloads = new Map<string, string>();
  h.duplicateOutboxEventIds = [];
  if (typeof originalClaim === "function") {
    persistence.claimUnpublishedOutboxEvents = async (...args: unknown[]) => {
      const rows = (await originalClaim.apply(persistence, args)) as Array<{
        id: string;
        payload: unknown;
      }>;
      for (const row of rows) pending.set(row.id, row.payload);
      return rows;
    };
  }
  const sink = h.eventSink as unknown as Patchable;
  const originalEmit = sink.emit as AnyFn;
  if (typeof originalEmit === "function") {
    sink.emit = async (event: unknown) => {
      const payloadKey = JSON.stringify(event) ?? String(event);
      const match = Array.from(pending.entries()).find(
        ([, payload]) => JSON.stringify(payload) === payloadKey,
      );
      if (match) {
        const [id] = match;
        pending.delete(id);
        if (delivered.has(id)) h.duplicateOutboxEventIds!.push(id);
        delivered.add(id);
        deliveredPayloads.set(payloadKey, id);
      } else {
        const duplicateId = deliveredPayloads.get(payloadKey);
        if (duplicateId) h.duplicateOutboxEventIds!.push(duplicateId);
      }
      return originalEmit.call(sink, event);
    };
  }
  return () => {
    if (typeof originalClaim === "function") {
      persistence.claimUnpublishedOutboxEvents = originalClaim;
    }
    if (typeof originalEmit === "function") sink.emit = originalEmit;
  };
}

class InjectedFault extends Error {}

type AnyFn = (...args: unknown[]) => unknown;
type Patchable = Record<string, unknown>;

export function injectFaults(
  h: SweepHarness,
  failAt: number,
  mode: Mode,
  options: {
    databaseTransactions?: boolean;
    writeTargets?: SweepScenario["writeTargets"];
    labels?: readonly string[];
    commands?: readonly string[];
    currentCommand?: () => string;
    currentWorker?: () => string;
    faultWorkerId?: string;
  } = {},
) {
  const state = {
    points: 0,
    dead: false,
    /** A fault was thrown since the caller last cleared this. */
    dirty: false,
    firedAt: undefined as string | undefined,
    firedCommand: undefined as string | undefined,
  };
  let txDepth = 0;
  let crashAfterCommitLabel: string | undefined;
  const restoreMethods: Array<() => void> = [];

  const fault = (label: string): never => {
    state.dirty = true;
    throw new InjectedFault(label);
  };
  const selected = (label: string) => {
    if (state.dead) fault(`dead: ${label}`);
    if (
      options.faultWorkerId !== undefined &&
      options.currentWorker?.() !== options.faultWorkerId
    )
      return false;
    if (
      options.commands &&
      !options.commands.includes(options.currentCommand?.() ?? "")
    )
      return false;
    if (options.labels && !options.labels.includes(label)) return false;
    state.points++;
    if (state.points === failAt) {
      state.firedAt = label;
      state.firedCommand = options.currentCommand?.();
      state.dirty = true;
      return true;
    }
    return false;
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
      restoreMethods.push(() => {
        target[name] = original;
      });
      target[name] = async (...args: unknown[]) => {
        const label = `${port}.${name}`;
        if (insideTx()) {
          if (state.dead) fault(`dead: ${label}`);
          if (!options.databaseTransactions) {
            return (original as AnyFn).apply(target, args);
          }
          const fires = selected(label);
          if (fires && mode === "error") fault(label);
          const result = await (original as AnyFn).apply(target, args);
          if (fires && mode === "crash") crashAfterCommitLabel = label;
          return result;
        }
        const fires = selected(label);
        if (fires && mode === "error") fault(label);
        const result = await (original as AnyFn).apply(target, args);
        if (fires && mode === "crash") {
          state.dead = true;
          fault(label);
        }
        return result;
      };
    }
  };

  const persistence = h.persistence as unknown as Patchable;
  const originalWithTransaction = persistence.withTransaction as AnyFn;
  restoreMethods.push(() => {
    persistence.withTransaction = originalWithTransaction;
  });
  // One clone call, so a record stored under two keys stays one record.
  const snapshot = () => {
    if (options.databaseTransactions) return undefined;
    return structuredClone(
      Object.fromEntries(
        Object.entries(persistence).filter(
          ([, value]) => typeof value !== "function",
        ),
      ),
    );
  };
  persistence.withTransaction = async (
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    if (txDepth > 0) return fn(persistence);
    if (state.dead) fault("dead: persistence.begin");
    crashAfterCommitLabel = undefined;
    const before = snapshot();
    txDepth++;
    let crashAfterCommit = false;
    let result: unknown;
    try {
      result = await originalWithTransaction.call(
        persistence,
        async (tx: unknown) => {
          const value = await fn(tx);
          const fires = selected("persistence.commit");
          if (fires && mode === "error") fault("persistence.commit");
          crashAfterCommit = fires && mode === "crash";
          return value;
        },
      );
    } catch (error) {
      crashAfterCommitLabel = undefined;
      if (before) Object.assign(persistence, before);
      throw error;
    } finally {
      txDepth--;
    }
    const crashLabel = crashAfterCommit
      ? "persistence.commit"
      : crashAfterCommitLabel;
    crashAfterCommitLabel = undefined;
    if (crashLabel) {
      state.dead = true;
      fault(crashLabel);
    }
    return result;
  };

  patch("persistence", persistence, PERSISTENCE_WRITES, () => txDepth > 0);
  const never = () => false;
  patch("jobs", h.jobQueue as unknown as Patchable, JOB_QUEUE_WRITES, never);
  patch("ledger", h.stepLedger as unknown as Patchable, LEDGER_WRITES, never);
  patch("blobs", h.blobStore as unknown as Patchable, BLOB_WRITES, never);
  if (h.aiLogger) {
    patch(
      "aiLogger",
      h.aiLogger as unknown as Patchable,
      ["logBatchResults"],
      never,
    );
  }
  if (h.eventSink) {
    patch("events", h.eventSink as unknown as Patchable, ["emit"], never);
  }
  for (const target of options.writeTargets ?? []) {
    patch(target.port, target.target, target.names, never);
  }

  return Object.assign(state, {
    restore() {
      for (const restoreMethod of restoreMethods.reverse()) restoreMethod();
    },
  });
}

/** One round of what a host does, in the host's order. */
export async function hostTick(
  h: SweepHarness,
  workerId = "sweep-worker",
  databaseTransactions = false,
): Promise<boolean> {
  const { kernel, jobQueue } = h;
  let worked = false;

  const claim = await kernel.dispatch({
    type: "run.claimPending",
    workerId,
    maxClaims: 50,
  });
  worked ||= claim.claimed.length > 0;

  for (;;) {
    const job = await jobQueue.dequeue();
    if (!job) break;
    worked = true;
    const execute = () =>
      executeJobWithHeartbeat(kernel, {
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
    if (h.withCommandContext)
      await h.withCommandContext("job.execute", execute);
    else await execute();
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
    staleThresholdMs: databaseTransactions ? 0 : STALE_MS,
    absoluteTimeoutMs: HOST_DEFAULTS.jobAbsoluteTimeoutMs,
  });
  await kernel.dispatch({ type: "outbox.flush", maxEvents: 500 });
  await kernel.dispatch({
    type: "run.reapStuck",
    stuckThresholdMs: STUCK_MS,
  });

  if (!worked) {
    h.clock.advance(STEP_MS);
    return true;
  }
  return false;
}

/** Why a run that did not complete is where it is. */
export async function describeRun(h: SweepHarness, runId: string | undefined) {
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

export async function drive(
  build: () => SweepScenario,
  failAt: number,
  mode: Mode,
  adapter: SweepAdapter = {
    create: (scenario, clock) =>
      createTestHarness({
        workflows: [scenario.workflow],
        clock,
        services: scenario.services,
      }) as SweepHarness,
  },
  faultLabels?: readonly string[],
  faultCommands?: readonly string[],
): Promise<SweepResult> {
  const scenario = build();
  await adapter.prepare?.();
  const clock = new FakeClock(new Date());
  const h = await adapter.create(scenario, clock);
  const restoreDeliveryTracking = trackOutboxDeliveries(h);
  let currentCommand = "outside";
  let restoreDispatch = () => {};
  let restoreCommandContext = () => {};
  if (faultCommands) {
    const kernelTarget = h.kernel as unknown as Patchable;
    const originalDispatch = kernelTarget.dispatch as AnyFn;
    kernelTarget.dispatch = async (...args: unknown[]) => {
      const previous = currentCommand;
      currentCommand = (args[0] as { type?: string } | undefined)?.type ?? "";
      try {
        return await originalDispatch.apply(h.kernel, args);
      } finally {
        currentCommand = previous;
      }
    };
    restoreDispatch = () => {
      kernelTarget.dispatch = originalDispatch;
    };
    const previousCommandContext = h.withCommandContext;
    h.withCommandContext = async <T>(
      command: string,
      action: () => Promise<T>,
    ) => {
      const previous = currentCommand;
      currentCommand = command;
      try {
        return await action();
      } finally {
        currentCommand = previous;
      }
    };
    restoreCommandContext = () => {
      h.withCommandContext = previousCommandContext;
    };
  }
  h.readLogs ??= async () => {
    const getAllLogs = (
      h.persistence as unknown as {
        getAllLogs?: () => Array<{ level?: string; message?: string }>;
      }
    ).getAllLogs;
    return getAllLogs?.call(h.persistence) ?? [];
  };
  // Every port on the one clock, so the reapers' thresholds mean something.
  if (!adapter.databaseTransactions) {
    Object.assign(h.persistence, { now: () => clock.now() });
    Object.assign(h.jobQueue, { now: () => clock.now() });
  }
  const faults = injectFaults(h, failAt, mode, {
    databaseTransactions: adapter.databaseTransactions,
    writeTargets: scenario.writeTargets,
    labels: faultLabels,
    commands: faultCommands,
    currentCommand: () => currentCommand,
  });

  let runId: string | undefined;
  try {
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
          scenario.onRunCreated?.(h, runId);
        }
        await scenario.external?.(h, runId);
        const advanced = await hostTick(
          h,
          "sweep-worker",
          adapter.databaseTransactions,
        );
        if (advanced) await adapter.advanceTime?.(clock);
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
        (await (scenario.settled?.(h, runId!) ?? true))
      ) {
        return {
          faults,
          status: run.status as string,
          output: run.output,
          runId,
          scenario,
          harness: h,
          describe: () => describeRun(h, runId),
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
      describe: () => describeRun(h, runId),
    };
  } finally {
    faults.restore();
    restoreDispatch();
    restoreCommandContext();
    restoreDeliveryTracking();
  }
}

/**
 * A delivery of the job a `run.cancel` cancelled reaches a worker after the
 * run was redriven from the start. This base keeps no generation on a job:
 * the late delivery is an ordinary execution of the redriven stage, and the
 * redriven job's own delivery then meets a COMPLETED stage. The stage body must
 * run once, one `stage:completed` must be emitted, and the run must complete.
 * The adapter lets the same assertion use memory and Prisma ports.
 */
export async function lateDeliveryAfterRedriveErrors(
  adapter: SweepAdapter = {
    create: (scenario, clock) =>
      createTestHarness({
        workflows: [scenario.workflow],
        clock,
        services: scenario.services,
      }) as SweepHarness,
  },
): Promise<string[]> {
  let bodyCalls = 0;
  const workflow = defineWorkflow("sweep-late-delivery", { input: In })
    .stage("work", {
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        const value = await ctx.step.run("effect", async () => {
          bodyCalls++;
          return ctx.input.value + 1;
        });
        return { output: { value } };
      },
    })
    .build();
  const scenario: SweepScenario = { workflow, input: { value: 20 } };
  await adapter.prepare?.();
  const clock = new FakeClock(new Date());
  const h = await adapter.create(scenario, clock);
  const { workflowRunId } = await h.kernel.dispatch({
    type: "run.create",
    idempotencyKey: "late-delivery",
    workflowId: workflow.id,
    input: scenario.input,
  });
  await h.kernel.dispatch({
    type: "run.claimPending",
    workerId: "late-delivery-test",
  });
  const [oldJob] = await h.jobQueue.getJobsByWorkflowRun(workflowRunId);
  if (!oldJob) return ["the claim did not enqueue a job"];

  await h.kernel.dispatch({ type: "run.cancel", workflowRunId });
  await h.kernel.dispatch({
    type: "run.redrive",
    workflowRunId,
    from: { kind: "start" },
    idempotencyKey: "late-delivery-redrive",
  });
  const newJob = (await h.jobQueue.getJobsByWorkflowRun(workflowRunId)).find(
    (job) => job.status === "PENDING",
  );
  if (!newJob) return ["redrive did not enqueue a job"];

  const deliver = (job: { id: string }) =>
    h.kernel.dispatch({
      type: "job.execute",
      idempotencyKey: `job:${job.id}:attempt:1`,
      workflowRunId,
      workflowId: workflow.id,
      stageId: "work",
      config: {},
      attempt: 1,
      maxAttempts: HOST_DEFAULTS.maxAttempts,
    });
  const errors: string[] = [];
  const late = await deliver(oldJob);
  if (late.outcome === "failed" && !late.ghost) {
    errors.push(`late delivery of the cancelled job failed: ${late.error}`);
  }
  const current = await deliver(newJob);
  if (current.outcome === "failed" && !current.ghost) {
    errors.push(`delivery of the redriven job failed: ${current.error}`);
  }
  await h.kernel.dispatch({ type: "run.transition", workflowRunId });
  await h.kernel.dispatch({ type: "outbox.flush", maxEvents: 500 });

  if (bodyCalls !== 1)
    errors.push(`the stage body ran ${bodyCalls} times, expected once`);
  const run = await h.persistence.getRun(workflowRunId);
  if (run?.status !== "COMPLETED")
    errors.push(`the redriven run ended ${run?.status}`);
  else if (JSON.stringify(run.output) !== JSON.stringify({ value: 21 })) {
    errors.push(`the redriven run's output was ${JSON.stringify(run.output)}`);
  }
  const events = (
    h.eventSink as unknown as { events?: Array<{ type: string }> }
  ).events;
  const completed = (events ?? []).filter(
    (event) => event.type === "stage:completed",
  ).length;
  if (completed !== 1)
    errors.push(`${completed} stage:completed events were emitted, expected 1`);
  return errors;
}

const In = z.object({ value: z.number() });
const Out = z.object({ value: z.number() });
const noConfig = z.object({});

async function wasStepAlreadyCompleted(
  h: SweepHarness | undefined,
  workflowRunId: string,
  stageId: string,
  stepId: string,
): Promise<boolean> {
  const stage = await h?.persistence.getStage(workflowRunId, stageId);
  const row = stage ? await h?.stepLedger.get(stage.id, stepId) : null;
  return row?.status === "completed";
}

function sequential(): SweepScenario {
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

function parallelGroup(): SweepScenario {
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

function sleepLongerThanTheStuckThreshold(): SweepScenario {
  const calls = new Map<string, { before: number; after: number }>();
  const completedReplays: string[] = [];
  let harness: SweepHarness | undefined;
  const workflow = defineWorkflow("sweep-sleep", { input: In })
    .stage("nap", {
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        const count = calls.get(ctx.workflowRunId) ?? { before: 0, after: 0 };
        calls.set(ctx.workflowRunId, count);
        const a = await ctx.step.run("before", async () => {
          if (
            await wasStepAlreadyCompleted(
              harness,
              ctx.workflowRunId,
              "nap",
              "before",
            )
          ) {
            completedReplays.push(`${ctx.workflowRunId}:before`);
          }
          count.before++;
          return ctx.input.value;
        });
        await ctx.step.sleep("nap", "20m");
        const b = await ctx.step.run("after", async () => {
          if (
            await wasStepAlreadyCompleted(
              harness,
              ctx.workflowRunId,
              "nap",
              "after",
            )
          ) {
            completedReplays.push(`${ctx.workflowRunId}:after`);
          }
          count.after++;
          return a + 1;
        });
        return { output: { value: b } };
      },
    })
    .build();
  return {
    workflow,
    input: { value: 20 },
    onRunCreated(h) {
      harness = h;
    },
    validate: async (h, runId) => {
      const stages = await h.persistence.getStagesByRun(runId);
      const steps = (
        await Promise.all(stages.map((stage) => h.stepLedger.list(stage.id)))
      ).flat();
      const completed = new Set(
        steps
          .filter((step) => step.status === "completed")
          .map((step) => step.stepId),
      );
      const count = calls.get(runId) ?? { before: 0, after: 0 };
      const errors: string[] = [];
      for (const replay of completedReplays.filter((value) =>
        value.startsWith(`${runId}:`),
      )) {
        errors.push(`completed step body was called again: ${replay}`);
      }
      if (completed.has("before") && count.before < 1)
        errors.push("completed step before body never ran");
      if (completed.has("after") && count.after < 1)
        errors.push("completed step after body never ran");
      return errors;
    },
  };
}

function pollUntilReady(): SweepScenario {
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

function signal(): SweepScenario {
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

function redriveFromStart(): SweepScenario {
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

const SWEEP_BATCH_MODEL = "liveness-sweep-batch-model";
const BatchInput = z.object({ items: z.array(z.number()) });
const BatchOutput = z.object({ value: z.number() });
const BatchItem = z.object({ v: z.string() });
registerModels({
  [SWEEP_BATCH_MODEL]: {
    id: "openai/gpt-4o",
    name: "Liveness Sweep Batch Model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
    batchProvider: "openrouter",
    supportsAsyncBatch: true,
  },
});

interface SweepProviderBatch {
  id: string;
  externalKey?: string;
  requestIds: string[];
  status: "pending" | "completed" | "cancelled";
  polls: number;
}

interface SweepBatchBackend {
  model: EngineBatchModel;
  batches: SweepProviderBatch[];
  statusCalls: string[];
  resultsCalls: string[];
  cancelCalls: string[];
  cancelledWithoutIntent: string[];
  hasCancelIntent?: (batchId: string) => Promise<boolean>;
  onStatus?: () => Promise<void>;
}

function createSweepBatchBackend(options: {
  adoptable: boolean;
  cancelable?: boolean;
}): SweepBatchBackend {
  const backend: SweepBatchBackend = {
    model: undefined as unknown as EngineBatchModel,
    batches: [],
    statusCalls: [],
    resultsCalls: [],
    cancelCalls: [],
    cancelledWithoutIntent: [],
  };
  const model: EngineBatchModel = {
    provider: "openrouter",
    modelId: "openai/gpt-4o",
    recovery: options.adoptable ? "metadata" : "none",
    async start(requests, startOptions) {
      const id = `sweep-batch-${backend.batches.length + 1}`;
      backend.batches.push({
        id,
        externalKey: startOptions?.externalKey,
        requestIds: requests.map((request) => request.id),
        status: "pending",
        polls: 0,
      });
      return {
        version: 1,
        type: "text",
        id,
        provider: "openrouter",
        modelId: "openai/gpt-4o",
        status: "pending",
      };
    },
    ...(options.adoptable
      ? {
          async adopt(externalKey: string, adoptOptions) {
            const batch = backend.batches.find(
              (candidate) =>
                candidate.externalKey === externalKey &&
                !adoptOptions?.excludeBatchIds?.includes(candidate.id),
            );
            if (!batch) return null;
            // Model a stale provider listing: cancellation is accepted, but
            // adopt still reports the old batch as processing. The engine's
            // exclusion list must make this stale listing harmless on redrive.
            return {
              version: 1 as const,
              type: "text" as const,
              id: batch.id,
              provider: "openrouter",
              modelId: "openai/gpt-4o",
              status:
                batch.status === "completed"
                  ? ("completed" as const)
                  : ("processing" as const),
            };
          },
        }
      : {}),
    async status(ref: EngineBatchRef) {
      backend.statusCalls.push(ref.id);
      await backend.onStatus?.();
      const batch = backend.batches.find(
        (candidate) => candidate.id === ref.id,
      );
      if (!batch) {
        return { status: "processing", rawStatus: "missing" };
      }
      if (batch.status === "cancelled") {
        return { status: "failed", rawStatus: "cancelled" };
      }
      if (batch.status === "completed") return { status: "completed" };
      batch.polls++;
      if (batch.polls >= 2) {
        batch.status = "completed";
        return { status: "completed" };
      }
      return { status: "pending" };
    },
    async *results(ref: EngineBatchRef) {
      backend.resultsCalls.push(ref.id);
      const batch = backend.batches.find(
        (candidate) => candidate.id === ref.id,
      );
      for (const id of batch?.requestIds ?? []) {
        yield {
          id,
          status: "succeeded" as const,
          text: JSON.stringify({ v: `result-${id}` }),
          inputTokens: 1,
          outputTokens: 1,
        };
      }
    },
  };
  if (options.cancelable) {
    Object.assign(model, {
      async cancel(ref: EngineBatchRef) {
        backend.cancelCalls.push(ref.id);
        if (!(await backend.hasCancelIntent?.(ref.id))) {
          backend.cancelledWithoutIntent.push(ref.id);
        }
        const batch = backend.batches.find(
          (candidate) => candidate.id === ref.id,
        );
        if (!batch || batch.status === "completed") {
          return {
            outcome: "already-terminal" as const,
            rawStatus: batch?.status,
          };
        }
        batch.status = "cancelled";
        return { outcome: "cancelled" as const, rawStatus: "cancelled" };
      },
    });
  }
  backend.model = model;
  return backend;
}

function batchMapScenario(options: {
  id: string;
  adoptable: boolean;
  cancelable?: boolean;
  cancelDuringPoll?: boolean;
  redriveAfterCancel?: boolean;
}): SweepScenario {
  const backend = createSweepBatchBackend(options);
  const calls = new Map<string, { before: number; after: number }>();
  const completedReplays: string[] = [];
  let harness: SweepHarness | undefined;
  const workflow = defineWorkflow(options.id, { input: BatchInput })
    .stage("map", {
      schemas: { input: BatchInput, output: BatchOutput, config: noConfig },
      async execute(ctx) {
        const count = calls.get(ctx.workflowRunId) ?? { before: 0, after: 0 };
        calls.set(ctx.workflowRunId, count);
        const before = await ctx.step.run("before", async () => {
          if (
            await wasStepAlreadyCompleted(
              harness,
              ctx.workflowRunId,
              "map",
              "before",
            )
          ) {
            completedReplays.push(`${ctx.workflowRunId}:before`);
          }
          count.before++;
          return ctx.input.items.length;
        });
        const mapped = await ctx.step.ai.map("extract", ctx.input.items, {
          model: SWEEP_BATCH_MODEL,
          policy: "batch",
          schema: BatchItem,
          prompt: (item) => `extract ${item}`,
          batch: { pollEvery: "1m", timeout: "1h" },
        });
        const after = await ctx.step.run("after", async () => {
          if (
            await wasStepAlreadyCompleted(
              harness,
              ctx.workflowRunId,
              "map",
              "after",
            )
          ) {
            completedReplays.push(`${ctx.workflowRunId}:after`);
          }
          count.after++;
          return mapped.length;
        });
        return { output: { value: before + after } };
      },
    })
    .build();
  const mock = createMockAIHelperFactory();
  const ai = (
    topic: string,
    logger: Parameters<NonNullable<KernelServices["ai"]>>[1],
    logContext?: unknown,
    providerResolver?: unknown,
    aiOptions?: unknown,
  ) => {
    const helper = mock(
      topic,
      logger,
      logContext as never,
      providerResolver as never,
      aiOptions as never,
    );
    return new Proxy(helper, {
      get(target, property, receiver) {
        if (property === "batch") {
          return (
            modelKey: string,
            provider?: string,
            batchOptions?: unknown,
          ) =>
            new AIBatchImpl(
              { topic, aiCallLogger: logger },
              modelKey,
              (provider ?? "openrouter") as never,
              undefined,
              batchOptions as never,
              backend.model,
            );
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  let runId: string | undefined;
  let cancelCommands = 0;
  let cancelResolved = 0;
  const cancelAnswers: Array<{ wasCancelled: boolean; cancelled: boolean }> =
    [];
  const cancelOutcomes: Array<Record<string, unknown>> = [];
  let cancelDuringPollStarted = false;
  let redriveAttempts = 0;
  let statusCallsBeforeRedrive = 0;

  const dispatchCancel = async (h: SweepHarness, workflowRunId: string) => {
    cancelCommands++;
    const wasCancelled =
      (await h.persistence.getRun(workflowRunId))?.status === "CANCELLED";
    const result = await h.kernel.dispatch({
      type: "run.cancel",
      workflowRunId,
    });
    cancelResolved++;
    cancelAnswers.push({ wasCancelled, cancelled: result.cancelled });
    cancelOutcomes.push(
      ...(result.batches as unknown as Array<Record<string, unknown>>),
    );
  };

  return {
    workflow,
    input: { items: [1, 2, 3] },
    services: {
      ai,
      batchModels: () => backend.model,
      batchCancelTimeouts: { batchMs: 1_000, sweepMs: 2_000 },
    },
    writeTargets: [
      {
        port: "batch",
        target: backend.model as unknown as Patchable,
        names: ["start", ...(options.cancelable ? ["cancel"] : [])],
      },
    ],
    onRunCreated(h, workflowRunId) {
      harness = h;
      runId = workflowRunId;
      backend.hasCancelIntent = async (batchId) => {
        const stages = await h.persistence.getStagesByRun(workflowRunId);
        for (const stage of stages) {
          for (const row of await h.stepLedger.list(stage.id)) {
            if (row.kind !== "run" || !row.stepId.endsWith(":submit")) continue;
            const result = row.result as {
              cancelIntent?: { batchIds?: string[] };
            } | null;
            if (result?.cancelIntent?.batchIds?.includes(batchId)) return true;
          }
        }
        return false;
      };
      if (options.cancelDuringPoll) {
        backend.onStatus = async () => {
          if (cancelDuringPollStarted || !runId) return;
          cancelDuringPollStarted = true;
          const cancel = () => dispatchCancel(h, runId!);
          if (h.withWorkerContext) {
            await h.withWorkerContext("worker-B", "run.cancel", cancel);
          } else {
            await cancel();
          }
        };
      }
    },
    async external(h, workflowRunId) {
      const run = await h.persistence.getRun(workflowRunId);
      if (!run || backend.batches.length === 0) return;
      if (
        options.cancelDuringPoll &&
        run.status === "RUNNING" &&
        cancelDuringPollStarted &&
        cancelResolved === 0
      ) {
        // If the first run.cancel failed before commit, retry the command while
        // the batch is still in its poll path. A committed cancel is followed
        // below by the second invocation that retries its post-commit sweep.
        await dispatchCancel(h, workflowRunId);
        return;
      }
      if (run.status === "CANCELLED" && cancelResolved < 2) {
        // A repeated run.cancel is the documented retry for a post-commit
        // provider sweep that failed or a command that crashed after commit.
        await dispatchCancel(h, workflowRunId);
        return;
      }
      if (
        options.redriveAfterCancel &&
        run.status === "CANCELLED" &&
        cancelResolved >= 2
      ) {
        const original = backend.batches[0];
        if (original?.status !== "cancelled") {
          await dispatchCancel(h, workflowRunId);
          return;
        }
        statusCallsBeforeRedrive = backend.statusCalls.length;
        redriveAttempts++;
        await h.kernel.dispatch({
          type: "run.redrive",
          workflowRunId,
          from: { kind: "stage", stageId: "map" },
          idempotencyKey: "sweep-redrive-after-cancel",
        });
      }
      if (
        options.redriveAfterCancel &&
        run.status === "RUNNING" &&
        redriveAttempts > 0
      ) {
        // The first redrive may have committed before its caller crashed.
        redriveAttempts = Math.max(1, redriveAttempts);
      }
    },
    settled: async (h, workflowRunId) => {
      const run = await h.persistence.getRun(workflowRunId);
      if (!options.cancelDuringPoll) return true;
      if (options.redriveAfterCancel) {
        return Boolean(run?.status === "COMPLETED" && redriveAttempts > 0);
      }
      return Boolean(run?.status === "CANCELLED" && cancelResolved >= 2);
    },
    validate: async (h, workflowRunId) => {
      const errors: string[] = [];
      for (const answer of cancelAnswers) {
        const expected = !answer.wasCancelled;
        if (answer.cancelled !== expected) {
          errors.push(
            `run.cancel answered cancelled=${answer.cancelled} after prior status ${answer.wasCancelled ? "CANCELLED" : "not CANCELLED"}; expected ${expected}`,
          );
        }
      }
      if (backend.cancelledWithoutIntent.length > 0) {
        errors.push(
          `provider cancel was sent before its durable cancelIntent for: ${backend.cancelledWithoutIntent.join(", ")}`,
        );
      }
      const byExternalKey = new Map<string, number>();
      for (const batch of backend.batches) {
        if (!batch.externalKey) {
          errors.push(`provider batch ${batch.id} has no submit external key`);
          continue;
        }
        byExternalKey.set(
          batch.externalKey,
          (byExternalKey.get(batch.externalKey) ?? 0) + 1,
        );
      }
      for (const [key, count] of byExternalKey) {
        const expected = options.redriveAfterCancel ? 2 : 1;
        if (count !== expected)
          errors.push(
            `submit step ${key} created ${count} provider batches; expected ${expected}`,
          );
      }
      const stages = await h.persistence.getStagesByRun(workflowRunId);
      const rows = (
        await Promise.all(stages.map((stage) => h.stepLedger.list(stage.id)))
      ).flat();
      const callCount = calls.get(workflowRunId) ?? { before: 0, after: 0 };
      const completed = new Set(
        rows
          .filter((row) => row.status === "completed")
          .map((row) => row.stepId),
      );
      for (const replay of completedReplays.filter((value) =>
        value.startsWith(`${workflowRunId}:`),
      )) {
        errors.push(`completed step body was called again: ${replay}`);
      }
      if (completed.has("before") && callCount.before < 1)
        errors.push("completed step before body never ran");
      if (completed.has("after") && callCount.after < 1)
        errors.push("completed step after body never ran");
      const run = await h.persistence.getRun(workflowRunId);
      const refusal =
        !options.adoptable &&
        run?.status === "FAILED" &&
        (await describeRun(h, workflowRunId)).includes(
          "cannot be recovered after a worker crash",
        );
      if (backend.batches.length > 0 && !options.cancelDuringPoll && !refusal) {
        if (backend.statusCalls.length === 0)
          errors.push("batch status was never polled");
        if (backend.resultsCalls.length === 0 && !options.redriveAfterCancel)
          errors.push("batch results were never collected");
      }
      if (options.cancelDuringPoll) {
        const cancellationTargets = options.redriveAfterCancel
          ? backend.batches.slice(0, 1)
          : backend.batches;
        const runningIds = cancellationTargets
          .filter((batch) => batch.status !== "cancelled")
          .map((batch) => batch.id);
        if (runningIds.length > 0) {
          const logs = (await h.readLogs?.()) ?? [];
          for (const id of runningIds) {
            const batch = cancellationTargets.find(
              (candidate) => candidate.id === id,
            );
            const outcomes = cancelOutcomes.filter(
              (outcome) =>
                (outcome.ref as { id?: string } | undefined)?.id === id ||
                (batch?.externalKey !== undefined &&
                  outcome.externalKey === batch.externalKey),
            );
            const hasOutcome = outcomes.length > 0;
            const hasWarning = logs.some(
              (log) =>
                log.level === "WARN" &&
                log.message?.includes("may still be running") &&
                (log.message.includes(id) ||
                  (batch?.externalKey !== undefined &&
                    log.message.includes(batch.externalKey))),
            );
            if (!hasOutcome || !hasWarning) {
              errors.push(
                `batch ${id} is still running without a WARN outcome (outcomes: ${JSON.stringify(outcomes)}, warnings: ${JSON.stringify(logs.filter((log) => log.level === "WARN").map((log) => log.message))})`,
              );
            }
          }
        }
      }
      if (options.redriveAfterCancel) {
        const oldId = backend.batches[0]?.id;
        const newId = backend.batches.at(-1)?.id;
        if (!oldId || !newId || oldId === newId)
          errors.push("redrive did not create a replacement provider batch");
        const sentIds = new Set(backend.cancelCalls);
        const waitedOn = backend.statusCalls
          .slice(statusCallsBeforeRedrive)
          .filter((id) => sentIds.has(id));
        if (waitedOn.length > 0) {
          errors.push(
            `redrive polled batches after sending their cancel: ${waitedOn.join(", ")}`,
          );
        }
        if (backend.batches[0]?.status !== "cancelled")
          errors.push(
            "the original provider batch was not cancelled before redrive",
          );
      }
      if (!options.adoptable) {
        if (run?.status === "FAILED") {
          const failed = stages.find((stage) => stage.status === "FAILED");
          if (
            !failed?.errorMessage?.includes(
              "cannot be recovered after a worker crash",
            )
          ) {
            errors.push(
              `non-adoptable transport failed without the documented refusal: ${failed?.errorMessage ?? "no stage error"}`,
            );
          }
        }
      }
      return errors;
    },
    async acceptsFaultOutcome(result) {
      return (
        !options.adoptable &&
        result.status === "FAILED" &&
        (await result.describe()).includes(
          "cannot be recovered after a worker crash",
        )
      );
    },
  };
}

function throwingLegacyCheckCompletion(): SweepScenario {
  let polls = 0;
  const stage = defineAsyncBatchStage({
    id: "legacy",
    name: "Legacy async batch",
    mode: "async-batch",
    schemas: { input: In, output: Out, config: noConfig },
    async execute(ctx) {
      return {
        suspended: true,
        state: { batchId: "legacy", metadata: { value: ctx.input.value } },
      };
    },
    // A throwing checkCompletion is not retried: the poll fails the stage and
    // the run, and a poll repeated after a fault must reach the same verdict.
    async checkCompletion() {
      polls++;
      throw new Error("completion read failure");
    },
  });
  return {
    workflow: new WorkflowBuilder(
      "sweep-legacy-check",
      "Legacy",
      "test",
      In,
      Out,
    )
      .pipe(stage)
      .build(),
    input: { value: 20 },
    validate: async (h, runId) => {
      const run = await h.persistence.getRun(runId);
      const failed = await h.persistence.getStage(runId, "legacy");
      return [
        ...(polls >= 1 ? [] : ["legacy checkCompletion never ran"]),
        ...(run?.status === "FAILED"
          ? []
          : [`a throwing checkCompletion ended the run ${run?.status}`]),
        ...(failed?.status === "FAILED" &&
        failed.errorMessage === "completion read failure"
          ? []
          : [
              `a throwing checkCompletion left the stage ${failed?.status}: ${failed?.errorMessage}`,
            ]),
      ];
    },
  };
}

function legacyCheckCompletionReadyOnSecondPoll(): SweepScenario {
  let polls = 0;
  const stage = defineAsyncBatchStage({
    id: "legacy-ready",
    name: "Legacy async batch",
    mode: "async-batch",
    schemas: { input: In, output: Out, config: noConfig },
    async execute(ctx) {
      return {
        suspended: true,
        state: {
          batchId: "legacy-ready",
          metadata: { value: ctx.input.value },
        },
      };
    },
    async checkCompletion() {
      polls++;
      return polls < 2
        ? { ready: false, nextCheckIn: 60_000 }
        : { ready: true, output: { value: 21 } };
    },
  });
  return {
    workflow: new WorkflowBuilder(
      "sweep-legacy-ready",
      "Legacy ready",
      "test",
      In,
      Out,
    )
      .pipe(stage)
      .build(),
    input: { value: 20 },
    validate: () => (polls >= 1 ? [] : ["legacy checkCompletion never ran"]),
  };
}

function nonRetryableStep(): SweepScenario {
  const calls = new Map<string, number>();
  const workflow = defineWorkflow("sweep-nonretry-step", { input: In })
    .stage("once", {
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        const value = await ctx.step.run(
          "permanent",
          async () => {
            calls.set(
              ctx.workflowRunId,
              (calls.get(ctx.workflowRunId) ?? 0) + 1,
            );
            throw new NonRetryableError("permanent step failure");
          },
          { retries: 3 },
        );
        return { output: { value } };
      },
    })
    .build();
  return {
    workflow,
    input: { value: 20 },
    validate: async (h, runId, { faulted }) => {
      const run = await h.persistence.getRun(runId);
      const runCalls = calls.get(runId) ?? 0;
      return [
        ...(runCalls >= 1 && (faulted || runCalls === 1)
          ? []
          : [`NonRetryableError step body ran ${runCalls} times`]),
        ...(run?.status === "FAILED"
          ? []
          : [`NonRetryableError step ended ${run?.status}`]),
      ];
    },
  };
}

function nonRetryableStageBody(): SweepScenario {
  const calls = new Map<string, number>();
  const workflow = defineWorkflow("sweep-nonretry-stage", { input: In })
    .stage("once", {
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        calls.set(ctx.workflowRunId, (calls.get(ctx.workflowRunId) ?? 0) + 1);
        throw new NonRetryableError("permanent stage failure");
      },
    })
    .build();
  return {
    workflow,
    input: { value: 20 },
    validate: async (h, runId, { faulted }) => {
      const run = await h.persistence.getRun(runId);
      const runCalls = calls.get(runId) ?? 0;
      return [
        ...(runCalls >= 1 && (faulted || runCalls === 1)
          ? []
          : [`NonRetryableError stage body ran ${runCalls} times`]),
        ...(run?.status === "FAILED"
          ? []
          : [`NonRetryableError stage ended ${run?.status}`]),
      ];
    },
  };
}

function retryStepDuringReplay(): SweepScenario {
  const calls = new Map<string, number>();
  const workflow = defineWorkflow("sweep-retry-step", { input: In })
    .stage("retry", {
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        const value = await ctx.step.run(
          "replayed",
          async () => {
            const count = (calls.get(ctx.workflowRunId) ?? 0) + 1;
            calls.set(ctx.workflowRunId, count);
            if (count < 3) throw new Error(`retry ${count}`);
            return ctx.input.value + 1;
          },
          { retries: 2, retryDelay: "1m" },
        );
        return { output: { value } };
      },
    })
    .build();
  return {
    workflow,
    input: { value: 20 },
    validate: async (h, runId) => {
      const stages = await h.persistence.getStagesByRun(runId);
      const row = (
        await Promise.all(stages.map((stage) => h.stepLedger.list(stage.id)))
      )
        .flat()
        .find((step) => step.stepId === "replayed");
      const runCalls = calls.get(runId) ?? 0;
      return [
        ...(runCalls >= 3 ? [] : [`retrying step ran only ${runCalls} times`]),
        ...(row?.status === "completed" && row.attempt >= 3
          ? []
          : [`retry row ended ${row?.status} at attempt ${row?.attempt}`]),
      ];
    },
  };
}

function oneDurableStep(): SweepScenario {
  const calls = new Map<string, number>();
  const completedReplays: string[] = [];
  let harness: SweepHarness | undefined;
  const workflow = defineWorkflow("sweep-one-durable-step", { input: In })
    .stage("once", {
      schemas: { input: In, output: Out, config: noConfig },
      async execute(ctx) {
        const value = await ctx.step.run("once", async () => {
          if (
            await wasStepAlreadyCompleted(
              harness,
              ctx.workflowRunId,
              "once",
              "once",
            )
          ) {
            completedReplays.push(ctx.workflowRunId);
          }
          calls.set(ctx.workflowRunId, (calls.get(ctx.workflowRunId) ?? 0) + 1);
          return ctx.input.value + 1;
        });
        return { output: { value } };
      },
    })
    .build();
  return {
    workflow,
    input: { value: 20 },
    onRunCreated(h) {
      harness = h;
    },
    validate: async (_h, runId) => [
      ...(calls.get(runId) ? [] : ["durable step body never ran"]),
      ...(completedReplays.includes(runId)
        ? ["completed durable step body ran again"]
        : []),
    ],
  };
}

/**
 * A case for a defect that is still open names it here and runs under
 * `it.fails`, so it goes red the day the defect is fixed: delete the entry
 * then. While an entry stands, that one case cannot catch a second defect.
 */
export const SCENARIOS: Record<string, SweepCase> = {
  "two sequential stages": { build: sequential },
  "a parallel group": { build: parallelGroup },
  "a sleep longer than the stuck-run threshold": {
    build: sleepLongerThanTheStuckThreshold,
  },
  "a poll that is ready on the third try": {
    build: pollUntilReady,
  },
  "a wait for a signal": {
    build: signal,
  },
  "a redrive from the start": { build: redriveFromStart },
  "an AI batch map with adoption": {
    build: () => batchMapScenario({ id: "sweep-ai-adopt", adoptable: true }),
  },
  "an AI batch map without adoption": {
    build: () =>
      batchMapScenario({ id: "sweep-ai-no-adopt", adoptable: false }),
  },
  "run.cancel during an AI batch poll": {
    build: () =>
      batchMapScenario({
        id: "sweep-cancel-during-poll",
        adoptable: true,
        cancelDuringPoll: true,
      }),
    // Finding 1: the global sweep's #3 write is run.create's completion of its
    // idempotency key. That write fails after the run transaction committed;
    // retrying creates an unreturned second run and the batch from the first
    // run is outside the cancellation target. The same focused fault fails on
    // Prisma; the default DB sweep omits run.create, so it is registered below.
    // Fixed on fix/idempotent-create: delete these entries when it is merged.
    knownDefect: {
      error:
        "run.create persistence.completeIdempotencyKey error returns no run after commit; retry creates a second run and strands the first run's batch",
      crash:
        "run.create persistence.commit crash leaves its idempotency key in progress after commit; retry creates a second run and strands the first run's batch",
    },
    databaseKnownFaults: [
      {
        mode: "error",
        command: "run.create",
        label: "persistence.completeIdempotencyKey",
        reason:
          "run.create completion-key error after commit creates a duplicate run on retry",
      },
      {
        mode: "crash",
        command: "run.create",
        label: "persistence.commit",
        reason:
          "run.create post-commit crash leaves an in-progress key and creates a duplicate run on retry",
      },
    ],
  },
  "run.cancel then redrive replaces the batch": {
    build: () =>
      batchMapScenario({
        id: "sweep-cancel-redrive",
        adoptable: true,
        cancelable: true,
        cancelDuringPoll: true,
        redriveAfterCancel: true,
      }),
    // Finding 2: the same run.create duplicate after an ambiguous completion
    // leaves a provider batch owned by an unreturned run; the tracked run is
    // cancelled and cannot redrive that batch. Fixed on fix/idempotent-create:
    // delete these entries when it is merged.
    knownDefect: {
      error:
        "run.create persistence.completeIdempotencyKey error returns no run after commit; retry leaves a batch owned by an unreturned run, so the tracked run cannot replace it",
      crash:
        "run.create persistence.commit crash leaves its idempotency key in progress after commit; retry leaves a batch owned by an unreturned run, so the tracked run cannot replace it",
    },
    databaseKnownFaults: [
      {
        mode: "error",
        command: "run.create",
        label: "persistence.completeIdempotencyKey",
        reason:
          "run.create completion-key error after commit creates a duplicate run and strands its provider batch",
      },
      {
        mode: "crash",
        command: "run.create",
        label: "persistence.commit",
        reason:
          "run.create post-commit crash leaves an in-progress key and strands its provider batch on retry",
      },
    ],
  },
  "a throwing legacy checkCompletion": { build: throwingLegacyCheckCompletion },
  "a legacy checkCompletion that is ready on the second poll": {
    build: legacyCheckCompletionReadyOnSecondPoll,
    // Finding 5: stage-poll-suspended.ts runs checkCompletion and the writes
    // that persist its answer (the not-ready commit, the output blob, the
    // ready commit) in one try block whose catch fails the stage and the run
    // with the thrown text. A single store error in those writes is
    // indistinguishable from a throwing checkCompletion and is not retried.
    // The durable-replay path retries such errors; a crash leaves the stage
    // SUSPENDED under its claim lease and passes. On main as well.
    knownDefect: {
      error:
        "a store error while stage.pollSuspended persists a legacy checkCompletion's answer (commit, output blob) fails the stage and the run",
    },
    databaseKnownDefect: {
      error:
        "a store error while stage.pollSuspended persists a legacy checkCompletion's answer (commit, output blob) fails the stage and the run",
    },
  },
  "a NonRetryableError from a step": { build: nonRetryableStep },
  "a NonRetryableError from a stage body": { build: nonRetryableStageBody },
  "a step that spends its retries during replay": {
    build: retryStepDuringReplay,
  },
  "a single durable step": { build: oneDurableStep },
};
