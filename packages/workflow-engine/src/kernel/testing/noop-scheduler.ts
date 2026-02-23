import type { Scheduler } from "../ports";

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

  async cancel(
    _commandType: string,
    _correlationId: string,
  ): Promise<void> {
    // No-op in Phase 1
  }

  clear(): void {
    this.scheduled.length = 0;
  }
}
