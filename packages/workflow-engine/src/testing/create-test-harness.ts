/**
 * `createTestHarness` — an in-memory kernel plus the driver loop every
 * workflow test needs.
 *
 * `createTestKernel` wires the ports; this adds the part each consumer used
 * to hand-roll: create a run, claim it, dequeue and execute its jobs through
 * the real host loop (`executeJobWithHeartbeat`), poll suspended stages so
 * durable stages replay, flush the outbox, and advance the fake clock to the
 * next poll deadline when nothing else can run — until the run is terminal.
 *
 * @example
 * ```typescript
 * import { createTestHarness } from "@bratsos/workflow-engine/testing";
 *
 * const h = createTestHarness({ workflows: [myWorkflow] });
 * h.mockAi.setTextResponse("summarize", { text: "ok" });
 *
 * const result = await h.run("my-workflow", { docId: "doc-1" });
 * expect(result.status).toBe("COMPLETED");
 * expect(result.output).toEqual({ summary: "ok" });
 * ```
 */

import {
  createMockAIHelperFactory,
  type MockAIHelperFactory,
} from "../__tests__/utils/mock-ai-helper.js";
import type { Workflow } from "../core/workflow.js";
import {
  executeJobWithHeartbeat,
  HOST_DEFAULTS,
} from "../kernel/helpers/host-support.js";
import type { PluginDefinition } from "../kernel/plugins.js";
import type { EventSink, KernelServices, StepLedger } from "../kernel/ports.js";
import type { FakeClock } from "../kernel/testing/fake-clock.js";
import { FakeClock as FakeClockImpl } from "../kernel/testing/fake-clock.js";
import type { InMemoryBlobStore } from "../kernel/testing/in-memory-blob-store.js";
import type { Status, WorkflowRunRecord } from "../persistence/interface.js";
import { createTestKernel } from "./create-test-kernel.js";
import { InMemoryAICallLogger } from "./in-memory-ai-logger.js";
import { InMemoryStepLedger } from "./in-memory-step-ledger.js";

/** What one `tick()` did. Every count is for that round only. */
export interface TickReport {
  /** Pending runs claimed (first-stage jobs enqueued). */
  claimed: number;
  /** Jobs dequeued and executed this round. */
  executed: number;
  /** Per-job outcome, in execution order. */
  outcomes: Array<{
    stageId: string;
    outcome: "completed" | "suspended" | "failed";
    error?: string;
  }>;
  /** Suspended stages checked by `stage.pollSuspended`. */
  suspendedChecked: number;
  /** Suspended stages that resumed (their run was transitioned). */
  resumed: number;
  /** Outbox events published. */
  eventsFlushed: number;
  /** Milliseconds the fake clock was advanced because nothing was runnable. */
  advancedMs: number;
  /** True when the round did no work at all and advanced no time. */
  idle: boolean;
}

/** Terminal state of a run driven by `harness.run()`. */
export interface HarnessRunResult<TOutput = unknown> {
  workflowRunId: string;
  status: Status;
  output?: TOutput;
  error?: string;
  /** Rounds of `tick()` the run needed. */
  ticks: number;
  reports: TickReport[];
  run: WorkflowRunRecord;
}

export interface CreateTestHarnessOptions {
  /** Workflows registered with the kernel. */
  workflows?: Workflow<any, any>[];
  /**
   * Kernel services. `aiLogger` and `ai` default to the harness's
   * `InMemoryAICallLogger` and `createMockAIHelperFactory()`; anything you
   * pass wins.
   */
  services?: Partial<KernelServices>;
  /** Fake clock to use. Defaults to a fresh `FakeClock`. */
  clock?: FakeClock;
  /** Step ledger. Defaults to an `InMemoryStepLedger` on the harness clock. */
  stepLedger?: StepLedger;
  /** Blob store. Defaults to an `InMemoryBlobStore`. */
  blobStore?: InMemoryBlobStore;
  /** AI call logger. Defaults to a fresh `InMemoryAICallLogger`. */
  aiLogger?: InMemoryAICallLogger;
  /** Mock AI factory. Defaults to `createMockAIHelperFactory()`. */
  mockAi?: MockAIHelperFactory;
  /** Worker id used for `run.claimPending` and the job queue. */
  workerId?: string;
  /** Event sink override; otherwise a `CollectingEventSink`. */
  eventSink?: EventSink;
  /** Plugins wired through a plugin runner. Ignored when `eventSink` is set. */
  plugins?: PluginDefinition[];
  /** Guard for `run()`. Defaults to 100. */
  maxTicks?: number;
  /**
   * How far to advance the clock when nothing is runnable and no suspended
   * stage declares a `nextPollAt`. Defaults to one second.
   */
  idleAdvanceMs?: number;
}

