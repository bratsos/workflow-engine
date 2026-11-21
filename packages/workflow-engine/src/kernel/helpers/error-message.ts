/**
 * Normalize a caught value (typed `unknown` at the catch site) into a
 * display-safe string: the `Error#message` when it is an `Error`,
 * otherwise its `String(...)` coercion.
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The text a stage records for a thrown error: `job.execute`'s rule
 * (`"QuotaError: over quota"`, a plain `Error` by its message alone), used on
 * every path that fails or retries a stage so one throw reads the same way
 * wherever it is met.
 */
export function describeStageError(error: unknown): string {
  const message = toErrorMessage(error);
  return error instanceof Error && error.name && error.name !== "Error"
    ? `${error.name}: ${message}`
    : message;
}
