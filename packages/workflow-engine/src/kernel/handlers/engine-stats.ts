/**
 * Handler: engine.stats
 *
 * The operator's answer to "is the engine keeping up?": how much work is
 * waiting, and how long the oldest of it has waited. It reads through two
 * optional port methods, `Persistence.getActiveWorkStats` and
 * `JobTransport.getJobStats`, each of which counts active rows only. A port
 * without its method has its sections reported as `{ available: false }`
 * rather than failing the command, so a custom adapter written before the
 * command existed keeps working and the gap is visible instead of reading as
 * zero.
 *
 * Read-only: no transaction, no outbox event, no idempotency key.
 */

import type { EngineStatsCommand, EngineStatsResult } from "../commands";
import type { HandlerResult, KernelDeps } from "../kernel";

export async function handleEngineStats(
  _command: EngineStatsCommand,
  deps: KernelDeps,
): Promise<HandlerResult<EngineStatsResult>> {
  const now = deps.clock.now();
  const [work, jobs] = await Promise.all([
    deps.persistence.getActiveWorkStats?.(now),
    deps.jobTransport.getJobStats?.(),
  ]);

  // A timestamp from a store whose clock runs ahead of the kernel's would
  // read as a negative age; report 0 rather than a nonsense figure.
  const ageMs = (since: Date | null): number | null =>
    since === null ? null : Math.max(0, now.getTime() - since.getTime());

  return {
    at: now,
    runs: work
      ? {
          available: true,
          byStatus: work.runs.byStatus,
          oldestPendingAgeMs: ageMs(work.runs.oldestPendingCreatedAt),
        }
      : { available: false },
    stages: work
      ? {
          available: true,
          byStatus: work.stages.byStatus,
          suspendedDue: work.stages.suspendedDue,
          mostOverdueMs: ageMs(work.stages.oldestSuspendedDueAt),
        }
      : { available: false },
    jobs: jobs
      ? {
          available: true,
          byStatus: jobs.byStatus,
          oldestPendingAgeMs: ageMs(jobs.oldestPendingCreatedAt),
        }
      : { available: false },
    outbox: work
      ? {
          available: true,
          unpublished: work.outbox.unpublished,
          oldestUnpublishedAgeMs: ageMs(work.outbox.oldestUnpublishedAt),
          deadLettered: work.outbox.deadLettered,
        }
      : { available: false },
    _events: [],
  };
}
