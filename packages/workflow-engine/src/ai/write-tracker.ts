import { assertTimerMs } from "../kernel/helpers/host-support.js";
import type {
  AICallFlushOptions,
  AICallFlushResult,
} from "../persistence/interface.js";
import { traceProviderDiagnostic } from "./provider-diagnostics.js";

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

  /** Pending from now until `work` settles; the caller still sees its outcome. */
  track<T>(work: Promise<T>): Promise<T> {
    return work.finally(this.begin());
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
    return this.counts();
  }

  /** Failed writes so far and writes pending now. */
  counts(): AICallFlushResult {
    return { failed: this.failed, pending: this.pending };
  }
}

/**
 * Run a logger write that `writes` counts until it settles, or until the
 * write calls `release` to leave its counting to the logger that took it. A
 * failure is counted unless released and reported to `onFailure`; a
 * rejection reaches the caller as a safe error, because a database error can
 * quote the row it refused, and is handled when the caller ignores it. A
 * synchronous throw still reaches the caller, as in earlier releases.
 */
export function trackedWrite(
  writes: AICallWriteTracker,
  write: (release: () => void) => void | Promise<void>,
  onFailure: (error: unknown) => void = () => {},
): Promise<void> {
  const done = writes.begin();
  let counted = true;
  const release = () => {
    counted = false;
    done();
  };
  const failed = (error: unknown) => {
    if (counted) writes.fail();
    try {
      onFailure(error);
    } catch {
      // A reporting callback cannot change the result or block flush.
    }
    done();
  };
  let result: void | Promise<void>;
  try {
    result = write(release);
  } catch (error) {
    failed(error);
    throw error;
  }
  if (!result) {
    done();
    return Promise.resolve();
  }
  const tracked = Promise.resolve(result).then(done, (error: unknown) => {
    failed(error);
    traceProviderDiagnostic("AI call accounting write failed", error);
    throw new Error("AI call accounting write failed");
  });
  void tracked.catch(() => {});
  return tracked;
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
