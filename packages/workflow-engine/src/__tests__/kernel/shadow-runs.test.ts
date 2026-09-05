import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { defineWorkflow } from "../../core/workflow.js";
import {
  assertShadowCompatible,
  shadowRuns,
  shadowVersions,
} from "../../testing/shadow-runs.js";
import { createTestKernel } from "../utils/index.js";

function makeStage(id: string, config = z.object({})) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: {
      input: z.object({ val: z.string() }),
      output: z.object({ val: z.string() }),
      config,
    },
    async execute(ctx) {
      return { output: { val: `${ctx.input.val}:${id}` } };
    },
  });
}

function pipeline(stageIds: string[], id = "shadow-wf") {
  let builder = defineWorkflow(id, { input: z.object({ val: z.string() }) });
  for (const stageId of stageIds) {
    builder = builder.pipe(makeStage(stageId)) as typeof builder;
  }
  return builder.build();
}

/** Creates a run and executes `throughStages` of it, leaving the rest pending. */
async function seedRun(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  workflowId: string,
  idempotencyKey: string,
  throughStages: string[],
) {
  const created = await kernel.dispatch({
    type: "run.create",
    idempotencyKey,
    workflowId,
    input: { val: "seed" },
  });
  await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
  for (const stageId of throughStages) {
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: created.workflowRunId,
      workflowId,
      stageId,
      config: {},
    });
    await kernel.dispatch({
      type: "run.transition",
      workflowRunId: created.workflowRunId,
    });
  }
  return created.workflowRunId;
}

