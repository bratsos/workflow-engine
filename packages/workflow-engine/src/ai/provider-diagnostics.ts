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
