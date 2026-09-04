/**
 * Handler: lease.reapStale
 *
 * Reaps stale job leases using a two-tier expiry model:
 *  - Heartbeat tier (fine-grained): requeues PENDING jobs whose workers stopped
 *    calling touchJob, giving another worker a chance to pick them up.
 *  - Absolute tier (coarse backstop): fails RUNNING jobs whose claim duration
 *    exceeded the absolute timeout regardless of heartbeats, catching wedged
 *    workers that continue heartbeating.
 */

import type { LeaseReapStaleCommand, LeaseReapStaleResult } from "../commands";
import type { HandlerResult, KernelDeps } from "../kernel";

export async function handleLeaseReapStale(
  command: LeaseReapStaleCommand,
  deps: KernelDeps,
): Promise<HandlerResult<LeaseReapStaleResult>> {
  // Heartbeat tier first, so a *dead* worker's job is requeued for another
  // worker rather than dead-lettered by the cap below; only a job whose
  // worker is alive but wedged — still heartbeating, so still RUNNING with
  // a fresh lockedAt — survives to the absolute tier.
  const released = await deps.jobTransport.releaseStaleJobs(
    command.staleThresholdMs,
  );

  let expired = 0;
  if (command.absoluteTimeoutMs && deps.jobTransport.expireRunawayJobs) {
    expired = await deps.jobTransport.expireRunawayJobs(
      command.absoluteTimeoutMs,
    );
  }

  return { released, expired, _events: [] };
}
