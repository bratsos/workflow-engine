/**
 * A redrive must not orphan a billed effect silently.
 *
 * `run.redrive` (and `run.rerunFrom`, which delegates to it) deletes the
 * stage records it supersedes and clears their step ledgers. Those rows
 * genuinely cannot be preserved: they are keyed by a stage record id that
 * no longer exists. But a `run` row may hold the external key of a batch a
 * provider is still processing and still billing, and dropping it without
 * a word leaves that effect with no record anywhere.
 *
 * So the rows are read before the delete and what they name is written
 * down twice: a WARN log, and the superseded-attempt annotation, which
 * survives on the run after the log has rotated away.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { SUPERSEDED_ATTEMPT_KEY } from "../../kernel/handlers/run-redrive.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

const outputSchema = z.object({ handleId: z.string() });

function submittingStage(id: string, fail: { yes: boolean }) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: {
      input: z.object({}),
      output: outputSchema,
      config: z.object({}),
    },
    async execute(ctx) {
      const handle = await ctx.step.run("submit", async () => ({
        handleId: "batch-1",
      }));
      if (fail.yes) throw new Error("provider said no");
      return { output: handle };
    },
  });
}

describe("run.redrive with a live external effect", () => {
  it("records the step ids, statuses and external keys it abandons", async () => {
    const ledger = new InMemoryStepLedger();
    const fail = { yes: true };
    const stage = submittingStage("submit-stage", fail);
    const workflow = new WorkflowBuilder(
      "redrive-abandon",
      "Redrive abandon",
      "test",
      z.object({}),
      outputSchema,
    )
      .pipe(stage)
      .build();
    const { kernel, persistence } = createTestKernel([workflow], {
      stepLedger: ledger,
    });

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "abandon-run",
      workflowId: workflow.id,
      input: {},
    });
    const runId = created.workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: workflow.id,
      stageId: stage.id,
      config: {},
    });

    const stageRecord = await persistence.getStage(runId, stage.id);
    const submitted = await ledger.get(stageRecord!.id, "submit");
    expect(submitted?.externalKey).toEqual(expect.any(String));
    const externalKey = submitted!.externalKey!;

    // Whatever put the stage into a terminal state, the operator now
    // redrives the run — and the batch behind `submit` is still live.
    await persistence.updateStage(stageRecord!.id, {
      status: "FAILED",
      errorMessage: "attempts exhausted",
    });
    await persistence.updateRun(runId, { status: "FAILED" });

    fail.yes = false;
    await kernel.dispatch({ type: "run.redrive", workflowRunId: runId });

    // The ledger rows are gone, as they must be.
    expect(await ledger.list(stageRecord!.id)).toHaveLength(0);

    // The annotation survives on the run and names the key.
    const archived = await kernel.annotations.list(runId, {
      key: SUPERSEDED_ATTEMPT_KEY,
    });
    expect(archived).toHaveLength(1);
    const payload = archived[0].payload as Record<string, unknown>;
    expect(payload.abandonedSteps).toEqual([
      { stepId: "submit", status: "completed", externalKey },
    ]);

    // ...and so does a WARN log, for the operator watching the run now.
    const warn = persistence
      .getAllLogs()
      .filter((log) => log.level === "WARN" && log.workflowRunId === runId);
    expect(warn).toHaveLength(1);
    expect(warn[0].message).toContain("abandoned 1 durable step row");
    expect(warn[0].metadata).toEqual({
      steps: [{ stepId: "submit", status: "completed", externalKey }],
    });
  });

  it("says nothing when no abandoned row names an external effect", async () => {
    const ledger = new InMemoryStepLedger();
    const stage = defineStage({
      id: "plain",
      name: "Plain",
      schemas: {
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        config: z.object({}),
      },
      async execute() {
        return { output: { ok: true } };
      },
    });
    const workflow = new WorkflowBuilder(
      "redrive-quiet",
      "Redrive quiet",
      "test",
      z.object({}),
      z.object({ ok: z.boolean() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence } = createTestKernel([workflow], {
      stepLedger: ledger,
    });

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "quiet-run",
      workflowId: workflow.id,
      input: {},
    });
    const runId = created.workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: workflow.id,
      stageId: stage.id,
      config: {},
    });
    await kernel.dispatch({ type: "run.transition", workflowRunId: runId });

    await kernel.dispatch({ type: "run.redrive", workflowRunId: runId });

    const archived = await kernel.annotations.list(runId, {
      key: SUPERSEDED_ATTEMPT_KEY,
    });
    expect(archived).toHaveLength(1);
    expect(
      (archived[0].payload as Record<string, unknown>).abandonedSteps,
    ).toBeUndefined();
    expect(
      persistence.getAllLogs().filter((log) => log.level === "WARN"),
    ).toHaveLength(0);
  });
});
