// packages/workflow-engine-host-serverless/src/run-to-completion.ts
import {
  executeJobWithHeartbeat,
  HOST_DEFAULTS,
  type JobTransport,
  type Kernel,
  type RunCreateCommand,
} from "@bratsos/workflow-engine/kernel";

/** The one read `runToCompletion` needs: how did the run end. */
export interface RunToCompletionPersistence {
  getRun(id: string): Promise<{
    status: string;
    output: unknown | null;
  } | null>;
}

/**
 * Why `runToCompletion` stopped.
 *
 * The first three are the run's own terminal states. The last two are not
 * failures — they say the run is still alive and something else has to carry
 * it, which is the honest answer for a helper that must return inside a
 * request.
 */
export type RunToCompletionOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  /** A stage suspended (a durable sleep, wait or signal). See the caveats. */
  | "suspended"
  /** The budget ran out, or nothing was runnable yet. See `reason`. */
  | "incomplete";

export interface RunToCompletionResult {
  workflowRunId: string;
  /** The run's persisted status when the helper returned. */
  status: string;
  outcome: RunToCompletionOutcome;
  /** The run's output, when it completed. */
  output?: unknown;
  /** Plain-language explanation, always present when `outcome` is not terminal. */
  reason?: string;
  /** Jobs executed by this call, this run's and other callers' alike. */
  jobsProcessed: number;
  /**
   * How many of `jobsProcessed` belonged to a different run. Non-zero means
   * this call did work on someone else's behalf — see the shared-queue
   * caveat.
   */
  foreignJobsProcessed: number;
  /** The stage that suspended, when `outcome` is `"suspended"`. */
  suspendedStageId?: string;
}

export interface RunToCompletionOptions {
  kernel: Kernel;
  /** The same transport the kernel enqueues onto. */
  jobTransport: JobTransport;
  /** Read port for the run's final status. */
  persistence: RunToCompletionPersistence;
  /** The run to create, exactly as `kernel.dispatch` takes it. */
  command: RunCreateCommand;
  /** Worker id used for the claim and the job leases. Defaults to `"run-to-completion"`. */
  workerId?: string;
  /**
   * Hard cap on jobs this call executes. Defaults to 50. Reaching it returns
   * `outcome: "incomplete"`; it never throws and never loops past the cap.
   */
  maxJobs?: number;
  /**
   * How many `run.claimPending` rounds to spend looking for this run's first
   * job. Defaults to 5. Each round claims up to `claimsPerRound` pending
   * runs — including other callers' (see the caveats).
   */
  maxClaimRounds?: number;
  /** Pending runs claimed per round. Defaults to 10. */
  claimsPerRound?: number;
  /** Job lease heartbeat interval. Defaults to `HOST_DEFAULTS.jobHeartbeatIntervalMs`. */
  jobHeartbeatIntervalMs?: number;
  /**
   * Publish the run's outbox events before returning (default true), so a
   * caller that returns the result straight to an HTTP client has already
   * announced the run.
   */
  flushOutbox?: boolean;
  /** Max events published by that final flush. Defaults to 100. */
  maxOutboxFlush?: number;
  /** Log prefix for the job loop. Defaults to `"[runToCompletion]"`. */
  logPrefix?: string;
}

