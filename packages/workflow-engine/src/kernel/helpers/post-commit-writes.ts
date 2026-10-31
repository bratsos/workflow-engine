import type { Persistence } from "../ports.js";

/** Internal adapter capability, forwarded by persistence decorators. */
export const POST_COMMIT_WRITES = Symbol("workflow.postCommitWrites");

export function withPostCommitWrites<T>(
  persistence: Persistence,
  work: () => Promise<T>,
): Promise<T> {
  const scope = Reflect.get(persistence, POST_COMMIT_WRITES);
  return typeof scope === "function" ? scope(work) : work();
}
