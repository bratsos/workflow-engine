import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { defineWorkflow } from "../../core/workflow.js";
import { SUPERSEDED_ATTEMPT_KEY } from "../../kernel/handlers/run-redrive.js";
import { createTestKernel } from "../utils/index.js";

const schemas = {
  input: z.object({ val: z.string() }),
  output: z.object({ val: z.string() }),
  config: z.object({}),
};

function passing(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas,
    async execute(ctx) {
      return { output: { val: `${ctx.input.val}:${id}` } };
    },
  });
}

function failing(id: string, failures: { count: number }) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas,
    async execute(ctx) {
      if (failures.count > 0) {
        failures.count -= 1;
        throw new Error(`stage ${id} blew up`);
      }
      return { output: { val: `${ctx.input.val}:${id}` } };
    },
  });
}

/** Drives a run until it reaches a terminal state or runs out of stages. */
async function drive(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  workflowRunId: string,
  workflowId: string,
  stageIds: string[],
) {
  for (const stageId of stageIds) {
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId,
      stageId,
      config: {},
    });
    await kernel.dispatch({ type: "run.transition", workflowRunId });
  }
}

describe("run.redrive", () => {
  it("retries from the stage that failed, leaving completed stages untouched", async () => {
    const failures = { count: 1 };
    const workflow = defineWorkflow("redrive-retry", {
      input: z.object({ val: z.string() }),
    })
      .pipe(passing("a"))
      .pipe(failing("b", failures))
      .build();
    const { kernel, persistence } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "seed" },
    });
    const runId = created.workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await drive(kernel, runId, workflow.id, ["a", "b"]);
    expect((await persistence.getRun(runId))?.status).toBe("FAILED");

    const result = await kernel.dispatch({
      type: "run.redrive",
      workflowRunId: runId,
      from: { kind: "lastFailure" },
    });

    expect(result.fromStageId).toBe("b");
    expect(result.supersededStages).toEqual(["b"]);
    expect(result.redriveCount).toBe(1);

    // Stage "a" was never touched.
    const stageA = await persistence.getStage(runId, "a");
    expect(stageA?.status).toBe("COMPLETED");
    expect(stageA?.attempt).toBe(0);

    await drive(kernel, runId, workflow.id, ["b"]);
    expect((await persistence.getRun(runId))?.status).toBe("COMPLETED");
  });

  it("restarts the whole pipeline from the first execution group", async () => {
    const workflow = defineWorkflow("redrive-restart", {
      input: z.object({ val: z.string() }),
    })
      .pipe(passing("a"))
      .pipe(passing("b"))
      .build();
    const { kernel, persistence } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "seed" },
    });
    const runId = created.workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await drive(kernel, runId, workflow.id, ["a", "b"]);
    expect((await persistence.getRun(runId))?.status).toBe("COMPLETED");

    const result = await kernel.dispatch({
      type: "run.redrive",
      workflowRunId: runId,
      from: { kind: "start" },
    });

    expect(result.fromStageId).toBe("a");
    expect(result.supersededStages.sort()).toEqual(["a", "b"]);
    expect((await persistence.getStage(runId, "a"))?.status).toBe("PENDING");
    expect(await persistence.getStage(runId, "b")).toBeNull();
  });

  it("reruns from a chosen stage", async () => {
    const workflow = defineWorkflow("redrive-rerun", {
      input: z.object({ val: z.string() }),
    })
      .pipe(passing("a"))
      .pipe(passing("b"))
      .pipe(passing("c"))
      .build();
    const { kernel, persistence } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "seed" },
    });
    const runId = created.workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await drive(kernel, runId, workflow.id, ["a", "b", "c"]);

    const result = await kernel.dispatch({
      type: "run.redrive",
      workflowRunId: runId,
      from: { kind: "stage", stageId: "b" },
    });

    expect(result.fromStageId).toBe("b");
    expect(result.supersededStages.sort()).toEqual(["b", "c"]);
    expect((await persistence.getStage(runId, "a"))?.status).toBe("COMPLETED");
  });

  it("preserves the superseded attempt instead of destroying it", async () => {
    const failures = { count: 1 };
    const workflow = defineWorkflow("redrive-archive", {
      input: z.object({ val: z.string() }),
    })
      .pipe(failing("a", failures))
      .build();
    const { kernel, persistence } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "seed" },
    });
    const runId = created.workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await drive(kernel, runId, workflow.id, ["a"]);

    await kernel.dispatch({ type: "run.redrive", workflowRunId: runId });

    // The stage row is gone, but the attempt that failed is on the record.
    const archived = await kernel.annotations.list(runId, {
      key: SUPERSEDED_ATTEMPT_KEY,
    });
    expect(archived).toHaveLength(1);
    expect(archived[0].scopeId).toBe("a");
    expect(archived[0].value).toBe("FAILED");
    const payload = archived[0].payload as Record<string, unknown>;
    expect(payload.errorMessage).toContain("blew up");
    expect(payload.attempt).toBe(0);
    expect(payload.redriveCount).toBe(1);

    // ...and the run itself counts the redrive.
    expect((await persistence.getRun(runId))?.redriveCount).toBe(1);
  });

  it("moves a run onto the definition version this process serves", async () => {
    const v1 = defineWorkflow("redrive-version", {
      input: z.object({ val: z.string() }),
    })
      .pipe(passing("a"))
      .build();
    const v2 = defineWorkflow("redrive-version", {
      input: z.object({ val: z.string() }),
    })
      .pipe(passing("a"))
      .pipe(passing("b"))
      .build();
    const { kernel, persistence, registry } = createTestKernel([v1]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: v1.id,
      input: { val: "seed" },
    });
    const runId = created.workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await drive(kernel, runId, v1.id, ["a"]);
    expect((await persistence.getRun(runId))?.status).toBe("COMPLETED");

    // The pipeline moved on; this run is pinned to a version nobody serves.
    registry.set(v1.id, v2);
    const stranded = await kernel.dispatch({ type: "run.listVersions" });
    expect(stranded.versions[0].servedHere).toBe(false);

    await expect(
      kernel.dispatch({
        type: "run.redrive",
        workflowRunId: runId,
        from: { kind: "start" },
      }),
    ).rejects.toThrow(/pinned to definition version/);

    const result = await kernel.dispatch({
      type: "run.redrive",
      workflowRunId: runId,
      from: { kind: "start" },
      definitionVersion: "latest",
    });

    expect(result.definitionVersion).toBe(v2.definitionVersion);
    expect((await persistence.getRun(runId))?.definitionVersion).toBe(
      v2.definitionVersion,
    );

    // And it now runs the stage the new definition added.
    await drive(kernel, runId, v2.id, ["a", "b"]);
    expect((await persistence.getRun(runId))?.status).toBe("COMPLETED");
  });

  it("refuses a definition version that was never registered", async () => {
    const workflow = defineWorkflow("redrive-unknown-version", {
      input: z.object({ val: z.string() }),
    })
      .pipe(passing("a"))
      .build();
    const { kernel } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "seed" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await drive(kernel, created.workflowRunId, workflow.id, ["a"]);

    await expect(
      kernel.dispatch({
        type: "run.redrive",
        workflowRunId: created.workflowRunId,
        definitionVersion: "sha256-nothingregisteredunderthisversion",
      }),
    ).rejects.toThrow(/its structure is not recorded/);
  });

  it("refuses to redrive a run that is still running", async () => {
    const workflow = defineWorkflow("redrive-running", {
      input: z.object({ val: z.string() }),
    })
      .pipe(passing("a"))
      .build();
    const { kernel } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "seed" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    await expect(
      kernel.dispatch({
        type: "run.redrive",
        workflowRunId: created.workflowRunId,
      }),
    ).rejects.toThrow(/Must be COMPLETED, FAILED or CANCELLED/);
  });
});