const TERMINAL: Record<string, RunToCompletionOutcome> = {
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

/**
 * Create a workflow run and drive it to a terminal state inside the calling
 * request — the drain loop every caller writes by hand, exactly once.
 *
 * It creates the run, claims it, then dequeues and executes jobs through the
 * same `executeJobWithHeartbeat` the hosts use, until the run is terminal,
 * a stage suspends, nothing more is runnable, or a bound trips.
 *
 * ## Three things to know before you use it
 *
 * **1. It shares the queue, so it can execute another caller's job.** The
 * kernel's queue is global: `run.claimPending` claims whichever runs are
 * pending, and `dequeue()` returns whichever job is next — neither can be
 * narrowed to one run. So this call may start other callers' runs and
 * execute their jobs against its own budget, and their work lands inside
 * your request's latency and error budget. `foreignJobsProcessed` reports
 * how much of that happened. If it matters, give this call a kernel wired to
 * its own `jobTransport` (an in-request queue) so the only jobs it can see
 * are the ones it created.
 *
 * **2. It cannot complete a workflow that suspends.** A durable sleep, wait
 * or signal parks the stage until a later poll, which by definition is not
 * this request. Rather than spin — polling a clock that has not moved, or
 * sleeping inside a request handler — it returns immediately with
 * `outcome: "suspended"` and the stage that parked. The run is healthy and
 * unfinished: a background host or a scheduled maintenance tick resumes it.
 * Workflows you intend to run this way should have no durable waits.
 *
 * **3. It is bounded, never an unbounded loop.** `maxJobs` caps the jobs one
 * call executes and `maxClaimRounds` caps the search for this run's first
 * job. Hitting either returns `outcome: "incomplete"` with a `reason`; it
 * does not throw, and it does not keep going. The same is true when a stage
 * fails and is re-enqueued with a retry backoff: the job is not due yet, the
 * queue is empty, and the call returns `"incomplete"` rather than waiting.
 *
 * It also deliberately does not poll suspended stages or reap stale leases.
 * Those are maintenance, they are what would make it spin, and
 * `host.runMaintenanceTick()` already owns them.
 *
 * @example
 * ```typescript
 * const result = await runToCompletion({
 *   kernel,
 *   jobTransport,
 *   persistence,
 *   command: {
 *     type: "run.create",
 *     idempotencyKey: `checkout:${orderId}`,
 *     workflowId: "checkout",
 *     input: { orderId },
 *   },
 * });
 *
 * if (result.outcome === "completed") return Response.json(result.output);
 * if (result.outcome === "suspended") return new Response(null, { status: 202 });
 * return new Response(result.reason ?? "run failed", { status: 500 });
 * ```
 */
export async function runToCompletion(
  options: RunToCompletionOptions,
): Promise<RunToCompletionResult> {
  const {
    kernel,
    jobTransport,
    persistence,
    command,
    workerId = "run-to-completion",
    maxJobs = 50,
    maxClaimRounds = 5,
    claimsPerRound = 10,
    jobHeartbeatIntervalMs = HOST_DEFAULTS.jobHeartbeatIntervalMs,
    flushOutbox = true,
    maxOutboxFlush = HOST_DEFAULTS.maxOutboxFlushPerTick,
    logPrefix = "[runToCompletion]",
  } = options;

  const created = await kernel.dispatch(command);
  const workflowRunId = created.workflowRunId;

  let jobsProcessed = 0;
  let foreignJobsProcessed = 0;
  let suspendedStageId: string | undefined;
  let reason: string | undefined;

  // Claim until this run is claimed. Each round may also claim other
  // callers' pending runs; that is the queue being shared, not a bug, and it
  // is why the round count is bounded.
  let claimed = false;
  for (let round = 0; round < maxClaimRounds && !claimed; round++) {
    const result = await kernel.dispatch({
      type: "run.claimPending",
      workerId,
      maxClaims: claimsPerRound,
    });
    claimed = result.claimed.some(
      (entry) => entry.workflowRunId === workflowRunId,
    );
    // Nothing left to claim and it still was not ours: another worker took
    // it, and its jobs are that worker's to run.
    if (!claimed && result.claimed.length === 0) break;
  }
  if (!claimed) {
    reason =
      `run ${workflowRunId} was not claimed within ${maxClaimRounds} claim round(s): ` +
      `another worker claimed it, and it will finish there`;
  }

  while (claimed && jobsProcessed < maxJobs) {
    const job = await jobTransport.dequeue();
    if (!job) {
      reason = `no runnable job remained (${jobsProcessed} executed)`;
      break;
    }

    const outcome = await executeJobWithHeartbeat(kernel, {
      jobTransport,
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
      jobHeartbeatIntervalMs,
      logPrefix,
    });

    jobsProcessed++;
    const mine = job.workflowRunId === workflowRunId;
    if (!mine) foreignJobsProcessed++;

    if (mine && outcome.outcome === "suspended") {
      suspendedStageId = job.stageId;
      reason =
        `stage "${job.stageId}" suspended on a durable wait; the run resumes on a ` +
        `later poll, not in this request`;
      break;
    }
  }
  if (claimed && jobsProcessed >= maxJobs && !suspendedStageId) {
    reason = `job budget of ${maxJobs} exhausted before the run finished`;
  }

  if (flushOutbox) {
    // Best effort: the events are already durable in the outbox, and a
    // publish failure must not turn a finished run into a thrown request.
    try {
      await kernel.dispatch({
        type: "outbox.flush",
        maxEvents: maxOutboxFlush,
      });
    } catch (error) {
      console.error(`${logPrefix} outbox.flush failed:`, error);
    }
  }

  const record = await persistence.getRun(workflowRunId);
  const status = record?.status ?? "UNKNOWN";
  const terminal = TERMINAL[status];

  if (terminal) {
    return {
      workflowRunId,
      status,
      outcome: terminal,
      ...(record?.output != null ? { output: record.output } : {}),
      jobsProcessed,
      foreignJobsProcessed,
    };
  }

  return {
    workflowRunId,
    status,
    outcome: suspendedStageId ? "suspended" : "incomplete",
    reason: reason ?? `the run is still ${status}`,
    jobsProcessed,
    foreignJobsProcessed,
    ...(suspendedStageId ? { suspendedStageId } : {}),
  };
}
