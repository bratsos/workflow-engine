/**
 * Handler: stage.pollSuspended
 *
 * Polls suspended stages whose nextPollAt has passed, calls each stage's
 * checkCompletion() method or replays durable execute() methods, and either
 * resumes (completes) or re-schedules them for a future poll.
 *
 * Uses a multi-phase pattern per stage so that checkCompletion() — which
 * typically makes external HTTP calls to batch providers — runs outside
 * any database transaction:
 *
 *   Phase 0 (no transaction): Claim the stage — a version-guarded bump of
 *                             `nextPollAt` so a concurrent poller (another
 *                             process, or an overlapping tick in this one)
 *                             skips it instead of running the same work.
 *   Phase 1 (no transaction): Call checkCompletion() — external I/O
 *   Phase 2 (transaction):    Persist results + append outbox events
 *
 * This avoids Prisma P2028 interactive-transaction timeout errors when
 * batch provider APIs are slow to respond.
 */

import type { CheckCompletionContext, Stage } from "../../core/stage";
import { DURABLE_SUSPEND_MARKER, StepTimeoutError } from "../../core/steps.js";
import {
  isSuspendedResult,
  type StageResult,
  type SuspendedResult,
} from "../../core/types.js";
import {
  type CreateAnnotationInput,
  StaleVersionError,
} from "../../persistence/interface.js";
import type {
  StagePollSuspendedCommand,
  StagePollSuspendedResult,
} from "../commands";
import { servedDefinitions, servesRun } from "../helpers/definition-pinning.js";
import {
  buildAnnotationEvents,
  buildStageExecutionContext,
  type ClaimOutcome,
  createAnnotationBuffer,
  createStepApi,
  createStorageShim,
  defineLazyAIContext,
  failStageAndRun,
  handleClaimOutcome,
  loadWorkflowContext,
  markStageCancelled,
  normalizeAnnotateArgs,
  resolveStageInput,
  saveStageArtifacts,
  saveStageOutput,
  toErrorMessage,
  toOutboxEvents,
  withClaimedRun,
} from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";
import type {
  ActivityRunInput,
  WorkflowRunRecord,
  WorkflowStageRecord,
} from "../ports.js";

async function completeSuspendedJobRow(
  workflowRunId: string,
  stageId: string,
  deps: KernelDeps,
): Promise<void> {
  try {
    const jobs = await deps.jobTransport.getJobsByWorkflowRun(workflowRunId);
    const job = jobs.find(
      (j) => j.stageId === stageId && j.status === "SUSPENDED",
    );
    if (job) {
      await deps.jobTransport.complete(job.id);
    }
  } catch {
    // Best-effort cleanup — a failure here must not fail the resume.
  }
}

/**
 * A stage that ends terminally from the poll path (its retry ran here,
 * `checkCompletion` reported an error, the wait timed out) never goes back
 * through `jobTransport.fail`; its SUSPENDED job row would otherwise stay
 * open with `completedAt null` and misreport the run. Best effort, like
 * `completeSuspendedJobRow`.
 */
async function failSuspendedJobRow(
  workflowRunId: string,
  stageId: string,
  error: string,
  deps: KernelDeps,
): Promise<void> {
  try {
    const jobs = await deps.jobTransport.getJobsByWorkflowRun(workflowRunId);
    const job = jobs.find(
      (j) => j.stageId === stageId && j.status === "SUSPENDED",
    );
    if (job) {
      await deps.jobTransport.fail(job.id, error, false);
    }
  } catch {
    // Best-effort cleanup — a failure here must not mask the stage failure.
  }
}

/**
 * Fails a suspended stage before its resume operation ever runs (workflow
 * missing from the registry, or the stage no longer supports its configured
 * resume strategy) — the run itself isn't touched, unlike
 * `failStageAndRun`, since these are pre-flight config problems rather
 * than a checkCompletion outcome.
 */
