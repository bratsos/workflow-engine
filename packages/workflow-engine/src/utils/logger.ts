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
  return envFlag("WORKFLOW_ENGINE_TRACE_TEXT");
}

type Fields = Record<string, unknown>;
type ConsoleOutput = () => [message: string, ...args: unknown[]];

/** Create a logger with an optional namespace. Existing instances use the current sink. */
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
      const fallback = () => {
        try {
          const method = level === "debug" || level === "info" ? "log" : level;
          if (method === "log" && !envFlag("WORKFLOW_ENGINE_TRACE")) return;
          const [line, ...args] =
            consoleOutput?.() ??
            (fields === undefined
              ? [message]
              : [message, consoleFields(fields)]);
          console[method](format(line), ...args);
        } catch {
          // Diagnostics cannot interrupt engine work.
        }
      };

      const sink = processScope[loggerKey];
      if (sink) {
        try {
          const result: unknown =
            fields === undefined
              ? sink[level](format(message))
              : sink[level](format(message), fields);
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
    /** Log a caught error. Its message, cause and extra properties may contain input. */
    caught(message: string, cause: unknown, fields?: Fields): void {
      const includeCause = isTraceTextEnabled();
      error(message, includeCause ? { ...fields, error: cause } : fields, () =>
        includeCause ? [message, cause] : [message],
      );
    },
  };
}
