/** Describe a rejection without allowing its properties or coercion to throw. */
export function toErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      if (typeof message === "string") return message;
    }
    return String(error);
  } catch {
    return "Unprintable error";
  }
}

/**
 * The name and message of a thrown value that need not be an `Error`
 * instance: a zod core `$ZodError`, or an error decoded from JSON, carries
 * both as plain string fields. Used where a failure is classified and
 * recorded, so the name and text survive with the verdict. An `Error`
 * gets `toErrorMessage`'s text. Without a string `message` the text is
 * `fallback` (text the caller already formatted), else `toErrorMessage`'s.
 * Never throws.
 */
export function describeThrown(
  error: unknown,
  fallback?: string,
): {
  name?: string;
  message: string;
} {
  let message: string | undefined;
  let name: string | undefined;
  try {
    // Each property is read once, into a local: a getter that answers
    // differently on a second read cannot change what was checked.
    if (
      typeof error === "object" &&
      error !== null &&
      !(error instanceof Error)
    ) {
      const read = (error as { message?: unknown }).message;
      if (typeof read === "string") message = read;
    }
  } catch {
    // A throwing getter: fall back to the plain text below.
  }
  if (message === undefined) message = fallback ?? toErrorMessage(error);
  try {
    if (typeof error === "object" && error !== null) {
      const read = (error as { name?: unknown }).name;
      if (typeof read === "string" && read !== "") name = read;
    }
  } catch {
    // A throwing getter: no name.
  }
  return name === undefined ? { message } : { name, message };
}