async function failStageOnly(
  stageRecord: WorkflowStageRecord,
  errorMessage: string,
  deps: KernelDeps,
): Promise<void> {
  await deps.persistence.withTransaction(async (tx) => {
    await tx.updateStage(stageRecord.id, {
      status: "FAILED",
      completedAt: deps.clock.now(),
      errorMessage,
      nextPollAt: null,
    });
    await tx.appendOutboxEvents(
      toOutboxEvents(stageRecord.workflowRunId, [
        {
          type: "stage:failed",
          timestamp: deps.clock.now(),
          workflowRunId: stageRecord.workflowRunId,
          stageId: stageRecord.stageId,
          stageName: stageRecord.stageName,
          error: errorMessage,
        },
      ]),
    );
  });
  await failSuspendedJobRow(
    stageRecord.workflowRunId,
    stageRecord.stageId,
    errorMessage,
    deps,
  );
}

type ReplayOutcome = "resumed" | "suspended" | "failed" | "skip";

/**
 * Shortest lease a poller takes on a suspended stage when it claims it
 * (Phase 0). A stage's own `pollInterval` wins when longer.
 */
const MIN_CLAIM_LEASE_MS = 60_000;

/**
 * Phase 0: claims a suspended stage for this poller before any work is
 * done on it. The claim is a compare-and-set on the stage row — bump
 * `nextPollAt` to `now + lease`, guarded by the row's `version` — issued
 * outside the per-stage transaction so a second poller reading the same
 * stage sees the bump (or, on Postgres, blocks on the row and then sees
 * its own guarded update touch zero rows).
 *
 * Returns the claimed record with `version` advanced by one (any later
 * version-guarded write on the stage still matches), or `null` when another
 * poller already holds the stage (`StaleVersionError`): the caller skips it.
 *
 * The lease is `max(pollInterval, MIN_CLAIM_LEASE_MS)` but never later than
 * `maxWaitUntil` when that deadline is still ahead, so a wait that times out
 * during the lease is noticed at the deadline rather than after the lease.
 * A deadline that has already passed is about to be handled by this very
 * pass (it fails the stage), so it does not shorten the lease.
 *
 * Every outcome branch of the handler ends by writing `nextPollAt`
 * explicitly (a re-suspend writes `pollConfig.nextPollAt`, not-ready writes
 * `now + pollInterval`, completed/failed/cancelled write `null`, a skipped
 * claim outcome hands the stage back through `releaseStageClaim`). The
 * lease value therefore only survives when the process dies mid-replay —
 * in which case the stage is picked up again by whichever poller runs
 * after the lease elapses.
 *
 * Why not a Postgres advisory lock (evaluated, rejected)
 * ------------------------------------------------------
 * A session-level advisory lock releases the instant the connection dies,
 * which would close the stale-lock window this lease leaves behind. It is
 * the wrong tool here, for four independent reasons — any one of them
 * fatal:
 *
 *  1. An advisory lock belongs to the *connection*, not to the task. The
 *     lock has to span `checkCompletion()`'s HTTP call and the per-stage
 *     transaction that follows it, so it cannot be `pg_advisory_xact_lock`
 *     (released at COMMIT, mid-replay) and must be a session lock. Session
 *     locks are re-entrant within a session: two pollers handed the same
 *     pooled connection both win `pg_try_advisory_lock` on the same key, so
 *     single flight fails exactly where concurrency is highest.
 *  2. PgBouncer in transaction mode does not support session-level advisory
 *     locks — statements land on different server connections and the lock
 *     leaks with nothing to release it.
 *  3. The serverless host has no long-lived connection to own a session
 *     lock, so it would need this lease as a fallback regardless.
 *  4. It cannot coexist with a consumer running the kernel inside their own
 *     transaction under row-level security — the property nothing may
 *     compromise. A session lock taken inside their transaction is *not*
 *     released at their COMMIT: it leaks into their pooled connection.
 *     Worse, the advisory namespace is one 64-bit integer space, global to
 *     the database and invisible to RLS: a tenant blocked on another
 *     tenant's key sees that key in `pg_locks` and waits on it, with no
 *     policy able to intervene. Row-level security cannot scope a lock it
 *     cannot see.
 *
 * On top of that, `Persistence` has no raw-SQL escape hatch and SQLite has
 * no advisory locks, so the port would grow a Postgres-only optional method
 * whose fallback is this lease anyway. The `nextPollAt` claim stays.
 */
