import { AICallTimeoutError } from "./errors.js";

export interface CallTimeout {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly timedOut: () => boolean;
  readonly error: AICallTimeoutError | undefined;
  race<T>(promise: PromiseLike<T>): Promise<T>;
  cleanup(): void;
}

/** Combine a caller signal with a deadline while retaining timeout identity. */
export function createCallTimeout(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  modelKey: string,
): CallTimeout {
  if (timeoutMs === undefined) {
    return {
      signal: callerSignal,
      timeoutMs,
      timedOut: () => false,
      error: undefined,
      race: (promise) => Promise.resolve(promise),
      cleanup: () => {},
    };
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("AI timeoutMs must be a finite, non-negative number");
  }

  const timeoutError = new AICallTimeoutError(timeoutMs, modelKey);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutReject: ((reason: unknown) => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutReject = reject;
  });

  const fallbackController =
    typeof AbortSignal.timeout === "function"
      ? undefined
      : new AbortController();
  const timeoutSignal =
    fallbackController?.signal ?? AbortSignal.timeout(timeoutMs);

  if (fallbackController) {
    timer = setTimeout(() => {
      timedOut = true;
      fallbackController.abort(timeoutError);
      timeoutReject?.(timeoutError);
    }, timeoutMs);
  }

  const onTimeoutAbort = () => {
    timedOut = true;
  };
  timeoutSignal.addEventListener("abort", onTimeoutAbort, { once: true });

  if (!fallbackController) {
    timer = setTimeout(() => {
      timedOut = true;
      timeoutReject?.(timeoutError);
    }, timeoutMs);
  }

  let signal: AbortSignal = fallbackController?.signal ?? timeoutSignal;
  let removeSignalListeners: (() => void) | undefined;
  if (callerSignal) {
    if (callerSignal.aborted) {
      signal = callerSignal;
    } else if (typeof AbortSignal.any === "function") {
      signal = AbortSignal.any([callerSignal, timeoutSignal]);
    } else {
      const controller = new AbortController();
      const forward = (source: AbortSignal) => {
        if (!controller.signal.aborted) controller.abort(source.reason);
      };
      const onCallerAbort = () => forward(callerSignal);
      const onDeadlineAbort = () => forward(timeoutSignal);
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      timeoutSignal.addEventListener("abort", onDeadlineAbort, {
        once: true,
      });
      removeSignalListeners = () => {
        callerSignal.removeEventListener("abort", onCallerAbort);
        timeoutSignal.removeEventListener("abort", onDeadlineAbort);
      };
      signal = controller.signal;
    }
  }

  return {
    signal,
    timeoutMs,
    timedOut: () => timedOut || timeoutSignal.aborted,
    error: timeoutError,
    race: <T>(promise: Promise<T>) => Promise.race([promise, timeoutPromise]),
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      timeoutSignal.removeEventListener("abort", onTimeoutAbort);
      removeSignalListeners?.();
      timeoutReject = undefined;
    },
  };
}

export async function runWithCallTimeout<T>(
  timeout: CallTimeout,
  operation: (signal?: AbortSignal) => PromiseLike<T>,
): Promise<T> {
  try {
    return await timeout.race(operation(timeout.signal));
  } catch (error) {
    if (timeout.timedOut() && timeout.error) throw timeout.error;
    throw error;
  }
}

export function timeoutErrorIfExpired(
  timeout: CallTimeout,
  error: unknown,
): unknown {
  return timeout.timedOut() && timeout.error ? timeout.error : error;
}
