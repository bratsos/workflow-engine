import { withholdErrorText } from "../kernel/helpers/error-message.js";
import { createLogger, isTraceTextEnabled } from "../utils/logger.js";
import { AICallTimeoutError } from "./errors.js";
import { UnportableSchemaError } from "./schema-portability.js";

const logger = createLogger("AIHelper");

/**
 * Leave an AI call failure unchanged for the caller and the SDK. Under a
 * policy that withholds text, mark it so the engine's own outputs describe it
 * instead of repeating its message. Engine-made errors carry no call text.
 */
export function markAICallError<T>(
  ctx: { readonly withholdsText?: boolean },
  error: T,
): T {
  if (
    ctx.withholdsText &&
    !(error instanceof AICallTimeoutError) &&
    !(error instanceof UnportableSchemaError)
  )
    withholdErrorText(error);
  return error;
}

export function traceProviderDiagnostic(
  message: string,
  detail: unknown,
): void {
  if (!isTraceTextEnabled()) return;
  let text: string;
  try {
    text = detail instanceof Error ? detail.message : String(detail);
  } catch {
    text = "Unprintable error";
  }
  logger.debug(message, { detail: text });
}

/**
 * Forward every read to `target`, replacing what `override` returns. A fresh
 * proxy target keeps frozen targets usable: their own members would bind
 * the proxy to report them unchanged.
 */
export function forwardingProxy<T extends object>(
  target: T,
  override: (key: string | symbol, value: unknown) => unknown,
): T {
  return new Proxy(Object.create(Object.getPrototypeOf(target)) as T, {
    get(_, key) {
      const value: unknown = Reflect.get(target, key, target);
      const replaced = override(key, value);
      if (replaced !== value) return replaced;
      return typeof value === "function" ? value.bind(target) : value;
    },
    has: (_, key) => Reflect.has(target, key),
  });
}

function observeStream<T extends { type: string }>(
  stream: ReadableStream<T>,
  keepWarnings: boolean,
  onReadError: (error: unknown) => void,
): ReadableStream<T> {
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        onReadError(error);
        controller.error(error);
        return;
      }
      if (next.done) controller.close();
      else if (next.value.type === "stream-start" && !keepWarnings)
        controller.enqueue({ ...next.value, warnings: [] });
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/**
 * The SDK emits provider warnings via a process-wide logger. Remove warning
 * text at the provider boundary to leave unrelated SDK callers' settings alone.
 * `onStreamError` sees a stream that ends in a read rejection, which the SDK
 * reports to no callback; the error still reaches the SDK unchanged.
 */
export function protectProviderWarnings<T extends object>(
  model: T,
  onStreamError?: { call?(error: unknown): void; read?(error: unknown): void },
): T {
  return forwardingProxy(model, (key, method) => {
    if (
      typeof method !== "function" ||
      (key !== "doGenerate" &&
        key !== "doEmbed" &&
        key !== "doEvaluate" &&
        key !== "doStream")
    )
      return method;
    return async (...args: unknown[]) => {
      if (key !== "doStream") {
        const result = await method.apply(model, args);
        return isTraceTextEnabled() ? result : { ...result, warnings: [] };
      }
      let result: { stream: ReadableStream<{ type: string }> };
      try {
        result = await method.apply(model, args);
      } catch (error) {
        onStreamError?.call?.(error);
        throw error;
      }
      return {
        ...result,
        stream: observeStream(result.stream, isTraceTextEnabled(), (error) =>
          onStreamError?.read?.(error),
        ),
      };
    };
  });
}
