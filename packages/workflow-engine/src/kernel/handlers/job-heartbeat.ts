/**
 * Handler: job.heartbeat
 *
 * One beat of a host's job lease heartbeat. Renews the lease through the
 * job transport and reports what the host cannot otherwise see from its
 * loop: whether the run is still RUNNING and whether this worker still
 * holds the job. The host aborts the stage's `abortSignal` on either
 * answer being no, so a running body learns about a cancellation while it
 * is still running instead of having its outcome rejected afterwards.
 *
 * Read-only apart from the lease touch: no transaction, no outbox events.
 */

import type { JobHeartbeatCommand, JobHeartbeatResult } from "../commands";
import type { HandlerResult, KernelDeps } from "../kernel";

export async function handleJobHeartbeat(
  command: JobHeartbeatCommand,
  deps: KernelDeps,
): Promise<HandlerResult<JobHeartbeatResult>> {
  // The touch is a no-op on a row that is not RUNNING; the row read below
  // is what reports that.
  await deps.jobTransport.touchJob(command.jobId);

  const [runStatus, jobs] = await Promise.all([
    deps.persistence.getRunStatus(command.workflowRunId),
    deps.jobTransport.getJobsByWorkflowRun(command.workflowRunId),
  ]);
  const job = jobs.find((row) => row.id === command.jobId);
  const leaseHeld =
    job !== undefined &&
    job.status === "RUNNING" &&
    (command.attempt === undefined || job.attempt === command.attempt);

  return { runStatus, leaseHeld, _events: [] };
}
