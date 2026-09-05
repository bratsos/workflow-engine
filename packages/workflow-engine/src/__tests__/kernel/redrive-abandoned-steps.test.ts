/**
 * A redrive must not orphan a billed effect silently.
 *
 * Resuming a run (`lastFailure`, `stage`) reopens the resumed stage record
 * and keeps its ledger, so nothing is abandoned there. Two paths still drop
 * rows: `from: { kind: "start" }` deletes every stage record (and `run.redrive`
 * always deletes the records in groups after the resumed one), whose rows
 * are keyed by a stage record id that no longer exists; and a `StepLedger`
 * without `clearExcept` cannot keep some rows of a reopened record and drop
 * the rest, so it drops them all. Either way a `run` row may hold the
 * external key of a batch a provider is still processing and still billing,
 * and dropping it without a word leaves that effect with no record
 * anywhere.
 *
 * So the rows are read before anything is touched and what is about to be
 * dropped is written down twice: a WARN log, and the superseded-attempt
 * annotation, which survives on the run after the log has rotated away.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { SUPERSEDED_ATTEMPT_KEY } from "../../kernel/handlers/run-redrive.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel, wrapStepLedger } from "../utils/index.js";

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
  it("records the step ids, statuses and external keys a restart abandons", async () => {
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
    // A restart replaces the record, so its rows cannot be kept.
    await kernel.dispatch({
      type: "run.redrive",
      workflowRunId: runId,
      from: { kind: "start" },
    });

    // The ledger rows are gone, as they must be.
    expect(await ledger.list(stageRecord!.id)).toHaveLength(0);

    // The annotation survives on the run and names the key.
    const archived = await kernel.annotations.list(runId, {
      key: SUPERSEDED_ATTEMPT_KEY,
    });
    expect(archived).toHaveLength(1);
    const payload = archived[0].payload as Record<string, unknown>;
    expect(payload.reopened).toBe(false);
    expect(payload.abandonedSteps).toEqual([
      { stepId: "submit", status: "completed", externalKey },
    ]);

    // ...and so does a WARN log, for the operator watching the run now.
    const warn = persistence
      .getAllLogs()
      .filter((log) => log.level === "WARN" && log.workflowRunId === runId);
    expect(warn).toHaveLength(1);
    expect(warn[0].message).toContain("abandoned 1 durable step row");
    expect(warn[0].message).toContain(
      "keyed by stage records this redrive deletes",
    );
    expect(warn[0].metadata).toEqual({
      steps: [{ stepId: "submit", status: "completed", externalKey }],
    });
  });

  it("falls back to dropping a reopened stage's rows when the ledger cannot clear selectively", async () => {
    // A ledger without `clearExcept`: it cannot keep the completed submit
    // and drop the wait's deadline, so a resume loses both - and says so
    // in the same words `job.execute` uses on the same ledger.
    const ledger = wrapStepLedger(new InMemoryStepLedger(), {
      clearExcept: undefined,
    });
    const fail = { yes: true };
    const stage = defineStage({
      id: "submit-then-wait",
      name: "Submit then wait",
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
        await ctx.step.waitFor("poll", {
          poll: async () => ({ ready: true }),
          ready: (value) => value.ready,
          every: 1_000,
          timeout: 10_000,
        });
        return { output: handle };
      },
    });
    const workflow = new WorkflowBuilder(
      "redrive-fallback",
      "Redrive fallback",
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
      idempotencyKey: "fallback-run",
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
    const externalKey = (await ledger.get(stageRecord!.id, "submit"))!
      .externalKey!;
    // A wait row that a resume would drop, so the reset is partial.
    await ledger.claim({
      stageRecordId: stageRecord!.id,
      stepId: "poll",
      seq: 2,
      kind: "wait",
      status: "pending",
      attempt: 1,
      leaseExpiresAt: null,
      deadlineAt: new Date(Date.now() + 10_000),
      externalKey: null,
    });
    await persistence.updateStage(stageRecord!.id, {
      status: "FAILED",
      errorMessage: "attempts exhausted",
    });
    await persistence.updateRun(runId, { status: "FAILED" });

    fail.yes = false;
    await kernel.dispatch({ type: "run.redrive", workflowRunId: runId });

    // The record was reopened, but its rows are gone.
    expect((await persistence.getStage(runId, stage.id))?.id).toBe(
      stageRecord!.id,
    );
    expect(await ledger.list(stageRecord!.id)).toHaveLength(0);

    const archived = await kernel.annotations.list(runId, {
      key: SUPERSEDED_ATTEMPT_KEY,
    });
    const payload = archived[0].payload as Record<string, unknown>;
    expect(payload.reopened).toBe(true);
    expect(payload.abandonedSteps).toEqual([
      { stepId: "submit", status: "completed", externalKey },
    ]);

    const warn = persistence
      .getAllLogs()
      .filter((log) => log.level === "WARN" && log.workflowRunId === runId);
    expect(warn).toHaveLength(1);
    expect(warn[0].message).toContain("abandoned 1 durable step row");
    expect(warn[0].message).toContain(
      "this StepLedger cannot clear selectively",
    );
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
    expect((archived[0].payload as Record<string, unknown>).reopened).toBe(
      true,
    );
    expect(
      (archived[0].payload as Record<string, unknown>).abandonedSteps,
    ).toBeUndefined();
    expect(
      persistence.getAllLogs().filter((log) => log.level === "WARN"),
    ).toHaveLength(0);
  });
});