async function claimSuspendedStage(
  stageRecord: WorkflowStageRecord,
  deps: KernelDeps,
): Promise<WorkflowStageRecord | null> {
  const now = deps.clock.now().getTime();
  let leaseUntil =
    now + Math.max(stageRecord.pollInterval ?? 0, MIN_CLAIM_LEASE_MS);
  const deadline = stageRecord.maxWaitUntil?.getTime();
  if (deadline !== undefined && deadline > now && deadline < leaseUntil) {
    leaseUntil = deadline;
  }
  const nextPollAt = new Date(leaseUntil);
  try {
    await deps.persistence.updateStage(stageRecord.id, {
      nextPollAt,
      expectedVersion: stageRecord.version,
    });
  } catch (error) {
    if (error instanceof StaleVersionError) return null;
    throw error;
  }
  return { ...stageRecord, nextPollAt, version: stageRecord.version + 1 };
}

/**
 * Hands a claimed stage back so it is polled again instead of waiting out
 * the claim lease. Version-guarded: when the row was written since the
 * claim (the cancel cascade, a later claimant after the lease elapsed),
 * that writer's `nextPollAt` stands.
 *
 * `nextPollAt` defaults to now, which is right for a *transient* skip (the
 * run was claimed by another writer, or is no longer RUNNING): the
 * condition clears next tick, so making the stage immediately eligible
 * again costs one extra visit. It is wrong for a condition that persists,
 * and callers whose reason lasts for a whole deploy — a run this build
 * cannot serve — must pass the deadline the row already carried instead.
 * Released to now, such a stage is re-claimed and re-released every tick
 * forever, two version-bumping writes each time, and because it never
 * leaves the ready set it permanently occupies one of the tick's candidate
 * slots and pushes servable stages out of the window.
 */
async function releaseStageClaim(
  stageRecord: WorkflowStageRecord,
  deps: KernelDeps,
  nextPollAt?: Date,
): Promise<void> {
  try {
    await deps.persistence.updateStage(stageRecord.id, {
      nextPollAt: nextPollAt ?? deps.clock.now(),
      expectedVersion: stageRecord.version,
    });
  } catch (error) {
    if (error instanceof StaleVersionError) return;
    throw error;
  }
}

async function failExpiredDurableWait(
  stageRecordId: string,
  deps: KernelDeps,
): Promise<void> {
  if (!deps.stepLedger) return;
  const now = deps.clock.now().getTime();
  const expired = (await deps.stepLedger.list(stageRecordId)).find(
    (record) =>
      (record.kind === "wait" || record.kind === "signal") &&
      record.status === "pending" &&
      record.deadlineAt !== null &&
      record.deadlineAt.getTime() <= now,
  );
  if (!expired) return;

  const error = new StepTimeoutError(expired.stepId);
  const failed = await deps.stepLedger.compareAndSet(
    stageRecordId,
    expired.stepId,
    { status: expired.status, attempt: expired.attempt },
    {
      status: "failed",
      error: error.message,
      leaseExpiresAt: null,
    },
  );
  if (failed.applied) throw error;
}