describe("shadowRuns", () => {
  it("passes a run against the definition it was created under", async () => {
    const workflow = pipeline(["a", "b"]);
    const { kernel, persistence } = createTestKernel([workflow]);
    const runId = await seedRun(kernel, workflow.id, "k1", ["a"]);

    const report = await shadowRuns({
      persistence,
      candidates: [workflow],
      runIds: [runId],
    });

    expect(report.ok).toBe(true);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].recordedStages).toContain("a");
    expect(report.runs[0].pinnedVersion).toBe(workflow.definitionVersion);
    expect(report.runs[0].candidateVersion).toBe(workflow.definitionVersion);
    expect(() => assertShadowCompatible(report)).not.toThrow();
  });

  it("fails a candidate that removes a stage the run already executed", async () => {
    const before = pipeline(["a", "b"]);
    const { kernel, persistence } = createTestKernel([before]);
    const runId = await seedRun(kernel, before.id, "k1", ["a"]);

    const after = pipeline(["b"], before.id);
    const report = await shadowRuns({
      persistence,
      candidates: [after],
      runIds: [runId],
    });

    expect(report.ok).toBe(false);
    const codes = report.incompatible[0].issues.map((i) => i.code);
    expect(codes).toContain("STAGE_REMOVED");
    expect(() => assertShadowCompatible(report)).toThrow(/stage "a"/i);
  });

  it("fails a candidate that inserts a stage before the point the run reached", async () => {
    const before = pipeline(["a", "b"]);
    const { kernel, persistence } = createTestKernel([before]);
    const runId = await seedRun(kernel, before.id, "k1", ["a"]);

    // "zero" lands in execution group 1, which this run has already passed.
    const after = pipeline(["zero", "a", "b"], before.id);
    const report = await shadowRuns({
      persistence,
      candidates: [after],
      runIds: [runId],
    });

    const inserted = report.incompatible[0].issues.find(
      (i) => i.code === "STAGE_INSERTED_BEFORE_CURSOR",
    );
    expect(inserted).toBeDefined();
    expect(inserted?.stageId).toBe("zero");
  });

  it("accepts a stage appended after the point the run reached", async () => {
    const before = pipeline(["a"]);
    const { kernel, persistence } = createTestKernel([before]);
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: before.id,
      input: { val: "seed" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // Nothing has executed yet, so appending a stage is harmless.
    const after = pipeline(["a", "b"], before.id);
    const report = await shadowRuns({
      persistence,
      candidates: [after],
      runIds: [created.workflowRunId],
    });

    const codes = report.runs[0].issues.map((i) => i.code);
    expect(codes).not.toContain("STAGE_INSERTED_BEFORE_CURSOR");
  });

  it("fails a candidate whose config schema rejects the config the run stored", async () => {
    const before = pipeline(["a"]);
    const { kernel, persistence } = createTestKernel([before]);
    const runId = await seedRun(kernel, before.id, "k1", ["a"]);

    const after = defineWorkflow(before.id, {
      input: z.object({ val: z.string() }),
    })
      .pipe(makeStage("a", z.object({ mode: z.string() })))
      .build();

    const report = await shadowRuns({
      persistence,
      candidates: [after],
      runIds: [runId],
    });

    const rejected = report.incompatible[0].issues.find(
      (i) => i.code === "CONFIG_REJECTED",
    );
    expect(rejected).toBeDefined();
    expect(rejected?.stageId).toBe("a");
  });

  it("reports the durable step ids a run recorded, and flags stranding them", async () => {
    const stage = defineStage({
      id: "a",
      name: "A",
      schemas: {
        input: z.object({ val: z.string() }),
        output: z.object({ val: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        const val = await ctx.step.run("compute", async () => "done");
        return { output: { val } };
      },
    });
    const before = defineWorkflow("shadow-steps", {
      input: z.object({ val: z.string() }),
    })
      .pipe(stage)
      .pipe(makeStage("b"))
      .build();

    const { InMemoryStepLedger } = await import(
      "../../testing/in-memory-step-ledger.js"
    );
    const stepLedger = new InMemoryStepLedger();
    const { kernel, persistence } = createTestKernel([before], { stepLedger });
    const runId = await seedRun(kernel, before.id, "k1", ["a"]);

    const same = await shadowRuns({
      persistence,
      candidates: [before],
      runIds: [runId],
      stepLedger,
    });
    expect(same.ok).toBe(true);
    expect(same.runs[0].recordedSteps.a).toEqual(["compute"]);

    const after = pipeline(["b"], before.id);
    const removed = await shadowRuns({
      persistence,
      candidates: [after],
      runIds: [runId],
      stepLedger,
    });
    const orphaned = removed.incompatible[0].issues.find(
      (i) => i.code === "STEP_LEDGER_ORPHANED",
    );
    expect(orphaned).toBeDefined();
    expect(orphaned?.before).toEqual(["compute"]);
  });

  it("reports a run whose workflow the candidate build does not define at all", async () => {
    const workflow = pipeline(["a"]);
    const { kernel, persistence } = createTestKernel([workflow]);
    const runId = await seedRun(kernel, workflow.id, "k1", []);

    const report = await shadowRuns({
      persistence,
      candidates: [],
      runIds: [runId],
    });

    expect(report.ok).toBe(false);
    expect(report.incompatible[0].issues[0].code).toBe("WORKFLOW_MISSING");
  });

  it("throws on a run id that does not exist", async () => {
    const workflow = pipeline(["a"]);
    const { persistence } = createTestKernel([workflow]);

    await expect(
      shadowRuns({ persistence, candidates: [workflow], runIds: ["nope"] }),
    ).rejects.toThrow(/no such run/i);
  });
});

describe("shadowVersions", () => {
  it("passes when the candidate still presents every version with live runs", async () => {
    const workflow = pipeline(["a"]);
    const { kernel, persistence } = createTestKernel([workflow]);
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: { val: "seed" },
    });

    const report = await shadowVersions({
      persistence,
      candidates: [workflow],
    });

    expect(report.supported).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.versions).toHaveLength(1);
    expect(report.versions[0].runCount).toBe(1);
  });

  it("fails when a version with live runs is structurally incompatible with the candidate", async () => {
    const before = pipeline(["a", "b"]);
    const { kernel, persistence } = createTestKernel([before]);
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: before.id,
      input: { val: "seed" },
    });

    const after = pipeline(["b"], before.id);
    const report = await shadowVersions({ persistence, candidates: [after] });

    expect(report.ok).toBe(false);
    expect(report.incompatible[0].version).toBe(before.definitionVersion);
    expect(report.incompatible[0].drifts.map((d) => d.code)).toContain(
      "STAGE_REMOVED",
    );
    expect(() => assertShadowCompatible(report)).toThrow(
      /recorded definition version/,
    );
  });

  it("ignores versions whose runs have all finished", async () => {
    const workflow = pipeline(["a"]);
    const { kernel, persistence } = createTestKernel([workflow]);
    await seedRun(kernel, workflow.id, "k1", ["a"]);

    const after = pipeline(["b"], workflow.id);
    const report = await shadowVersions({ persistence, candidates: [after] });

    expect(report.versions).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it("says so plainly on a database that has not migrated", async () => {
    const workflow = pipeline(["a"]);
    const { persistence } = createTestKernel([workflow]);
    persistence.supportsDefinitionVersioning = () => false;

    const report = await shadowVersions({
      persistence,
      candidates: [workflow],
    });

    expect(report).toEqual({
      supported: false,
      versions: [],
      incompatible: [],
      ok: true,
    });
  });
});
