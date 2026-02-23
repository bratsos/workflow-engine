import { beforeEach, describe, expect, it } from "vitest";
import { StaleVersionError } from "../../persistence/interface.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

describe("kernel: optimistic concurrency", () => {
  let persistence: InMemoryWorkflowPersistence;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
  });

  it("run version starts at 1 and increments on update", async () => {
    const run = await persistence.createRun({
      workflowId: "test",
      workflowName: "Test",
      workflowType: "test",
      input: {},
    });
    expect(run.version).toBe(1);

    await persistence.updateRun(run.id, { status: "RUNNING" });
    const updated = await persistence.getRun(run.id);
    expect(updated!.version).toBe(2);

    await persistence.updateRun(run.id, { status: "COMPLETED" });
    const completed = await persistence.getRun(run.id);
    expect(completed!.version).toBe(3);
  });

  it("stage version starts at 1 and increments on update", async () => {
    const run = await persistence.createRun({
      workflowId: "test",
      workflowName: "Test",
      workflowType: "test",
      input: {},
    });

    const stage = await persistence.createStage({
      workflowRunId: run.id,
      stageId: "s1",
      stageName: "Stage 1",
      stageNumber: 1,
      executionGroup: 1,
    });
    expect(stage.version).toBe(1);

    await persistence.updateStage(stage.id, { status: "RUNNING" });
    const updated = await persistence.getStageById(stage.id);
    expect(updated!.version).toBe(2);
  });

  it("updateRun with correct expectedVersion succeeds", async () => {
    const run = await persistence.createRun({
      workflowId: "test",
      workflowName: "Test",
      workflowType: "test",
      input: {},
    });

    await persistence.updateRun(run.id, {
      status: "RUNNING",
      expectedVersion: 1,
    });

    const updated = await persistence.getRun(run.id);
    expect(updated!.status).toBe("RUNNING");
    expect(updated!.version).toBe(2);
  });

  it("updateRun with stale expectedVersion throws StaleVersionError", async () => {
    const run = await persistence.createRun({
      workflowId: "test",
      workflowName: "Test",
      workflowType: "test",
      input: {},
    });

    // Update once to increment version to 2
    await persistence.updateRun(run.id, { status: "RUNNING" });

    // Try to update with stale version 1
    await expect(
      persistence.updateRun(run.id, {
        status: "COMPLETED",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(StaleVersionError);
  });

  it("updateStage with stale expectedVersion throws StaleVersionError", async () => {
    const run = await persistence.createRun({
      workflowId: "test",
      workflowName: "Test",
      workflowType: "test",
      input: {},
    });

    const stage = await persistence.createStage({
      workflowRunId: run.id,
      stageId: "s1",
      stageName: "Stage 1",
      stageNumber: 1,
      executionGroup: 1,
    });

    // Update once to increment version to 2
    await persistence.updateStage(stage.id, { status: "RUNNING" });

    // Try to update with stale version 1
    await expect(
      persistence.updateStage(stage.id, {
        status: "COMPLETED",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(StaleVersionError);
  });

  it("claimPendingRun increments version", async () => {
    const run = await persistence.createRun({
      workflowId: "test",
      workflowName: "Test",
      workflowType: "test",
      input: {},
    });
    expect(run.version).toBe(1);

    const claimed = await persistence.claimPendingRun(run.id);
    expect(claimed).toBe(true);

    const updated = await persistence.getRun(run.id);
    expect(updated!.version).toBe(2);
    expect(updated!.status).toBe("RUNNING");
  });
});
