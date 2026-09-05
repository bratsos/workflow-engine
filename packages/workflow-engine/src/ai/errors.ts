/** Thrown when one AI operation exceeds its configured deadline. */
export class AICallTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly modelKey: string,
  ) {
    super(`AI call for model "${modelKey}" timed out after ${timeoutMs}ms`);
    this.name = "AICallTimeoutError";
  }
}
