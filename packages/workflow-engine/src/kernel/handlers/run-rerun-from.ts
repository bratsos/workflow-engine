/**
 * Handler: run.rerunFrom
 *
 * @deprecated Superseded by `run.redrive`, which splits this single verb
 * into Conductor's three (retry from the last failure, restart from the
 * beginning, rerun from a chosen stage) and can move the run onto a
 * different definition version.
 *
 * Kept working, and now sharing `run.redrive`'s behaviour - which means it
 * no longer destroys the attempt it supersedes: every stage record it
 * removes is archived as a stage-scoped annotation first. Its result shape
 * is unchanged, so existing callers need no edit; `deletedStages` reports
 * the same stage ids `run.redrive` reports as `supersededStages`.
 */

import type { RunRerunFromCommand, RunRerunFromResult } from "../commands";
import type { HandlerResult, KernelDeps } from "../kernel";
import { handleRunRedrive } from "./run-redrive.js";

export async function handleRunRerunFrom(
  command: RunRerunFromCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunRerunFromResult>> {
  const { workflowRunId, fromStageId } = command;

  // `run.rerunFrom` has always refused a CANCELLED run, and its message is
  // part of its documented surface. `run.redrive` allows one; keep the
  // narrower contract here rather than widening it under a deprecated
  // command.
  const run = await deps.persistence.getRun(workflowRunId);
  if (!run) throw new Error(`WorkflowRun ${workflowRunId} not found`);
  if (run.status !== "COMPLETED" && run.status !== "FAILED") {
    throw new Error(
      `Cannot rerun workflow in ${run.status} state. Must be COMPLETED or FAILED.`,
    );
  }

  const result = await handleRunRedrive(
    {
      type: "run.redrive",
      workflowRunId,
      from: { kind: "stage", stageId: fromStageId },
      idempotencyKey: command.idempotencyKey,
    },
    deps,
  );

  return {
    workflowRunId: result.workflowRunId,
    fromStageId: result.fromStageId,
    deletedStages: result.supersededStages,
    _events: result._events,
    _postCommit: result._postCommit,
  };
}
