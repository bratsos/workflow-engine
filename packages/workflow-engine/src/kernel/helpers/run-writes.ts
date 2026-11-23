import type { Persistence, StepLedger } from "../ports.js";

/** Register before leaving the database, and release only after the last write. */
export async function beginRunWrite(
  persistence: Persistence,
  workflowRunId: string,
): Promise<(() => Promise<void>) | undefined> {
  if (!persistence.beginRunWrite || !persistence.endRunWrite)
    return async () => {};
  const token = crypto.randomUUID();
  if (!(await persistence.beginRunWrite(workflowRunId, token)))
    return undefined;
  return () => persistence.endRunWrite!(token);
}

export async function writeForRun<T>(
  persistence: Persistence,
  workflowRunId: string,
  write: () => T | Promise<T>,
): Promise<T | undefined> {
  if (!persistence.beginRunWrite || !persistence.endRunWrite) return write();
  const done = await beginRunWrite(persistence, workflowRunId);
  if (!done) return undefined;
  try {
    return await write();
  } finally {
    await done();
  }
}

/** A retained stage context still uses the same run fence after execution. */
export function runStepLedger(
  persistence: Persistence,
  workflowRunId: string,
  ledger: StepLedger | undefined,
): StepLedger | undefined {
  if (!ledger || !persistence.beginRunWrite) return ledger;
  return {
    ...ledger,
    get: ledger.get.bind(ledger),
    list: ledger.list.bind(ledger),
    clear: ledger.clear.bind(ledger),
    async claim(...args) {
      const result = await writeForRun(persistence, workflowRunId, () =>
        ledger.claim(...args),
      );
      if (!result) throw new Error("Run is unavailable for step writes");
      return result;
    },
    async update(...args) {
      const result = await writeForRun(persistence, workflowRunId, () =>
        ledger.update(...args),
      );
      if (!result) throw new Error("Run is unavailable for step writes");
      return result;
    },
    async compareAndSet(...args) {
      return (
        (await writeForRun(persistence, workflowRunId, () =>
          ledger.compareAndSet(...args),
        )) ?? { applied: false, record: null }
      );
    },
  };
}
