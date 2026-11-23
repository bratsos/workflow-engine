import { LoadAPIKeyError } from "@ai-sdk/provider";
import { NoObjectGeneratedError } from "ai";
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
    error instanceof UnportableSchemaError
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

/**
 * The SDK emits provider warnings via a process-wide logger. Remove warning
 * text at the provider boundary to leave unrelated SDK callers' settings alone.
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
        const result = await method.apply(target, args);
        if (isTraceTextEnabled()) return result;
        if (key === "doStream") {
          return {
            ...result,
            stream: result.stream.pipeThrough(
              new TransformStream({
                transform(part, controller) {
                  controller.enqueue(
                    part.type === "stream-start"
                      ? { ...part, warnings: [] }
                      : part,
                  );
                },
              }),
            ),
          };
        }
        return { ...result, warnings: [] };
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
