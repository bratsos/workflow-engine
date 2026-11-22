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
