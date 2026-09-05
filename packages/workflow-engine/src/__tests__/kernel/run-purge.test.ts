import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

const schema = z.object({ data: z.string() });

function createSteppedWorkflow(id = "purge-workflow") {
  const stage = defineStage({
    id: "stage-1",
    name: "Stage 1",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      const data = await ctx.step.run("work", async () => ctx.input.data);
      return { output: { data } };
    },
  });
  return new WorkflowBuilder(id, "Purge Workflow", "purge-type", schema, schema)
    .pipe(stage)
    .build();
}

async function runToCompletion(
  fixture: ReturnType<typeof createTestKernel>,
  workflowId: string,
  idempotencyKey: string,
) {
  const { kernel, jobTransport } = fixture;
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    idempotencyKey,
    workflowId,
    input: { data: idempotencyKey },
  });
  await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
  const job = await jobTransport.dequeue();
  await kernel.dispatch({
    type: "job.execute",
    workflowRunId: job!.workflowRunId,
    workflowId: job!.workflowId,
    stageId: job!.stageId,
    config: {},
  });
  await jobTransport.complete(job!.jobId);
  await kernel.dispatch({ type: "run.transition", workflowRunId });
  return workflowRunId;
}

describe("kernel: run.purge", () => {
  it("deletes an old completed run with its ledger, blobs, job rows and stages", async () => {
    const workflow = createSteppedWorkflow();
    const ledger = new InMemoryStepLedger();
    const fixture = createTestKernel([workflow], {
      clockStart: new Date("2025-01-01T00:00:00Z"),
      stepLedger: ledger,
    });
    const { kernel, persistence, blobStore, jobTransport, clock } = fixture;

    const runId = await runToCompletion(fixture, workflow.id, "run-1");
    const [stage] = await persistence.getStagesByRun(runId);
    expect((await ledger.list(stage!.id)).length).toBeGreaterThan(0);
    expect(
      (await blobStore.list(`workflow-v2/${workflow.id}/${runId}/`)).length,
    ).toBeGreaterThan(0);
    expect(await jobTransport.getJobsByWorkflowRun(runId)).toHaveLength(1);

    clock.advance(8 * 24 * 60 * 60 * 1000);
    const result = await kernel.dispatch({
      type: "run.purge",
      olderThan: new Date(clock.now().getTime() - 7 * 24 * 60 * 60 * 1000),
    });

    expect(result).toEqual({ purged: 1, workflowRunIds: [runId] });
    expect(await persistence.getRun(runId)).toBeNull();
    expect(await persistence.getStagesByRun(runId)).toEqual([]);
    expect(await ledger.list(stage!.id)).toEqual([]);
    expect(
      await blobStore.list(`workflow-v2/${workflow.id}/${runId}/`),
    ).toEqual([]);
    expect(await jobTransport.getJobsByWorkflowRun(runId)).toEqual([]);
  });

  it("leaves recent and non-terminal runs alone and emits no events", async () => {
    const workflow = createSteppedWorkflow();
    const fixture = createTestKernel([workflow], {
      clockStart: new Date("2025-01-01T00:00:00Z"),
      stepLedger: new InMemoryStepLedger(),
    });
    const { kernel, persistence, clock } = fixture;

    const oldRun = await runToCompletion(fixture, workflow.id, "old");
    clock.advance(8 * 24 * 60 * 60 * 1000);
    const recentRun = await runToCompletion(fixture, workflow.id, "recent");
    const { workflowRunId: pendingRun } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "pending",
      workflowId: workflow.id,
      input: { data: "pending" },
    });

    const outboxBefore = (await persistence.getUnpublishedOutboxEvents(100))
      .length;
    const result = await kernel.dispatch({
      type: "run.purge",
      olderThan: new Date(clock.now().getTime() - 7 * 24 * 60 * 60 * 1000),
    });

    expect(result.workflowRunIds).toEqual([oldRun]);
    expect(await persistence.getRun(recentRun)).not.toBeNull();
    expect(await persistence.getRun(pendingRun)).not.toBeNull();
    expect((await persistence.getUnpublishedOutboxEvents(100)).length).toBe(
      outboxBefore,
    );
  });

  it("honours statuses and limit", async () => {
    const workflow = createSteppedWorkflow();
    const fixture = createTestKernel([workflow], {
      clockStart: new Date("2025-01-01T00:00:00Z"),
      stepLedger: new InMemoryStepLedger(),
    });
    const { kernel, persistence, clock } = fixture;

    const completedA = await runToCompletion(fixture, workflow.id, "a");
    const completedB = await runToCompletion(fixture, workflow.id, "b");
    const { workflowRunId: cancelled } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "c",
      workflowId: workflow.id,
      input: { data: "c" },
    });
    await kernel.dispatch({ type: "run.cancel", workflowRunId: cancelled });
    clock.advance(60_000);
    const olderThan = clock.now();

    const onlyCancelled = await kernel.dispatch({
      type: "run.purge",
      olderThan,
      statuses: ["CANCELLED"],
    });
    expect(onlyCancelled.workflowRunIds).toEqual([cancelled]);
    expect(await persistence.getRun(completedA)).not.toBeNull();

    const limited = await kernel.dispatch({
      type: "run.purge",
      olderThan,
      limit: 1,
    });
    expect(limited.purged).toBe(1);
    const remaining = await kernel.dispatch({ type: "run.purge", olderThan });
    expect(remaining.purged).toBe(1);
    expect(
      [
        ...onlyCancelled.workflowRunIds,
        ...limited.workflowRunIds,
        ...remaining.workflowRunIds,
      ].sort(),
    ).toEqual([cancelled, completedA, completedB].sort());
  });
});
