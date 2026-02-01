/**
 * Internal logger utility for workflow-engine
 *
 * This logger respects the WORKFLOW_ENGINE_TRACE environment variable.
 * Set WORKFLOW_ENGINE_TRACE=1 or WORKFLOW_ENGINE_TRACE=true to enable trace logging.
 *
 * WARNING: Trace mode logs sensitive data including:
 * - AI prompts before sending to providers (generateText, generateObject, embed, streamText)
 * - AI responses with full text content
 * - Token counts and cost breakdowns
 * - Batch operation requests and results
 * - Stage inputs and outputs (truncated to 1000 chars)
 * - Suspension state details
 * - Full error stacks
 *
 * Only enable in development/debugging scenarios. Never in production.
 *
 * Consumers can safely ignore trace logs by not setting this env variable.
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

function formatMessage(prefix: string, message: string): string {
  return `[${prefix}] ${message}`;
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
    debug: (message: string, ...args: unknown[]) => {
      if (isTraceEnabled()) {
        console.log(formatMessage(prefix, message), ...args);
      }
    },
    info: (message: string, ...args: unknown[]) => {
      if (isTraceEnabled()) {
        console.log(formatMessage(prefix, message), ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      console.warn(formatMessage(prefix, message), ...args);
    },
    error: (message: string, ...args: unknown[]) => {
      console.error(formatMessage(prefix, message), ...args);
    },
  };
}

/**
 * Silent logger that never outputs anything
 * Useful for testing or when you want to completely suppress logging
 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
