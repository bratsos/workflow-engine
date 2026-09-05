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

/**
 * Thrown when a run pinned to one definition version is asked to execute
 * against a build that presents a different structure.
 *
 * This is not a run failure. The job is re-delivered so a process running
 * the pinned build can pick it up; if none ever does, the run shows up in
 * `run.listVersions` as an undrained version with no server, and
 * `run.redrive({ definitionVersion: "latest" })` moves it forward
 * deliberately.
 */
export class DefinitionVersionMismatchError extends Error {
  constructor(
    public readonly workflowRunId: string,
    public readonly workflowId: string,
    public readonly pinnedVersion: string,
    public readonly liveVersion: string,
  ) {
    super(
      `Run ${workflowRunId} is pinned to definition version "${pinnedVersion}" of workflow "${workflowId}", but this process serves "${liveVersion}". ` +
        `The job is left for a process running the pinned definition; use run.listVersions to see whether that version has drained, and run.redrive with definitionVersion: "latest" to move the run onto the current definition.`,
    );
    this.name = "DefinitionVersionMismatchError";
  }
}

/**
 * Thrown when an explicit definition version (`defineWorkflow(...).version(...)`)
 * is re-registered with a different pipeline structure. Derived versions
 * cannot hit this: they change whenever the structure does.
 */
export class DefinitionVersionConflictError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly version: string,
    public readonly storedStructureHash: string,
    public readonly currentStructureHash: string,
  ) {
    super(
      `Workflow "${workflowId}" declares definition version "${version}", but that version is already registered with a different pipeline structure ` +
        `(stored ${storedStructureHash}, current ${currentStructureHash}). Bump the explicit version, or drop .version() to let the engine derive one from the structure.`,
    );
    this.name = "DefinitionVersionConflictError";
  }
}
