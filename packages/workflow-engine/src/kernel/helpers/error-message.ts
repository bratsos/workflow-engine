/**
 * Normalize a caught value (typed `unknown` at the catch site) into a
 * display-safe string: the `Error#message` when it is an `Error`,
 * otherwise its `String(...)` coercion.
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
