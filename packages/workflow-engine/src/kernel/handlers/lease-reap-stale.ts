/**
 * Handler: lease.reapStale
 *
 * Releases stale job leases that have exceeded the threshold.
 */

import type { LeaseReapStaleCommand, LeaseReapStaleResult } from "../commands";
import type { HandlerResult, KernelDeps } from "../kernel";

export async function handleLeaseReapStale(
  command: LeaseReapStaleCommand,
  deps: KernelDeps,
): Promise<HandlerResult<LeaseReapStaleResult>> {
  const released = await deps.jobTransport.releaseStaleJobs(
    command.staleThresholdMs,
  );

  return { released, _events: [] };
}
