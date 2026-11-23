/**
 * Internal logger utility for workflow-engine
 *
 * This logger respects the WORKFLOW_ENGINE_TRACE environment variable.
 * Set WORKFLOW_ENGINE_TRACE=1 or WORKFLOW_ENGINE_TRACE=true to enable trace logging.
 *
 * Add WORKFLOW_ENGINE_TRACE_TEXT=1 to include sensitive request and
 * response data. Use both flags only when debugging with safe data.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

function isTraceEnabled(): boolean {
  if (typeof process === "undefined") return false;
  const trace = process.env.WORKFLOW_ENGINE_TRACE;
  return trace === "1" || trace === "true";
}

export function isTraceTextEnabled(): boolean {
  return isTraceEnabled() && process.env.WORKFLOW_ENGINE_TRACE_TEXT === "1";
}

const textFields = new Set([
  "prompt",
  "response",
  "textPreview",
  "audio",
  "input",
  "output",
  "responseBody",
]);

function traceArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (arg === null || typeof arg !== "object" || Array.isArray(arg))
      return arg;
    const entries = Object.entries(arg);
    return entries.some(([key]) => textFields.has(key))
      ? Object.fromEntries(entries.filter(([key]) => !textFields.has(key)))
      : arg;
  });
}

function formatMessage(prefix: string, message: string): string {
  return `[${prefix}] ${message}`;
}

function trace(prefix: string, message: string, args: unknown[]): void {
  if (!isTraceEnabled()) return;
  if (!isTraceTextEnabled()) {
    // The permanent-failure trace predates structured log arguments and
    // appends the job's error string directly to the message.
    if (prefix === "JobQueue") {
      message = message.replace(/^(Job .+? failed permanently):[\s\S]*$/, "$1");
    }
    args = traceArgs(args);
  }
  console.log(formatMessage(prefix, message), ...args);
}

/**
 * Create a namespaced logger
 *
 * @param prefix - The prefix to use for log messages (e.g., "Executor", "Runtime")
 * @returns A logger instance with debug, info, warn, and error methods
 *
 * @example
 * ```typescript
 * const logger = createLogger("Executor");
 * logger.debug("Starting execution"); // Only logs if WORKFLOW_ENGINE_TRACE=1
 * logger.error("Failed to execute"); // Always logs
 * ```
 */
export function createLogger(prefix: string): Logger {
  return {
    debug: (message: string, ...args: unknown[]) =>
      trace(prefix, message, args),
    info: (message: string, ...args: unknown[]) => trace(prefix, message, args),
    warn: (message: string, ...args: unknown[]) => {
      console.warn(formatMessage(prefix, message), ...args);
    },
    error: (message: string, ...args: unknown[]) => {
      console.error(formatMessage(prefix, message), ...args);
    },
  };
}
