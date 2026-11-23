import { assertTimerMs } from "../kernel/helpers/host-support.js";
import type {
  AICallFlushOptions,
  AICallFlushResult,
} from "../persistence/interface.js";

export const DEFAULT_AI_FLUSH_TIMEOUT_MS = 5_000;

export class AICallWriteTracker {
  private pending = 0;
  private failed = 0;
  private readonly drained = new Set<() => void>();

  constructor(private readonly parent?: AICallWriteTracker) {}

  begin(): () => void {
    const endParent = this.parent?.begin();
    this.pending++;
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      this.pending--;
      endParent?.();
      if (this.pending === 0) {
        for (const resolve of this.drained) resolve();
      }
    };
  }

  fail(): void {
    this.failed++;
    this.parent?.fail();
  }

  async flush(options: AICallFlushOptions = {}): Promise<AICallFlushResult> {
    const timeoutMs = assertTimerMs(
      "timeoutMs",
      options.timeoutMs ?? DEFAULT_AI_FLUSH_TIMEOUT_MS,
      { allowZero: true },
    );
    if (this.pending > 0 && timeoutMs > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, timeoutMs);
      this.drained.add(resolve);
      try {
        await promise;
      } finally {
        clearTimeout(timer);
        this.drained.delete(resolve);
      }
    }
    return { failed: this.failed, pending: this.pending };
  }
}

/** Apply the caller's own bound even if a custom flush ignores it or throws. */
export async function boundedAIFlush(
  flush: (options: AICallFlushOptions) => Promise<AICallFlushResult | void>,
  timeoutMs: number,
): Promise<AICallFlushResult> {
  const work = (async () => {
    try {
      return (await flush({ timeoutMs })) ?? { failed: 0, pending: 0 };
    } catch {
      return { failed: 1, pending: 0 };
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AICallFlushResult>((resolve) => {
    timer = setTimeout(() => resolve({ failed: 0, pending: 1 }), timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
