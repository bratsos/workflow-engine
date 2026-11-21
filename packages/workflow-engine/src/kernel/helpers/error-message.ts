/**
 * Normalize a caught value (typed `unknown` at the catch site) into a
 * display-safe string: the `Error#message` when it is an `Error`,
 * otherwise its `String(...)` coercion.
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The name and message of a thrown value that need not be an `Error`
 * instance: a zod core `$ZodError`, or an error decoded from JSON, carries
 * both as plain string fields. Used wherever a failure is classified and
 * recorded, so the name and text survive with the verdict.
 */
export function describeThrown(error: unknown): {
  name?: string;
  message: string;
} {
  if (typeof error !== "object" || error === null)
    return { message: String(error) };
  const { name, message } = error as { name?: unknown; message?: unknown };
  return {
    ...(typeof name === "string" && name !== "" ? { name } : {}),
    message: typeof message === "string" ? message : toErrorMessage(error),
  };
}
