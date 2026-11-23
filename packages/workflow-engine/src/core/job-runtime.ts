import { z } from "zod";

export const positiveInt32 = z.number().int().min(1).max(2_147_483_647);

export const jobRetryBackoffSchema = z.object({
  initialDelayMs: z.number().int().min(0).max(2_147_483_647),
  factor: z.number().finite().min(1).optional(),
  maxDelayMs: positiveInt32.optional(),
});

export type JobRetryBackoff = z.infer<typeof jobRetryBackoffSchema>;

export const jobRetrySchema = z.object({
  maxAttempts: positiveInt32,
  backoff: jobRetryBackoffSchema,
});

export type JobRetry = z.infer<typeof jobRetrySchema>;

export const jobRuntimeSchema = z.object({
  jobRetry: jobRetrySchema.optional(),
  leaseTimeoutMs: positiveInt32.optional(),
  absoluteTimeoutMs: positiveInt32.optional(),
});

export interface JobRuntimeOptions {
  /** Job delivery and suspended-poll retry policy. */
  jobRetry?: JobRetry;
  /** Duration of one job lease in milliseconds. */
  leaseTimeoutMs?: number;
  /** Absolute duration cap of one claimed job attempt in milliseconds. */
  absoluteTimeoutMs?: number;
}

/** Delay after a failed attempt, starting at attempt one. */
export function retryBackoffMs(
  attempt: number,
  backoff?: JobRetryBackoff | null,
): number {
  if (!backoff) return 2 ** Math.max(0, attempt) * 1000;
  if (backoff.initialDelayMs === 0) return 0;
  return Math.min(
    backoff.initialDelayMs * (backoff.factor ?? 2) ** Math.max(0, attempt - 1),
    backoff.maxDelayMs ?? 2_147_483_647,
  );
}
