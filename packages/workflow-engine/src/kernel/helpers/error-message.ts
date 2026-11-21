/**
 * Normalize a caught value (typed `unknown` at the catch site) into a
 * display-safe string: the `Error#message` when it is an `Error`, the
 * `message` field of any other object that carries a string one (an error
 * decoded from JSON, a zod core `$ZodError`), otherwise its `String(...)`
 * coercion. Never throws, even for a value with no string conversion.
 */
export function toErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null) {
      const { message } = error as { message?: unknown };
      if (typeof message === "string") return message;
    }
    return String(error);
  } catch {
    return "(unprintable value)";
  }
}

/**
 * The name and message of a thrown value that need not be an `Error`
 * instance: a zod core `$ZodError`, or an error decoded from JSON, carries
 * both as plain string fields. Used wherever a failure is classified and
 * recorded, so the name and text survive with the verdict. Never throws.
 */
export function describeThrown(error: unknown): {
  name?: string;
  message: string;
} {
  const message = toErrorMessage(error);
  try {
    if (typeof error === "object" && error !== null) {
      const { name } = error as { name?: unknown };
      if (typeof name === "string" && name !== "") return { name, message };
    }
  } catch {
    // A throwing `name` getter: keep the message.
  }
  return { message };
}
