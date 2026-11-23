import { createLogger, isTraceTextEnabled } from "../utils/logger.js";
import { AICallTimeoutError } from "./errors.js";
import { UnportableSchemaError } from "./schema-portability.js";

const logger = createLogger("AIHelper");

/**
 * An AI call failure without its message, which can quote the request or a
 * provider's response: the error's name and HTTP status. Engine-made errors
 * carry no call text and keep their message.
 */
export function describeAICallError(error: unknown): string {
  if (
    error instanceof AICallTimeoutError ||
    error instanceof UnportableSchemaError
  )
    return error.message;
  let name: unknown;
  let status: unknown;
  try {
    ({ name, statusCode: status } = error as {
      name?: unknown;
      statusCode?: unknown;
    });
  } catch {
    // A hostile getter leaves the generic description.
  }
  const label =
    typeof name === "string" && /^[A-Za-z_$][\w$]{0,63}$/.test(name)
      ? `${name}: `
      : "";
  const http =
    typeof status === "number" && Number.isInteger(status)
      ? ` (HTTP ${status})`
      : "";
  return `${label}AI call failed${http}`;
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
 * `onStreamReadError` sees a stream that ends in a read rejection, which the
 * SDK reports to no callback; the error still reaches the SDK unchanged.
 */
export function protectProviderWarnings<T extends object>(
  model: T,
  onStreamReadError?: (error: unknown) => void,
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
      const result = await method.apply(model, args);
      if (key !== "doStream")
        return isTraceTextEnabled() ? result : { ...result, warnings: [] };
      return {
        ...result,
        stream: observeStream(result.stream, isTraceTextEnabled(), (error) =>
          onStreamReadError?.(error),
        ),
      };
    };
  });
}