/** Replays a durable stage's full execute context outside a transaction. */
async function replayStage(
  stageRecord: WorkflowStageRecord,
  run: WorkflowRunRecord,
  stageDef: Stage<any, any, any, any, any>,
  deps: KernelDeps,
): Promise<ReplayOutcome> {
  let built: ReturnType<typeof buildStageExecutionContext> | undefined;

  try {
    const workflow = deps.registry.getWorkflow(run.workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${run.workflowId} not found in registry`);
    }
    await failExpiredDurableWait(stageRecord.id, deps);
    const workflowContext = await loadWorkflowContext(run.id, deps);
    const rawInput = resolveStageInput(
      workflow,
      stageRecord.stageId,
      run,
      workflowContext,
    );
    const input: ActivityRunInput = {
      stageDef,
      workflowId: run.workflowId,
      workflowRunId: run.id,
      workflowType: run.workflowType,
      stageId: stageRecord.stageId,
      stageName: stageDef.name,
      stageNumber: stageRecord.stageNumber,
      stageRecordId: stageRecord.id,
      attempt: stageRecord.attempt,
      rawInput,
      config: {
        [stageRecord.stageId]: stageRecord.config ?? {},
      } as Record<string, unknown>,
      resumeState: stageRecord.suspendedState,
      workflowContext,
    };
    built = buildStageExecutionContext(input, deps);
    const result = await stageDef.execute(built.context);

    if (isSuspendedResult(result)) {
      const suspended = result as SuspendedResult;
      const nextPollAt = suspended.pollConfig.nextPollAt;
      const bufferedAnnotations = built.annotationBuffer.flush();
      const maxWaitUntil = new Date(
        deps.clock.now().getTime() + suspended.pollConfig.maxWaitTime,
      );
      // A replay that is still waiting on the same durable step re-suspends
      // silently: the run already announced this suspension, and a poll
      // every few seconds must not re-emit `stage:suspended` /
      // `workflow:suspended` each time. The step id is the identity of the
      // wait (`batchId` is `step:<id>` for a durable wait, a retry and an
      // in-flight lease alike); the deadline is not part of it, so a stage
      // waiting on a leased step after a crash (whose 5s in-flight polls
      // each carry a fresh deadline) announces once too.
      const previous = stageRecord.suspendedState as
        | { batchId?: unknown }
        | null
        | undefined;
      const sameWait =
        previous?.batchId !== undefined &&
        previous.batchId === suspended.state.batchId;
      const claimResult = await withClaimedRun(
        stageRecord.workflowRunId,
        run.version,
        deps,
        async (tx) => {
          await tx.updateStage(stageRecord.id, {
            status: "SUSPENDED",
            suspendedState: suspended.state as any,
            nextPollAt,
            pollInterval: suspended.pollConfig.pollInterval,
            maxWaitUntil,
            metrics: suspended.metrics as any,
          });
          if (bufferedAnnotations.length > 0) {
            await tx.appendAnnotations(bufferedAnnotations);
          }
          const suspensionEvents = sameWait
            ? []
            : [
                {
                  type: "stage:suspended" as const,
                  timestamp: deps.clock.now(),
                  workflowRunId: stageRecord.workflowRunId,
                  stageId: stageRecord.stageId,
                  stageName: stageRecord.stageName,
                  nextPollAt,
                },
                {
                  type: "workflow:suspended" as const,
                  timestamp: deps.clock.now(),
                  workflowRunId: stageRecord.workflowRunId,
                  stageId: stageRecord.stageId,
                },
              ];
          const events = [
            ...built!.progressEvents,
            ...suspensionEvents,
            ...buildAnnotationEvents(bufferedAnnotations, deps.clock.now()),
          ];
          if (events.length > 0) {
            await tx.appendOutboxEvents(
              toOutboxEvents(stageRecord.workflowRunId, events),
            );
          }
        },
      );
      if (await handleClaimOutcome(claimResult, stageRecord, deps))
        return "skip";
      return "suspended";
    }

    const stageResult = result as StageResult<unknown>;
    let validatedOutput = stageResult.output;
    if (stageResult.output !== undefined) {
      try {
        validatedOutput = stageDef.outputSchema.parse(stageResult.output);
      } catch (validationError) {
        await deps.persistence
          .createLog({
            workflowRunId: stageRecord.workflowRunId,
            workflowStageId: stageRecord.id,
            level: "WARN",
            message: `Stage ${stageRecord.stageId} execute output failed schema validation; persisting raw output`,
            metadata: { error: toErrorMessage(validationError) },
          })
          .catch(() => {});
      }
    }

    const outputKey = await saveStageOutput(
      stageRecord.workflowRunId,
      run.workflowType,
      stageRecord.stageId,
      validatedOutput,
      deps,
    );
    const artifactKeys =
      stageResult.artifacts && Object.keys(stageResult.artifacts).length > 0
        ? await saveStageArtifacts(
            stageRecord.workflowRunId,
            run.workflowType,
            stageRecord.stageId,
            stageResult.artifacts,
            deps,
          )
        : undefined;
    const duration =
      deps.clock.now().getTime() -
      (stageRecord.startedAt?.getTime() ?? deps.clock.now().getTime());
    const bufferedAnnotations = built.annotationBuffer.flush();
    const claimResult = await withClaimedRun(
      stageRecord.workflowRunId,
      run.version,
      deps,
      async (tx) => {
        await tx.updateStage(stageRecord.id, {
          status: "COMPLETED",
          completedAt: deps.clock.now(),
          duration,
          outputData: {
            _artifactKey: outputKey,
            ...(artifactKeys ? { _artifactKeys: artifactKeys } : {}),
          },
          nextPollAt: null,
          metrics: stageResult.metrics as any,
          embeddingInfo: stageResult.embeddings as any,
          // A retried attempt that finished through a suspension: the
          // earlier attempt's error is stale, exactly as on direct completion.
          errorMessage: null,
        });
        if (bufferedAnnotations.length > 0) {
          await tx.appendAnnotations(bufferedAnnotations);
        }
        const events = [
          ...built!.progressEvents,
          {
            type: "stage:completed" as const,
            timestamp: deps.clock.now(),
            workflowRunId: stageRecord.workflowRunId,
            stageId: stageRecord.stageId,
            stageName: stageRecord.stageName,
            duration,
          },
          ...buildAnnotationEvents(bufferedAnnotations, deps.clock.now()),
        ];
        await tx.appendOutboxEvents(
          toOutboxEvents(stageRecord.workflowRunId, events),
        );
      },
    );
    if (await handleClaimOutcome(claimResult, stageRecord, deps)) return "skip";
    await completeSuspendedJobRow(
      stageRecord.workflowRunId,
      stageRecord.stageId,
      deps,
    );
    return "resumed";
  } catch (error) {
    const message = toErrorMessage(error);
    const claimResult = await failStageAndRun(
      stageRecord,
      run,
      message,
      built?.annotationBuffer.flush() ?? [],
      deps,
    );
    if (await handleClaimOutcome(claimResult, stageRecord, deps)) return "skip";
    await failSuspendedJobRow(
      stageRecord.workflowRunId,
      stageRecord.stageId,
      message,
      deps,
    );
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleStagePollSuspended(
  command: StagePollSuspendedCommand,
  deps: KernelDeps,
): Promise<HandlerResult<StagePollSuspendedResult>> {
  const maxChecks = command.maxChecks ?? 50;
  // The same answer `run.claimPending` derives, for the same reason: a
  // host must poll the suspended stages of the runs it would adopt, and
  // must not touch the ones it would not.
  const serves =
    command.serves === "all"
      ? undefined
      : (command.serves ?? servedDefinitions(deps.registry));
  await deps.persistence.ensureDefinitionVersioningDetected?.();

  // 1. Get the ready stages this build can serve, oldest deadline first
  //    and already capped (no transaction). Both narrowings are in the
  //    query: slicing an unfiltered, unordered result in JS let a stage
  //    this host cannot serve hold a candidate slot forever.
  const stagesToCheck = await deps.persistence.getSuspendedStages(
    deps.clock.now(),
    { limit: maxChecks, ...(serves !== undefined ? { serves } : {}) },
  );

  let checked = 0;
  let resumed = 0;
  let failed = 0;
  const resumedWorkflowRunIds = new Set<string>();

  // 3. Process each suspended stage
  for (const candidate of stagesToCheck) {
    checked++;

    // ── Phase 0: claim the stage (no transaction) ──────────────────────
    // Another poller holds it → skip; nothing below runs for this stage.
    const stageRecord = await claimSuspendedStage(candidate, deps);
    if (!stageRecord) continue;

    // Resolves a Phase-2 claim outcome and, when the stage is to be
    // skipped, hands the claim back so the next tick retries it.
    const skipAfterClaim = async (
      claimResult: ClaimOutcome<unknown>,
    ): Promise<boolean> => {
      if (!(await handleClaimOutcome(claimResult, stageRecord, deps))) {
        return false;
      }
      await releaseStageClaim(stageRecord, deps);
      return true;
    };

    // 3a. Get workflow run (no transaction — read-only lookup)
    const run = await deps.persistence.getRun(stageRecord.workflowRunId);
    // A run that no longer exists leaves the lease in place: there is
    // nothing to resume, and the stage is revisited after the lease.
    if (!run) continue;

    // 3a.1 Skip cancelled runs — mark the suspended stage as cancelled
    if (run.status === "CANCELLED") {
      await markStageCancelled(stageRecord.id, deps);
      continue;
    }

    // 3b. Get workflow from registry
    const workflow = deps.registry.getWorkflow(run.workflowId);
    if (!workflow) {
      await failStageOnly(
        stageRecord,
        `Workflow ${run.workflowId} not found in registry`,
        deps,
      );
      failed++;
      continue;
    }

    // 3b.1 Definition pinning: a suspended stage belonging to a run this
    //      build does not serve is left for a build that does, rather
    //      than polled against a different pipeline shape. It is skipped,
    //      not failed — the run is intact and another process (or
    //      `run.redrive`) can carry it forward.
    //
    //      The claim is handed back rather than simply skipped. Phase 0
    //      has already pushed `nextPollAt` out by the claim lease
    //      (`MIN_CLAIM_LEASE_MS`, 60s), and holding it here would mean a
    //      host that *cannot* serve the run locks out the host that can:
    //      during a rolling deploy the old and new builds poll the same
    //      table, so an unserving host re-claiming every tick can starve
    //      the serving one indefinitely.
    //
    //      It is handed back to the deadline the row *already had*, not to
    //      now. This condition lasts for the whole deploy, so releasing to
    //      now would make the stage permanently ready and permanently
    //      re-claimed — see `releaseStageClaim`. Restoring the original
    //      deadline leaves the row exactly as it was found, which is what
    //      "this is not my work" should cost.
    //
    //      This is a backstop, not the mechanism: `getSuspendedStages`
    //      already filters on `serves`, so an unserving host normally
    //      never sees the row. It still fires for an adapter that cannot
    //      apply the filter, and for a run whose version changed between
    //      the query and the claim.
    if (!servesRun(run, workflow)) {
      await releaseStageClaim(
        stageRecord,
        deps,
        candidate.nextPollAt ?? undefined,
      );
      continue;
    }

    // 3c. Get stage definition
    const stageDef = workflow.getStage(stageRecord.stageId);
    const suspendedMetadata = (
      stageRecord.suspendedState as
        | { metadata?: Record<string, unknown> }
        | null
        | undefined
    )?.metadata;
    const isDurableReplay =
      suspendedMetadata?.[DURABLE_SUSPEND_MARKER] === true;
    if (!stageDef || (!isDurableReplay && !stageDef.checkCompletion)) {
      const errorMsg = !stageDef
        ? `Stage ${stageRecord.stageId} not found in workflow ${run.workflowId}`
        : `Stage ${stageRecord.stageId} does not support checkCompletion`;

      await failStageOnly(stageRecord, errorMsg, deps);
      failed++;
      continue;
    }

    if (isDurableReplay) {
      const outcome = await replayStage(stageRecord, run, stageDef, deps);
      if (outcome === "resumed") {
        resumed++;
        resumedWorkflowRunIds.add(stageRecord.workflowRunId);
      } else if (outcome === "failed") {
        failed++;
      } else if (outcome === "skip") {
        await releaseStageClaim(stageRecord, deps);
      }
      continue;
    }

    // 3d. Create storage shim and log function (uses non-transactional deps)
    const storage = createStorageShim(
      stageRecord.workflowRunId,
      run.workflowType,
      deps,
    );

    const logFn = (
      level: "DEBUG" | "INFO" | "WARN" | "ERROR",
      message: string,
      meta?: Record<string, unknown>,
    ): void => {
      void deps.persistence
        .createLog({
          workflowRunId: stageRecord.workflowRunId,
          workflowStageId: stageRecord.id,
          level,
          message,
          metadata: meta,
        })
        .catch(() => {});
    };

    // Buffer annotations made during checkCompletion. Flushed inside
    // the Phase-2 transaction (via withClaimedRun) so they persist
    // atomically with the stage outcome — or are dropped if the
    // transaction rolls back on StaleVersionError, preventing the
    // phantom-annotation race the adversarial review surfaced.
    const annotationBuffer = createAnnotationBuffer();
    const annotateFn = ((...args: unknown[]) => {
      const stageScopeFields = {
        workflowRunId: stageRecord.workflowRunId,
        workflowStageRecordId: stageRecord.id,
        attempt: stageRecord.attempt,
        scope: "stage" as const,
        scopeId: stageRecord.stageId,
      };
      for (const { key, value, opts } of normalizeAnnotateArgs(args)) {
        if (value === undefined || value === null) continue;
        annotationBuffer.push({
          ...stageScopeFields,
          actor: opts?.actor,
          key,
          value,
          payload: opts?.payload,
          idempotencyKey: opts?.idempotencyKey,
          emitEvent: opts?.emitEvent,
        } satisfies CreateAnnotationInput);
      }
    }) as CheckCompletionContext<unknown>["annotate"];

    // 3e. Build check context
    const checkContextBase = defineLazyAIContext(
      {
        workflowRunId: run.id,
        stageId: stageRecord.stageId,
        stageRecordId: stageRecord.id,
        config: stageRecord.config || {},
        log: logFn,
        onLog: logFn,
        annotate: annotateFn,
        storage,
      },
      {
        workflowRunId: run.id,
        stageId: stageRecord.stageId,
        stageRecordId: stageRecord.id,
      },
      deps,
    );
    const checkContext = Object.assign(checkContextBase, {
      step: createStepApi({
        stageRecordId: stageRecord.id,
        stepLedger: deps.stepLedger,
        clock: deps.clock,
        onLog: (level, message) => void logFn(level, message),
        onAnnotate: (key, value, opts) => annotateFn(key, value, opts),
        ai: () => checkContextBase.ai,
      }),
    });

    try {
      // ── Phase 1: checkCompletion (no transaction) ──────────────────
      // External HTTP calls happen here — no DB connection held open.
      const checkResult = await stageDef.checkCompletion!(
        stageRecord.suspendedState as any,
        checkContext,
      );

      // ── Phase 2: persist results (transaction) ─────────────────────
      if (checkResult.error) {
        const claimResult = await failStageAndRun(
          stageRecord,
          run,
          checkResult.error,
          annotationBuffer.flush(),
          deps,
        );

        if (await skipAfterClaim(claimResult)) continue;
        await failSuspendedJobRow(
          stageRecord.workflowRunId,
          stageRecord.stageId,
          checkResult.error,
          deps,
        );

        failed++;
      } else if (checkResult.ready) {
        // Save output to blob store (not a DB operation)
        let outputRef: { _artifactKey: string } | undefined;
        if (checkResult.output !== undefined) {
          let validatedOutput = checkResult.output;
          try {
            validatedOutput = stageDef.outputSchema.parse(checkResult.output);
          } catch (validationError) {
            // Fall back to raw output on validation failure
            logFn(
              "WARN",
              `Stage ${stageRecord.stageId} checkCompletion output failed schema validation; persisting raw output`,
              { error: toErrorMessage(validationError) },
            );
          }

          const outputKey = await saveStageOutput(
            stageRecord.workflowRunId,
            run.workflowType,
            stageRecord.stageId,
            validatedOutput,
            deps,
          );
          outputRef = { _artifactKey: outputKey };
        }

        const duration =
          deps.clock.now().getTime() -
          (stageRecord.startedAt?.getTime() ?? deps.clock.now().getTime());

        const bufferedAnnotations = annotationBuffer.flush();
        const claimResult = await withClaimedRun(
          stageRecord.workflowRunId,
          run.version,
          deps,
          async (tx) => {
            await tx.updateStage(stageRecord.id, {
              status: "COMPLETED",
              completedAt: deps.clock.now(),
              duration,
              outputData: outputRef as any,
              nextPollAt: null,
              metrics: checkResult.metrics as any,
              embeddingInfo: checkResult.embeddings as any,
              errorMessage: null,
            });

            if (bufferedAnnotations.length > 0) {
              await tx.appendAnnotations(bufferedAnnotations);
            }

            await tx.appendOutboxEvents(
              toOutboxEvents(stageRecord.workflowRunId, [
                {
                  type: "stage:completed",
                  timestamp: deps.clock.now(),
                  workflowRunId: stageRecord.workflowRunId,
                  stageId: stageRecord.stageId,
                  stageName: stageRecord.stageName,
                  duration,
                },
                ...buildAnnotationEvents(bufferedAnnotations, deps.clock.now()),
              ]),
            );
          },
        );

        if (await skipAfterClaim(claimResult)) continue;

        resumed++;
        resumedWorkflowRunIds.add(stageRecord.workflowRunId);
        // Resuming here bypasses the normal job.execute → jobTransport
        // .complete() path entirely (this poll loop resumes stages
        // purely via persistence), so the SUSPENDED job row for this
        // stage is never marked complete. Without this, job_queue
        // accumulates a permanently-SUSPENDED row per suspended stage.
        await completeSuspendedJobRow(
          stageRecord.workflowRunId,
          stageRecord.stageId,
          deps,
        );
      } else if (
        stageRecord.maxWaitUntil &&
        stageRecord.maxWaitUntil.getTime() <= deps.clock.now().getTime()
      ) {
        // Not ready, and the stage's maxWaitUntil deadline has now
        // passed. checkCompletion() didn't report its own deadline
        // error (stages that track their own deadline, e.g. remote
        // activity workers, already fail via checkResult.error above),
        // so this is the generic backstop: without it, a suspended
        // stage whose provider never reports readiness or an error
        // would reschedule via nextCheckIn forever.
        const timeoutError = `Stage ${stageRecord.stageId} exceeded maxWaitUntil (${stageRecord.maxWaitUntil.toISOString()}) while suspended`;
        const claimResult = await failStageAndRun(
          stageRecord,
          run,
          timeoutError,
          annotationBuffer.flush(),
          deps,
        );

        if (await skipAfterClaim(claimResult)) continue;
        await failSuspendedJobRow(
          stageRecord.workflowRunId,
          stageRecord.stageId,
          timeoutError,
          deps,
        );

        failed++;
        continue;
      } else {
        // Not ready -- update nextPollAt for next check
        const pollInterval =
          checkResult.nextCheckIn ?? stageRecord.pollInterval ?? 60000;

        const nextPollAt = new Date(deps.clock.now().getTime() + pollInterval);

        const bufferedAnnotations = annotationBuffer.flush();
        const claimResult = await withClaimedRun(
          stageRecord.workflowRunId,
          run.version,
          deps,
          async (tx) => {
            await tx.updateStage(stageRecord.id, {
              nextPollAt,
            });

            if (bufferedAnnotations.length > 0) {
              await tx.appendAnnotations(bufferedAnnotations);
            }
          },
        );

        if (await skipAfterClaim(claimResult)) continue;
      }
    } catch (error) {
      // Unexpected error during checkCompletion. Flush any annotations
      // recorded before the throw so they persist alongside the FAILED
      // outcome.
      const message = toErrorMessage(error);
      const claimResult = await failStageAndRun(
        stageRecord,
        run,
        message,
        annotationBuffer.flush(),
        deps,
      );

      if (await skipAfterClaim(claimResult)) continue;
      await failSuspendedJobRow(
        stageRecord.workflowRunId,
        stageRecord.stageId,
        message,
        deps,
      );

      failed++;
    }
  }

  // Events are written directly to outbox per-stage above, so _events is empty
  return {
    checked,
    resumed,
    failed,
    resumedWorkflowRunIds: [...resumedWorkflowRunIds],
    _events: [],
  };
}
