import type { Scheduler } from "../ports";

/**
 * @deprecated The kernel no longer requires a `Scheduler` —
 * `KernelConfig.scheduler`/`KernelDeps.scheduler` are optional and the
 * kernel supplies its own internal no-op when one is omitted. The
 * `Scheduler` port itself is unused (zero `schedule()`/`cancel()` call
 * sites in the kernel). This class is kept only so existing fixtures that
 * still construct `new NoopScheduler()` keep working; it will be removed
 * at 1.0.
 */
export class NoopScheduler implements Scheduler {
  readonly scheduled: Array<{
    commandType: string;
    payload: unknown;
    runAt: Date;
  }> = [];

  async schedule(
    commandType: string,
    payload: unknown,
    runAt: Date,
  ): Promise<void> {
    this.scheduled.push({ commandType, payload, runAt });
  }

  async cancel(_commandType: string, _correlationId: string): Promise<void> {
    // No-op in Phase 1
  }

  clear(): void {
    this.scheduled.length = 0;
  }
}
