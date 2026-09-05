import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { defineWorkflow } from "../../core/workflow.js";
import { createTestKernel } from "../utils/index.js";

function makeStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: {
      input: z.object({ val: z.string() }),
      output: z.object({ val: z.string() }),
      config: z.object({}),
    },
    async execute(ctx) {
      return { output: { val: `${ctx.input.val}:${id}` } };
    },
  });
}

/** One stage. */
function buildV1(id = "test-wf") {
  return defineWorkflow(id, { input: z.object({ val: z.string() }) })
    .pipe(makeStage("a"))
    .build();
}

/** Same workflow id, structurally different: a second stage was added. */
function buildV2(id = "test-wf") {
  return defineWorkflow(id, { input: z.object({ val: z.string() }) })
    .pipe(makeStage("a"))
    .pipe(makeStage("b"))
    .build();
}

describe("run.create: stamping the version and snapshot", () => {
  it("pins the run to the version the definition presents", async () => {
    const workflow = buildV1();
    const { kernel, persistence } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "hello" },
    });

    expect(created.definitionVersion).toBe(workflow.definitionVersion);
    const run = await persistence.getRun(created.workflowRunId);
    expect(run?.definitionVersion).toBe(workflow.definitionVersion);
  });

  it("stores one content-addressed snapshot that many runs reference", async () => {
    const workflow = buildV1();
    const { kernel, persistence } = createTestKernel([workflow]);

    const first = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "one" },
    });
    const second = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k2",
      workflowId: workflow.id,
      input: { val: "two" },
    });

    expect(first.definitionVersion).toBe(second.definitionVersion);

    const definition = await persistence.getDefinition(
      workflow.id,
      workflow.definitionVersion,
    );
    expect(definition).not.toBeNull();
    expect(definition?.structureHash).toBe(workflow.definitionVersion);
    expect((definition?.snapshot as { workflowId: string }).workflowId).toBe(
      workflow.id,
    );
  });

  it("leaves runs unpinned, and working, on a database that has not migrated", async () => {
    const workflow = buildV1();
    const { kernel, persistence } = createTestKernel([workflow]);
    // What an adapter reports when the schema predates definition
    // versioning: no `definitionVersion` column, no definitions table.
    persistence.supportsDefinitionVersioning = () => false;

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "hello" },
    });
    expect(created.definitionVersion).toBeNull();
    expect(
      (await persistence.getRun(created.workflowRunId))?.definitionVersion,
    ).toBeNull();

    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: created.workflowRunId,
      workflowId: workflow.id,
      stageId: "a",
      config: {},
    });
    await kernel.dispatch({
      type: "run.transition",
      workflowRunId: created.workflowRunId,
    });

    expect((await persistence.getRun(created.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });
});

describe("run.claimPending: filtering on the version", () => {
  it("does not adopt a run pinned to a version this build no longer presents", async () => {
    const v1 = buildV1();
    const v2 = buildV2();
    expect(v1.definitionVersion).not.toBe(v2.definitionVersion);

    const { kernel, persistence, registry } = createTestKernel([v1]);
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: v1.id,
      input: { val: "hello" },
    });

    registry.set(v1.id, v2);

    const claimed = await kernel.dispatch({
      type: "run.claimPending",
      workerId: "w1",
    });

    expect(claimed.claimed).toHaveLength(0);
    expect((await persistence.getRun(created.workflowRunId))?.status).toBe(
      "PENDING",
    );
    // Not adopted is not the same as destroyed.
    expect(await persistence.getRunsByStatus("FAILED")).toHaveLength(0);
  });

  it("adopts the run again once a build presenting its version is back", async () => {
    const v1 = buildV1();
    const v2 = buildV2();
    const { kernel, persistence, registry } = createTestKernel([v1]);
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: v1.id,
      input: { val: "hello" },
    });

    registry.set(v1.id, v2);
    expect(
      (await kernel.dispatch({ type: "run.claimPending", workerId: "w1" }))
        .claimed,
    ).toHaveLength(0);

    registry.set(v1.id, v1);
    const claimed = await kernel.dispatch({
      type: "run.claimPending",
      workerId: "w1",
    });

    expect(claimed.claimed).toHaveLength(1);
    expect(claimed.claimed[0].workflowRunId).toBe(created.workflowRunId);
    expect((await persistence.getRun(created.workflowRunId))?.status).toBe(
      "RUNNING",
    );
  });

  it('claims regardless of version with serves: "all"', async () => {
    const v1 = buildV1();
    const v2 = buildV2();
    const { kernel, registry } = createTestKernel([v1]);
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: v1.id,
      input: { val: "hello" },
    });

    registry.set(v1.id, v2);

    const claimed = await kernel.dispatch({
      type: "run.claimPending",
      workerId: "w1",
      serves: "all",
    });

    expect(claimed.claimed).toHaveLength(1);
    expect(claimed.claimed[0].workflowRunId).toBe(created.workflowRunId);
  });
});