const TERMINAL: ReadonlySet<Status> = new Set<Status>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export function createTestHarness(options: CreateTestHarnessOptions = {}) {
  const clock = options.clock ?? new FakeClockImpl();
  const aiLogger = options.aiLogger ?? new InMemoryAICallLogger();
  const mockAi = options.mockAi ?? createMockAIHelperFactory();
  const stepLedger =
    options.stepLedger ?? new InMemoryStepLedger({ now: () => clock.now() });
  const workerId = options.workerId ?? "test-worker";
  const maxTicks = options.maxTicks ?? 100;
  const idleAdvanceMs = options.idleAdvanceMs ?? 1_000;

  const base = createTestKernel(options.workflows ?? [], {
    clock,
    workerId,
    stepLedger,
    ...(options.blobStore ? { blobStore: options.blobStore } : {}),
    services: {
      aiLogger,
      ai: mockAi,
      ...options.services,
    } as KernelServices,
    ...(options.eventSink ? { eventSink: options.eventSink } : {}),
    ...(options.plugins ? { plugins: options.plugins } : {}),
  });

  const { kernel, persistence, jobTransport: jobQueue } = base;
  let runCounter = 0;

  /** Earliest `nextPollAt` across every suspended stage of the given runs. */
  async function earliestNextPollAt(
    workflowRunIds: string[],
  ): Promise<Date | undefined> {
    let earliest: Date | undefined;
    for (const runId of workflowRunIds) {
      const stages = await persistence.getStagesByRun(runId, {
        status: "SUSPENDED",
      });
      for (const stage of stages) {
        if (!stage.nextPollAt) continue;
        if (!earliest || stage.nextPollAt.getTime() < earliest.getTime()) {
          earliest = stage.nextPollAt;
        }
      }
    }
    return earliest;
  }

  /**
   * One round: claim, execute every runnable job, poll suspended stages,
   * flush the outbox, and — only when none of that did anything — advance
   * the clock to the next poll deadline.
   */
  async function tick(watchRunIds: string[] = []): Promise<TickReport> {
    const report: TickReport = {
      claimed: 0,
      executed: 0,
      outcomes: [],
      suspendedChecked: 0,
      resumed: 0,
      eventsFlushed: 0,
      advancedMs: 0,
      idle: false,
    };

    const claim = await kernel.dispatch({
      type: "run.claimPending",
      workerId,
      maxClaims: 50,
    });
    report.claimed = claim.claimed.length;

    for (;;) {
      const job = await jobQueue.dequeue();
      if (!job) break;
      const outcome = await executeJobWithHeartbeat(kernel, {
        jobTransport: jobQueue,
        job: {
          jobId: job.jobId,
          workflowRunId: job.workflowRunId,
          workflowId: job.workflowId,
          stageId: job.stageId,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
          payload: job.payload,
        },
        jobHeartbeatIntervalMs: HOST_DEFAULTS.jobHeartbeatIntervalMs,
        logPrefix: "[TestHarness]",
      });
      report.executed++;
      report.outcomes.push({
        stageId: job.stageId,
        outcome: outcome.outcome,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    }

    const polled = await kernel.dispatch({
      type: "stage.pollSuspended",
      maxChecks: 50,
    });
    report.suspendedChecked = polled.checked;
    report.resumed = polled.resumedWorkflowRunIds.length;
    for (const workflowRunId of polled.resumedWorkflowRunIds) {
      await kernel.dispatch({ type: "run.transition", workflowRunId });
    }

    const flushed = await kernel.dispatch({
      type: "outbox.flush",
      maxEvents: 500,
    });
    report.eventsFlushed = flushed.published;

    const didWork =
      report.claimed > 0 ||
      report.executed > 0 ||
      report.resumed > 0 ||
      report.eventsFlushed > 0;
    if (!didWork) {
      const next = await earliestNextPollAt(watchRunIds);
      const now = clock.now().getTime();
      const advanceMs =
        next && next.getTime() > now
          ? next.getTime() - now + 1
          : watchRunIds.length > 0
            ? idleAdvanceMs
            : 0;
      if (advanceMs > 0) {
        clock.advance(advanceMs);
        report.advancedMs = advanceMs;
      } else {
        report.idle = true;
      }
    }

    return report;
  }

  /** The error of the first FAILED stage — what made a failed run fail. */
  async function firstStageError(
    workflowRunId: string,
    status: Status,
  ): Promise<string | undefined> {
    if (status !== "FAILED") return undefined;
    const failed = await persistence.getStagesByRun(workflowRunId, {
      status: "FAILED",
    });
    return failed[0]?.errorMessage ?? undefined;
  }

  /**
   * Create a run and drive ticks until it is terminal (or `maxTicks` trips,
   * which throws — a wedged run is a test failure, not a silent pass).
   */
  async function run<TOutput = unknown>(
    workflowId: string,
    input: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<HarnessRunResult<TOutput>> {
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: `harness:${workflowId}:${runCounter++}`,
      workflowId,
      input,
      ...(config ? { config } : {}),
    });
    const workflowRunId = created.workflowRunId;
    const reports: TickReport[] = [];

    for (let i = 0; i < maxTicks; i++) {
      reports.push(await tick([workflowRunId]));
      const record = await persistence.getRun(workflowRunId);
      if (record && TERMINAL.has(record.status)) {
        const error = await firstStageError(workflowRunId, record.status);
        return {
          workflowRunId,
          status: record.status,
          output: record.output as TOutput | undefined,
          ...(error ? { error } : {}),
          ticks: i + 1,
          reports,
          run: record,
        };
      }
    }

    const record = await persistence.getRun(workflowRunId);
    throw new Error(
      `createTestHarness: run ${workflowRunId} did not reach a terminal state ` +
        `within ${maxTicks} ticks (status ${record?.status ?? "unknown"}).`,
    );
  }

  return {
    ...base,
    /** Alias matching the port name consumers use in assertions. */
    jobQueue,
    stepLedger,
    aiLogger,
    mockAi,
    clock,
    tick,
    run,
  };
}
