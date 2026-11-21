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

const JOB_TARGET_MISSING: unique symbol = Symbol.for(
  "@bratsos/workflow-engine/job-target-missing",
) as typeof JOB_TARGET_MISSING;

/** The workflow, stage and run a `job.execute` command names. */
export interface JobTarget {
  workflowId: string;
  stageId: string;
  workflowRunId: string;
}

/** The message `job.execute` throws for each missing part of `target`. */
function missingTargetMessages(target: JobTarget) {
  return {
    workflow: `Workflow ${target.workflowId} not found in registry`,
    stage: `Stage ${target.stageId} not found in workflow ${target.workflowId}`,
    run: `WorkflowRun ${target.workflowRunId} not found`,
  };
}

/**
 * Thrown by `job.execute` when the job's workflow, stage or run does not
 * exist: the queue row is an orphan, and a host acknowledges it as dead.
 * The text is the one earlier releases threw, so older readers still match
 * it; `target` names the command it was thrown for.
 */
export class JobTargetMissingError extends Error {
  readonly [JOB_TARGET_MISSING] = true as const;
  readonly target: JobTarget;

  constructor(target: JobTarget, missing: "workflow" | "stage" | "run") {
    super(missingTargetMessages(target)[missing]);
    this.name = "JobTargetMissingError";
    this.target = { ...target };
  }
}

/**
 * Whether `error` is the missing-target error `job.execute` throws for this
 * very job, so a host may acknowledge the job as dead.
 *
 * - The error itself (branded): its `target` must be this job's workflow,
 *   stage and run, all three. The missing target of another dispatch made
 *   inside the job (a custom executor calling a kernel) names another
 *   target, and is that dispatch's failure, not this job's.
 * - Otherwise, any value whose `name` is `JobTargetMissingError` or `Error`
 *   and whose `message` is exactly the text thrown for one of this job's own
 *   workflow, stage or run (the plain `Error` an earlier release's kernel
 *   throws, an error decoded from JSON). The texts do not name every id, so
 *   any other error with that name and text matches too; the branded error
 *   does not.
 *
 * An error with any other name or text is neither.
 */
export function isJobTargetMissingError(
  error: unknown,
  target: JobTarget,
): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    [JOB_TARGET_MISSING]?: unknown;
    target?: Partial<JobTarget>;
    name?: unknown;
    message?: unknown;
  };
  if (candidate[JOB_TARGET_MISSING] === true && candidate.target) {
    return (
      candidate.target.workflowId === target.workflowId &&
      candidate.target.stageId === target.stageId &&
      candidate.target.workflowRunId === target.workflowRunId
    );
  }
  if (
    candidate.name !== "JobTargetMissingError" &&
    candidate.name !== "Error"
  ) {
    return false;
  }
  return Object.values(missingTargetMessages(target)).includes(
    candidate.message as string,
  );
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
