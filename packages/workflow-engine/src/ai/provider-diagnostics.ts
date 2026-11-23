import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { NoObjectGeneratedError } from "ai";
import { ZodError } from "zod";
import { brandNonRetryable, isNonRetryableError } from "../core/steps.js";
import { toErrorMessage } from "../kernel/helpers/error-message.js";
import { createLogger, isTraceTextEnabled } from "../utils/logger.js";
import { AICallTimeoutError } from "./errors.js";
import { UnportableSchemaError } from "./schema-portability.js";

const logger = createLogger("AIHelper");

const originalErrors = new WeakMap<Error, unknown>();

/** Provider failures have no public cause. The repair path can still inspect the original in process. */
export class ProviderCallError extends Error {
  readonly statusCode?: number;
  readonly isRetryable?: boolean;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;

  constructor(message: string, error?: unknown) {
    const value = (key: string): unknown => {
      try {
        return (error as Record<string, unknown> | undefined)?.[key];
      } catch {
        return undefined;
      }
    };
    const status = value("statusCode");
    const statusCode =
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? status
        : undefined;
    super(
      statusCode === undefined ? message : `${message} (HTTP ${statusCode})`,
    );
    this.name = "ProviderCallError";
    this.statusCode = statusCode;
    const isRetryable = value("isRetryable");
    const retryable = value("retryable");
    const retryAfter = value("retryAfterSeconds");
    if (typeof isRetryable === "boolean") this.isRetryable = isRetryable;
    if (typeof retryable === "boolean") this.retryable = retryable;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
      this.retryAfterSeconds = retryAfter;
    }
    if (isNonRetryableError(error)) brandNonRetryable(this);
    if (error !== undefined) originalErrors.set(this, error);
  }
}

export function providerError(error: unknown, message: string): Error {
  if (
    error instanceof ProviderCallError ||
    error instanceof AICallTimeoutError ||
    error instanceof UnportableSchemaError ||
    // The stage classifier fails a Zod error without a retry. Its issues carry
    // paths and expectations, not the input.
    error instanceof ZodError
  )
    return error;
  traceProviderDiagnostic(message, error);
  if (
    LoadAPIKeyError.isInstance(error) ||
    (error instanceof Error && error.name === "AI_LoadAPIKeyError")
  ) {
    return new LoadAPIKeyError({ message: "Provider API key is missing." });
  }
  if (NoObjectGeneratedError.isInstance(error)) {
    const safe = new ProviderCallError(
      "No object generated. The response did not match the required format.",
      error,
    );
    safe.name = "AI_NoObjectGeneratedError";
    return safe;
  }
  return new ProviderCallError(message, error);
}

export async function callProvider<T>(
  message: string,
  call: () => T,
): Promise<Awaited<T>> {
  try {
    return await call();
  } catch (error) {
    throw providerError(error, message);
  }
}

export function providerStatus(
  detail: unknown,
  message: string,
): string | undefined {
  if (detail === undefined || detail === null || detail === "")
    return undefined;
  traceProviderDiagnostic(message, detail);
  return message;
}

export function originalProviderError(error: unknown): unknown {
  return error instanceof ProviderCallError && originalErrors.has(error)
    ? originalErrors.get(error)
    : error;
}

export function traceProviderDiagnostic(
  message: string,
  detail: unknown,
): void {
  if (isTraceTextEnabled())
    logger.debug(message, { detail: toErrorMessage(detail) });
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "ResponseAborted" ||
      error.name === "TimeoutError")
  );
}

/**
 * A stream error reaches the caller through the SDK result, so it is made safe
 * before the SDK sees it. The SDK still sees an abort, and a retryable failure
 * remains a retryable `APICallError` with its status and headers.
 */
function safeStreamError(error: unknown): unknown {
  if (isAbortError(error)) return error;
  const safe = providerError(error, "Provider stream failed");
  if (safe === error) return error;
  const apiError = APICallError.isInstance(error) ? error : undefined;
  let retryable: unknown;
  try {
    retryable = (error as { isRetryable?: unknown } | undefined)?.isRetryable;
  } catch {
    retryable = undefined;
  }
  if (!apiError && retryable !== true) return safe;
  return new APICallError({
    message: "Provider stream failed",
    url: "",
    requestBodyValues: undefined,
    statusCode: (safe as ProviderCallError).statusCode,
    responseHeaders: apiError?.responseHeaders,
    isRetryable: retryable === true,
  });
}

function protectStream<T extends { type: string }>(
  stream: ReadableStream<T>,
  keepWarnings: boolean,
): ReadableStream<T> {
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        controller.error(safeStreamError(error));
        return;
      }
      if (next.done) {
        controller.close();
        return;
      }
      const part = next.value as T & { error?: unknown };
      if (part.type === "error") {
        controller.enqueue({ ...part, error: safeStreamError(part.error) });
      } else if (part.type === "stream-start" && !keepWarnings) {
        controller.enqueue({ ...part, warnings: [] });
      } else {
        controller.enqueue(part);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/**
 * The SDK emits provider warnings via a process-wide logger. Remove warning
 * text at the provider boundary to leave unrelated SDK callers' settings alone.
 * Stream errors are replaced there too, since the SDK result exposes them.
 */
export function protectProviderWarnings<T extends object>(model: T): T {
  return new Proxy(model, {
    get(target, key) {
      const method: unknown = Reflect.get(target, key, target);
      if (typeof method !== "function") return method;
      if (
        key !== "doGenerate" &&
        key !== "doEmbed" &&
        key !== "doEvaluate" &&
        key !== "doStream"
      ) {
        return method.bind(target);
      }
      return async (...args: unknown[]) => {
        if (key !== "doStream") {
          const result = await method.apply(target, args);
          return isTraceTextEnabled() ? result : { ...result, warnings: [] };
        }
        let result: { stream: ReadableStream<{ type: string }> };
        try {
          result = await method.apply(target, args);
        } catch (error) {
          throw safeStreamError(error);
        }
        return {
          ...result,
          stream: protectStream(result.stream, isTraceTextEnabled()),
        };
      };
    },
  });
}

/** Only recognized status values can enter persisted diagnostics. */
export function knownProviderBatchStatus(status: unknown): string | undefined {
  if (typeof status !== "string") return undefined;
  const known =
    /^(?:(?:JOB|BATCH)_STATE_)?(?:PENDING|QUEUED|VALIDATING|IN_PROGRESS|PROCESSING|RUNNING|FINALIZING|COMPLETED|SUCCEEDED|FAILED|EXPIRED|CANCEL(?:L?ING|L?ED)|ENDED|PAUSED|UNSPECIFIED)$/i;
  return known.test(status) ? status : undefined;
}
