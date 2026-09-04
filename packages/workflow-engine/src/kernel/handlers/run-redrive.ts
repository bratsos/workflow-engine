/**
 * Handler: run.redrive
 *
 * The three verbs operators actually want, which Conductor factors as
 * `retry` / `restart` / `rerun`, on one command:
 *
 *  - `{ kind: "lastFailure" }` - resume at the first stage that is not
 *    COMPLETED, leaving completed stages untouched.
 *  - `{ kind: "start" }`       - re-run the whole pipeline from group 1.
 *  - `{ kind: "stage", ... }`  - resume at a chosen stage.
 *
 * Two things separate it from the `run.rerunFrom` it replaces.
 *
 * First, the superseded attempt is preserved. `run.rerunFrom` deleted the
 * failed stage row and every row after it, which destroyed the evidence of
 * the failure being retried. Here each removed stage record is archived
 * as a stage-scoped annotation before deletion, carrying its status,
 * error, timings, metrics and output pointer. Annotations already survive
 * stage deletion (`onDelete: SetNull` on the stage relation), already
 * carry `attempt`, and are already queryable through
 * `kernel.annotations.list` - so the failed attempt lands on the surface
 * built for exactly this rather than in a new table.
 *
 * Second, with definition versioning in place a redrive may move the run
 * onto a different definition version - DBOS's fork-onto-a-new-
 * application-version, which is the answer to "we shipped a bug, patch it
 * and re-run". Step Functions' framing is followed for the rest: the same
 * run id, an incremented redrive count, no branching into a new
 * execution.
 */

import type {
  CreateAnnotationInput,
  WorkflowStageRecord,
} from "../../persistence/interface";
import type {
  RunRedriveCommand,
  RunRedriveFrom,
  RunRedriveResult,
} from "../commands";
import type { KernelEvent } from "../events";
import {
  assertServesRun,
  recordDefinitionVersion,
} from "../helpers/definition-pinning.js";
import { prepareExecutionGroup } from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";

/** Annotation key under which a superseded stage attempt is archived. */
export const SUPERSEDED_ATTEMPT_KEY = "run.supersededAttempt";

/** Run states a redrive may start from. */
const REDRIVABLE = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * Resolves which stage the run resumes from. Returns the stage id; the
 * caller maps it to an execution group against the resolved definition.
 */
function resolveFromStageId(
  from: RunRedriveFrom,
  workflow: { getStagesInExecutionGroup(i: number): Array<{ id: string }> },
  existingStages: readonly WorkflowStageRecord[],
  workflowRunId: string,
): string {
  if (from.kind === "stage") return from.stageId;

  if (from.kind === "start") {
    const first = workflow.getStagesInExecutionGroup(1)[0];
    if (!first) {
      throw new Error(
        `Cannot restart run ${workflowRunId}: the workflow has no stages in execution group 1.`,
      );
    }
    return first.id;
  }

  // "lastFailure": the earliest stage record that did not complete.
  // `getStagesByRun` already orders by executionGroup then stageNumber.
  const firstIncomplete = existingStages.find((s) => s.status !== "COMPLETED");
  if (firstIncomplete) return firstIncomplete.stageId;

  const last = existingStages[existingStages.length - 1];
  if (!last) {
    throw new Error(
      `Cannot retry run ${workflowRunId}: it has no stage records to resume from. Use from: { kind: "start" } to run it from the beginning.`,
    );
  }
  // Every stage completed (a COMPLETED run being "retried"): re-run the
  // last one, which is what Conductor's retry does with a finished
  // workflow rather than refusing.
  return last.stageId;
}