describe("run.rerunFrom (deprecated)", () => {
  it("still works, and no longer destroys the attempt it supersedes", async () => {
    const workflow = defineWorkflow("rerun-compat", {
      input: z.object({ val: z.string() }),
    })
      .pipe(passing("a"))
      .pipe(passing("b"))
      .build();
    const { kernel, persistence } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "seed" },
    });
    const runId = created.workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await drive(kernel, runId, workflow.id, ["a", "b"]);

    const result = await kernel.dispatch({
      type: "run.rerunFrom",
      workflowRunId: runId,
      fromStageId: "b",
    });

    // Unchanged result shape.
    expect(result.workflowRunId).toBe(runId);
    expect(result.fromStageId).toBe("b");
    expect(result.deletedStages).toEqual(["b"]);

    const archived = await kernel.annotations.list(runId, {
      key: SUPERSEDED_ATTEMPT_KEY,
    });
    expect(archived.map((a) => a.scopeId)).toEqual(["b"]);
    expect((await persistence.getRun(runId))?.redriveCount).toBe(1);
  });

  it("still refuses a cancelled run, which run.redrive allows", async () => {
    const workflow = defineWorkflow("rerun-cancelled", {
      input: z.object({ val: z.string() }),
    })
      .pipe(passing("a"))
      .build();
    const { kernel } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "seed" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await kernel.dispatch({
      type: "run.cancel",
      workflowRunId: created.workflowRunId,
    });

    await expect(
      kernel.dispatch({
        type: "run.rerunFrom",
        workflowRunId: created.workflowRunId,
        fromStageId: "a",
      }),
    ).rejects.toThrow(/Must be COMPLETED or FAILED/);

    const result = await kernel.dispatch({
      type: "run.redrive",
      workflowRunId: created.workflowRunId,
      from: { kind: "start" },
    });
    expect(result.fromStageId).toBe("a");
  });
});
