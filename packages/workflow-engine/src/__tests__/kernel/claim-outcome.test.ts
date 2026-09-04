import { describe, expect, it } from "vitest";
import { handleClaimOutcome } from "../../kernel/helpers/claim.js";
import type { KernelDeps } from "../../kernel/kernel.js";
import { createTestKernel } from "../utils/index.js";

async function suspendedStage() {
  const { persistence, clock } = createTestKernel([]);
  const run = await persistence.createRun({
    workflowId: "wf",
    workflowName: "Workflow",
    workflowType: "wf",
    input: {},
  });
  await persistence.updateRun(run.id, { status: "RUNNING" });
  const stage = await persistence.createStage({
    workflowRunId: run.id,
    stageId: "stage",
    stageName: "Stage",
    stageNumber: 1,
    executionGroup: 1,
    status: "SUSPENDED",
    startedAt: clock.now(),
  });
  await persistence.updateStage(stage.id, {
    nextPollAt: new Date(clock.now().getTime() + 60_000),
  });
  const deps = { persistence, clock } as unknown as KernelDeps;
  const read = async () => (await persistence.getStage(run.id, "stage"))!;
  return { stage: await read(), deps, read };
}

describe("kernel: handleClaimOutcome", () => {
  it("leaves the stage untouched when the run was finished by another orchestrator", async () => {
    const { stage, deps, read } = await suspendedStage();

    const skip = await handleClaimOutcome(
      { status: "cancelled", runStatus: "COMPLETED", message: "" },
      stage,
      deps,
    );

    expect(skip).toBe(true);
    const after = await read();
    expect(after.status).toBe("SUSPENDED");
    expect(after.nextPollAt).toEqual(stage.nextPollAt);
    expect(after.version).toBe(stage.version);
  });

  it("marks the stage cancelled when the run really was cancelled", async () => {
    const { stage, deps, read } = await suspendedStage();

    const skip = await handleClaimOutcome(
      { status: "cancelled", runStatus: "CANCELLED", message: "" },
      stage,
      deps,
    );

    expect(skip).toBe(true);
    const after = await read();
    expect(after.status).toBe("CANCELLED");
    expect(after.nextPollAt).toBeNull();
  });
});