describe("job.execute: refusing a run pinned to another version", () => {
  it("re-delivers the job instead of executing the wrong shape or failing the run", async () => {
    const v1 = buildV1();
    const v2 = buildV2();
    const { kernel, persistence, registry } = createTestKernel([v1]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: v1.id,
      input: { val: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // The pipeline changes under a run that is already RUNNING.
    registry.set(v1.id, v2);

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: created.workflowRunId,
      workflowId: v1.id,
      stageId: "a",
      config: {},
    });

    expect(result.outcome).toBe("failed");
    expect(result.ghost).toBe(true);
    expect(result.ghostReason).toBe("version");
    expect(result.error).toContain(v1.definitionVersion);
    expect((await persistence.getRun(created.workflowRunId))?.status).toBe(
      "RUNNING",
    );
  });
});

describe("run.listVersions: has it drained?", () => {
  async function runToCompletion(
    kernel: ReturnType<typeof createTestKernel>["kernel"],
    workflowId: string,
    idempotencyKey: string,
  ) {
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey,
      workflowId,
      input: { val: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: created.workflowRunId,
      workflowId,
      stageId: "a",
      config: {},
    });
    await kernel.dispatch({
      type: "run.transition",
      workflowRunId: created.workflowRunId,
    });
    return created.workflowRunId;
  }

  it("reports a version as undrained while any run at it still needs a host", async () => {
    const v1 = buildV1();
    const { kernel } = createTestKernel([v1]);

    await runToCompletion(kernel, v1.id, "k1");
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k2",
      workflowId: v1.id,
      input: { val: "pending" },
    });

    const result = await kernel.dispatch({
      type: "run.listVersions",
      workflowId: v1.id,
    });

    expect(result.supported).toBe(true);
    expect(result.versions).toHaveLength(1);
    const summary = result.versions[0];
    expect(summary.definitionVersion).toBe(v1.definitionVersion);
    expect(summary.counts).toEqual({ COMPLETED: 1, PENDING: 1 });
    expect(summary.total).toBe(2);
    expect(summary.active).toBe(1);
    expect(summary.drained).toBe(false);
    expect(summary.servedHere).toBe(true);
  });

  it("reports a version as drained once nothing at it needs a host", async () => {
    const v1 = buildV1();
    const { kernel } = createTestKernel([v1]);

    await runToCompletion(kernel, v1.id, "k1");

    const result = await kernel.dispatch({
      type: "run.listVersions",
      workflowId: v1.id,
    });

    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].drained).toBe(true);
    expect(result.versions[0].active).toBe(0);
    expect(result.unservedHere).toHaveLength(0);
  });

  it("surfaces a version with live runs that this build cannot serve", async () => {
    const v1 = buildV1();
    const v2 = buildV2();
    const { kernel, registry } = createTestKernel([v1]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: v1.id,
      input: { val: "hello" },
    });
    registry.set(v1.id, v2);

    const result = await kernel.dispatch({
      type: "run.listVersions",
      workflowId: v1.id,
    });

    expect(result.unservedHere).toHaveLength(1);
    expect(result.unservedHere[0].definitionVersion).toBe(v1.definitionVersion);
    expect(result.unservedHere[0].servedHere).toBe(false);
    expect(result.unservedHere[0].active).toBe(1);
  });

  it("says so plainly on a database that has not migrated", async () => {
    const v1 = buildV1();
    const { kernel, persistence } = createTestKernel([v1]);
    persistence.supportsDefinitionVersioning = () => false;

    const result = await kernel.dispatch({ type: "run.listVersions" });

    expect(result).toEqual({
      supported: false,
      versions: [],
      unservedHere: [],
    });
  });
});
