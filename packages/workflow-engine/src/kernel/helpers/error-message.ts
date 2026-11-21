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
 * gets `toErrorMessage`'s text. Never throws.
 */
export function describeThrown(error: unknown): {
  name?: string;
  message: string;
} {
  let message = toErrorMessage(error);
  let name: string | undefined;
  try {
    if (typeof error === "object" && error !== null) {
      const fields = error as { name?: unknown; message?: unknown };
      if (!(error instanceof Error) && typeof fields.message === "string") {
        message = fields.message;
      }
      if (typeof fields.name === "string" && fields.name !== "") {
        name = fields.name;
      }
    }
  } catch {
    // A throwing getter: keep what was read.
  }
  return name === undefined ? { message } : { name, message };
}
