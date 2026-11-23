export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = Record<
  LogLevel,
  (message: string, fields?: Record<string, unknown>) => void
>;

const loggerKey = Symbol.for("@bratsos/workflow-engine/logger");
const processScope = globalThis as typeof globalThis & { [loggerKey]?: Logger };

/** Install a logger for this process. Pass undefined to restore the console sink. */
export function setLogger(logger: Logger | undefined): void {
  processScope[loggerKey] = logger;
}

function envFlag(name: string): boolean {
  const value = typeof process === "undefined" ? undefined : process.env[name];
  return value === "1" || value === "true";
}

export function isTraceTextEnabled(): boolean {
  return (
    envFlag("WORKFLOW_ENGINE_TRACE_TEXT") &&
    (processScope[loggerKey] !== undefined || envFlag("WORKFLOW_ENGINE_TRACE"))
  );
}

type Fields = Record<string, unknown>;
type ConsoleOutput = () => [message: string, ...args: unknown[]];

const previewFields = new Set([
  "prompt",
  "response",
  "textPreview",
  "audio",
  "input",
  "output",
  "responseBody",
]);

function withoutPreviews(fields: Fields): Fields {
  const entries = Object.entries(fields);
  return entries.some(([key]) => previewFields.has(key))
    ? Object.fromEntries(entries.filter(([key]) => !previewFields.has(key)))
    : fields;
}

/**
 * Create a logger with an optional namespace. Existing instances use the current sink.
 * @internal Used by the host packages; applications use `setLogger`.
 */
export function createLogger(
  prefix?: string,
  consoleFields: (fields: Fields) => Fields = (fields) => fields,
) {
  const format = (message: string) =>
    prefix ? `[${prefix}] ${message}` : message;

  function write(level: LogLevel) {
    return (
      message: string,
      fields?: Fields,
      consoleOutput?: ConsoleOutput,
    ): void => {
      const method = level === "debug" || level === "info" ? "log" : level;
      const redactTrace = method === "log" && !isTraceTextEnabled();
      const formatLine = (line: string) =>
        format(
          redactTrace && prefix === "JobQueue"
            ? line.replace(/^(Job .+? failed permanently):[\s\S]*$/, "$1")
            : line,
        );
      const fallback = () => {
        try {
          if (method === "log" && !envFlag("WORKFLOW_ENGINE_TRACE")) return;
          const [line, ...args] =
            consoleOutput?.() ??
            (fields === undefined
              ? [message]
              : [message, consoleFields(fields)]);
          console[method](
            formatLine(line),
            ...args.map((arg) =>
              redactTrace &&
              arg !== null &&
              typeof arg === "object" &&
              !Array.isArray(arg)
                ? withoutPreviews(arg as Fields)
                : arg,
            ),
          );
        } catch {
          // Diagnostics cannot interrupt engine work.
        }
      };

      const sink = processScope[loggerKey];
      if (sink) {
        try {
          const result: unknown =
            fields === undefined
              ? sink[level](formatLine(message))
              : sink[level](
                  formatLine(message),
                  redactTrace ? withoutPreviews(fields) : fields,
                );
          // A callback typed as void can still be implemented as async.
          if (result) void Promise.resolve(result).catch(fallback);
          return;
        } catch {
          // Fall back once for this entry and keep the configured sink.
        }
      }
      fallback();
    };
  }

  const error = write("error");
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error,
    /** Preserve the original error in structured fields and console output. */
    caught(message: string, cause: unknown, fields?: Fields): void {
      error(message, { ...fields, error: cause }, () => [message, cause]);
    },
  };
}