export async function handleRunRedrive(
  command: RunRedriveCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunRedriveResult>> {
  const { workflowRunId } = command;
  const from: RunRedriveFrom = command.from ?? { kind: "lastFailure" };
  const events: KernelEvent[] = [];

  const run = await deps.persistence.getRun(workflowRunId);
  if (!run) throw new Error(`WorkflowRun ${workflowRunId} not found`);

  if (!REDRIVABLE.has(run.status)) {
    throw new Error(
      `Cannot redrive a run in ${run.status} state. Must be COMPLETED, FAILED or CANCELLED.`,
    );
  }

  const workflow = deps.registry.getWorkflow(run.workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${run.workflowId} not found in registry`);
  }

  // ── Which definition does the redriven run resolve against? ────────
  let definitionVersion = run.definitionVersion;
  if (command.definitionVersion === "latest") {
    // Re-pin to what this process serves, registering the snapshot if it
    // has not been seen before.
    definitionVersion = await recordDefinitionVersion(workflow, deps);
  } else if (command.definitionVersion !== undefined) {
    const stored = await deps.persistence.getDefinition(
      run.workflowId,
      command.definitionVersion,
    );
    if (!stored) {
      throw new Error(
        `Cannot redrive run ${workflowRunId} onto definition version "${command.definitionVersion}" of workflow "${run.workflowId}": no run has ever been created at that version, so its structure is not recorded.`,
      );
    }
    definitionVersion = command.definitionVersion;
  }

  // The stage graph the redrive is planned against must be the one the
  // run will actually execute under. Re-pinning to "latest" makes this
  // build authoritative by definition; otherwise this build has to
  // present the pinned version, or the redrive would plan against a
  // different shape than the host that eventually runs it.
  assertServesRun({ ...run, definitionVersion }, workflow);

  const existingStages = await deps.persistence.getStagesByRun(workflowRunId);
  const fromStageId = resolveFromStageId(
    from,
    workflow,
    existingStages,
    workflowRunId,
  );

  if (!workflow.getStage(fromStageId)) {
    throw new Error(
      `Stage ${fromStageId} not found in workflow ${run.workflowId}`,
    );
  }
  const targetGroup = workflow.getExecutionGroupIndex(fromStageId);

  if (targetGroup > 1) {
    const priorStages = existingStages.filter(
      (s) => s.executionGroup < targetGroup,
    );
    if (priorStages.length === 0) {
      throw new Error(
        `Cannot redrive from stage ${fromStageId}: previous stages have not been executed`,
      );
    }
  }

  const stagesToSupersede = existingStages.filter(
    (s) => s.executionGroup >= targetGroup,
  );
  const supersededStageIds = stagesToSupersede.map((s) => s.stageId);

  // ── Preserve the attempt being superseded ──────────────────────────
  // Written before the stage rows are deleted, in the same transaction,
  // so a rollback takes the archive with it.
  if (stagesToSupersede.length > 0) {
    const archive: CreateAnnotationInput[] = stagesToSupersede.map((stage) => ({
      workflowRunId,
      workflowStageRecordId: stage.id,
      attempt: stage.attempt,
      scope: "stage",
      scopeId: stage.stageId,
      actor: { kind: "engine", id: "run.redrive" },
      key: SUPERSEDED_ATTEMPT_KEY,
      value: stage.status,
      payload: {
        redriveCount: run.redriveCount + 1,
        stageRecordId: stage.id,
        stageNumber: stage.stageNumber,
        executionGroup: stage.executionGroup,
        attempt: stage.attempt,
        status: stage.status,
        errorMessage: stage.errorMessage,
        startedAt: stage.startedAt?.toISOString() ?? null,
        completedAt: stage.completedAt?.toISOString() ?? null,
        duration: stage.duration,
        metrics: stage.metrics,
        // The blob key, not the blob: the new attempt writes to the same
        // key, so this records that an output existed and where, not a
        // copy of it.
        outputData: stage.outputData,
        definitionVersion: run.definitionVersion,
      },
      idempotencyKey: `${SUPERSEDED_ATTEMPT_KEY}:${stage.id}:${stage.attempt}`,
    }));
    await deps.persistence.appendAnnotations(archive);
  }

  // Blob deletion is deferred to _postCommit: blob deletes are not part of
  // the database transaction and could not be rolled back with it.
  const blobPrefixesToDelete = stagesToSupersede.map(
    (stage) =>
      `workflow-v2/${run.workflowType}/${workflowRunId}/${stage.stageId}/`,
  );

  for (const stage of stagesToSupersede) {
    await deps.persistence.deleteStage(stage.id);
  }

  await deps.persistence.updateRun(workflowRunId, {
    status: "RUNNING",
    startedAt: deps.clock.now(),
    completedAt: null,
    duration: null,
    output: null,
    totalCost: 0,
    totalTokens: 0,
    redriveCount: run.redriveCount + 1,
    ...(definitionVersion !== run.definitionVersion
      ? { definitionVersion }
      : {}),
  });

  const enqueue = await prepareExecutionGroup(
    { ...run, definitionVersion },
    workflow,
    deps,
    {
      groupIndex: targetGroup,
      attemptMode: "max+1",
      createMode: "create",
      filterPending: false,
      attemptSourceStages: stagesToSupersede,
    },
  );

  events.push({
    type: "workflow:started",
    timestamp: deps.clock.now(),
    workflowRunId,
  });

  return {
    workflowRunId,
    fromStageId,
    supersededStages: supersededStageIds,
    redriveCount: run.redriveCount + 1,
    definitionVersion,
    _events: events,
    _postCommit: async (postDeps) => {
      await postDeps.jobTransport.deleteByRunAndStages(
        workflowRunId,
        supersededStageIds,
      );

      // The step ledger is cleared, not archived: its rows are keyed by
      // the deleted stage record's id, so nothing would ever read them
      // again, and stages in groups after the target are never recreated.
      // What survives the redrive is the annotation archive above, which
      // is the queryable record of the superseded attempt.
      for (const stage of stagesToSupersede) {
        await postDeps.stepLedger?.clear(stage.id);
      }

      for (const prefix of blobPrefixesToDelete) {
        const keys = await postDeps.blobStore
          .list(prefix)
          .catch(() => [] as string[]);
        for (const key of keys) {
          await postDeps.blobStore.delete(key).catch(() => {});
        }
      }

      await enqueue();
    },
  };
}
