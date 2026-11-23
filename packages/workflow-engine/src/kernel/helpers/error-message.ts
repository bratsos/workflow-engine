const withheldErrors = new WeakSet<object>();
// shortcut: text matches over the last 1,000 withheld strings; scope by run if that proves too coarse.
const withheldTexts = new Set<string>();
const WITHHELD_TEXT_LIMIT = 1_000;
// Until a helper withholds text, error formatting reads nothing new.
let withholding = false;

function withholdText(text: unknown): void {
  if (typeof text !== "string" || text === "") return;
  withheldTexts.delete(text);
  withheldTexts.add(text);
  if (withheldTexts.size > WITHHELD_TEXT_LIMIT) {
    withheldTexts.delete(withheldTexts.values().next().value as string);
  }
}

function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Mark an AI call failure whose helper withholds text. The error itself is
 * unchanged; the engine's stored and printed outputs describe it instead of
 * repeating its message. Strings are matched by text.
 */
export function withholdErrorText(error: unknown): void {
  withholding = true;
  if (typeof error === "object" && error !== null) {
    withheldErrors.add(error);
    withholdText(read(error, "message"));
  } else {
    withholdText(error);
  }
}

/**
 * Whether `text` is, or quotes, a withheld AI call message. Wrappers such as
 * the SDK's retry error repeat the message; short texts must match exactly.
 */
export function isWithheldText(text: unknown): boolean {
  if (typeof text !== "string" || text === "") return false;
  if (withheldTexts.has(text)) return true;
  for (const withheld of withheldTexts) {
    if (withheld.length >= 16 && text.includes(withheld)) return true;
  }
  return false;
}

/** A text-free description of a withheld error, or undefined when none is withheld. */
export function withheldErrorSummary(error: unknown): string | undefined {
  if (!withholding) return undefined;
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) {
      return isWithheldText(current) ? describeWithheld(undefined) : undefined;
    }
    if (withheldErrors.has(current) || isWithheldText(read(current, "message")))
      return describeWithheld(current);
    current = read(current, "cause");
  }
  return undefined;
}

function describeWithheld(error: object | undefined): string {
  const name = error ? read(error, "name") : undefined;
  const status = error ? read(error, "statusCode") : undefined;
  const label =
    typeof name === "string" && /^[A-Za-z_$][\w$]{0,63}$/.test(name)
      ? `${name}: `
      : "";
  const http =
    typeof status === "number" && Number.isInteger(status)
      ? ` (HTTP ${status})`
      : "";
  return `${label}AI call failed${http}; the text capture policy withholds its message`;
}

/** Describe a rejection without allowing its properties or coercion to throw. */
export function toErrorMessage(error: unknown): string {
  try {
    const withheld = withheldErrorSummary(error);
    if (withheld !== undefined) return withheld;
    if (error instanceof Error) {
      const message = error.message;
      if (typeof message === "string") return message;
    }
    return String(error);
  } catch {
    return "Unprintable error";
  }
}
