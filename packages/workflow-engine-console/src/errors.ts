/**
 * A console query was cancelled by `statement_timeout` (Postgres `57014`).
 *
 * Thrown rather than swallowed so the handler can answer with an honest
 * "that query was too expensive" instead of holding the request open. The
 * UI renders it as an inline banner and leaves the filter bar interactive,
 * so the operator can narrow the filter and retry — a page that keeps
 * working is worth more than a spinner that never resolves.
 */
export class ConsoleQueryTimeoutError extends Error {
  readonly code = "query_timeout" as const;
  constructor(
    readonly query: string,
    readonly timeoutMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      `Console query "${query}" was cancelled after ${timeoutMs}ms by statement_timeout. Narrow the filter or raise statementTimeoutMs.`,
      options,
    );
    this.name = "ConsoleQueryTimeoutError";
  }
}

/** Postgres `query_canceled`. */
const STATEMENT_TIMEOUT_SQLSTATE = "57014";

/**
 * Recognise a cancelled statement through whatever wrapper the driver put
 * around it. Prisma surfaces the SQLSTATE on `meta.code` for
 * `PrismaClientKnownRequestError` P2010, node-postgres puts it on `code`,
 * and a raw error may only carry the message.
 */
export function isStatementTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown; message?: unknown };
    message?: unknown;
  };
  if (candidate.code === STATEMENT_TIMEOUT_SQLSTATE) return true;
  if (candidate.meta?.code === STATEMENT_TIMEOUT_SQLSTATE) return true;
  const messages = [candidate.message, candidate.meta?.message];
  return messages.some(
    (message) =>
      typeof message === "string" &&
      (message.includes(STATEMENT_TIMEOUT_SQLSTATE) ||
        message.includes("canceling statement due to statement timeout")),
  );
}

/** The request asked for something the console cannot serve. */
export class ConsoleBadRequestError extends Error {
  readonly code = "bad_request" as const;
  constructor(message: string) {
    super(message);
    this.name = "ConsoleBadRequestError";
  }
}
