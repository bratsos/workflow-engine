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

/** Thrown when a stage asks for AI without kernel AI services configured. */
export class AIServicesNotConfiguredError extends Error {
  constructor() {
    super(
      "AI services are not configured. Pass createKernel({ services: { aiLogger, ai } }) to configure ctx.ai and ctx.aiLogger.",
    );
    this.name = "AIServicesNotConfiguredError";
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

/**
 * Thrown when a payload that was spilled to the blob store cannot be read
 * back. Almost always means the process reading it is pointed at a
 * different `BlobStore` than the one that wrote it: every process that
 * executes or replays a run must share one (see `createPrismaBlobStore`).
 */
export class SpilledPayloadUnavailableError extends Error {
  constructor(
    public readonly key: string,
    public readonly cause?: unknown,
  ) {
    super(
      `Spilled payload "${key}" is not in the blob store${
        cause instanceof Error ? `: ${cause.message}` : ""
      }. Every process that executes or polls a run must share one BlobStore (see createPrismaBlobStore).`,
    );
    this.name = "SpilledPayloadUnavailableError";
  }
}
