export class IdempotencyInProgressError extends Error {
  constructor(
    public readonly key: string,
    public readonly commandType: string,
  ) {
    super(
      `Command "${commandType}" with idempotency key "${key}" is already in progress`,
    );
    this.name = "IdempotencyInProgressError";
  }
}

/**
 * Thrown inside a Phase 3 / Phase 2 transaction when the run status has
 * become non-RUNNING (typically because `run.cancel` committed between
 * the handler's initial ghost check and the transactional write). Used
 * as a sentinel to roll back the transaction cleanly; the handler
 * catches it and returns a ghost outcome to the caller.
 *
 * Without this guard, a cancel committing during stage execution could
 * still let Phase 3 commit stage updates, outbox events, and
 * annotations against an already-cancelled run.
 */
export class RunNotRunningError extends Error {
  constructor(
    public readonly workflowRunId: string,
    public readonly currentStatus: string,
  ) {
    super(
      `Run ${workflowRunId} is ${currentStatus}, not RUNNING — transactional write aborted`,
    );
    this.name = "RunNotRunningError";
  }
}
