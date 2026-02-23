/**
 * Rerun From Stage Tests (Kernel)
 *
 * Tests for the ability to rerun a workflow starting from a specific stage
 * via the run.rerunFrom kernel command.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { type Workflow, WorkflowBuilder } from "../../core/workflow.js";
import { createKernel } from "../../kernel/kernel.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestKernel(workflows: Workflow<any, any>[] = []) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const scheduler = new NoopScheduler();
  const clock = new FakeClock();

  const registry = new Map<string, Workflow<any, any>>();
  for (const w of workflows) registry.set(w.id, w);

  const kernel = createKernel({
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });

  const flush = () => kernel.dispatch({ type: "outbox.flush" as const });
  return {
    kernel,
    flush,
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry,
  };
}

function createPassthroughStage(
  id: string,
  outputOverride?: Record<string, unknown>,
) {
  const schema = z.object({ value: z.string() });
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: {
      input: z.any(),
      output: schema,
      config: z.object({}),
    },
    async execute(ctx) {
      if (outputOverride) {
        return { output: outputOverride as any };
      }
      return { output: { value: `output-from-${id}` } };
    },
  });
}

/**
 * Runs a workflow to completion by creating, claiming, and executing all stages.
 */
async function runWorkflowToCompletion(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  flush: () => Promise<any>,
  workflowId: string,
  stageIds: string[],
  input: unknown,
): Promise<string> {
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: `key-${Date.now()}-${Math.random()}`,
    workflowId,
    input,
  });

  await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

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

  await flush();
  return workflowRunId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("I want to rerun a workflow from a specific stage", () => {
  describe("basic rerun functionality", () => {
    it("should rerun from stage 3 after a complete run, skipping stages 1 and 2", async () => {
      // Given: A 4-stage workflow run to completion
      const s1 = createPassthroughStage("s1");
      const s2 = createPassthroughStage("s2");
      const s3 = createPassthroughStage("s3");
      const s4 = createPassthroughStage("s4");

      const workflow = new WorkflowBuilder(
        "four-stage",
        "Four Stage",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(s1)
        .pipe(s2)
        .pipe(s3)
        .pipe(s4)
        .build();

      const { kernel, flush, persistence, jobTransport } = createTestKernel([
        workflow,
      ]);

      const workflowRunId = await runWorkflowToCompletion(
        kernel,
        flush,
        "four-stage",
        ["s1", "s2", "s3", "s4"],
        { value: "start" },
      );

      // Verify run is completed
      const runBefore = await persistence.getRun(workflowRunId);
      expect(runBefore!.status).toBe("COMPLETED");

      // Clear job queue so we can verify new jobs
      jobTransport.clear();

      // When: rerun from stage s3
      const result = await kernel.dispatch({
        type: "run.rerunFrom",
        workflowRunId,
        fromStageId: "s3",
      });

      // Then: deleted stages are s3 and s4 but not s1/s2
      expect(result.deletedStages).toContain("s3");
      expect(result.deletedStages).toContain("s4");
      expect(result.deletedStages).not.toContain("s1");
      expect(result.deletedStages).not.toContain("s2");

      // Run is now RUNNING
      const runAfter = await persistence.getRun(workflowRunId);
      expect(runAfter!.status).toBe("RUNNING");

      // Stages 1 and 2 remain COMPLETED
      const stages = await persistence.getStagesByRun(workflowRunId);
      const s1Record = stages.find((s) => s.stageId === "s1");
      const s2Record = stages.find((s) => s.stageId === "s2");
      const s3Record = stages.find((s) => s.stageId === "s3");

      expect(s1Record!.status).toBe("COMPLETED");
      expect(s2Record!.status).toBe("COMPLETED");
      expect(s3Record!.status).toBe("PENDING");

      // A job was enqueued for s3
      const pendingJobs = jobTransport.getJobsByStatus("PENDING");
      expect(pendingJobs).toHaveLength(1);
      expect(pendingJobs[0]!.stageId).toBe("s3");
    });

    it("should rerun from stage 2 and execute stages 2, 3, 4", async () => {
      // Given: A 4-stage workflow run to completion
      const s1 = createPassthroughStage("s1");
      const s2 = createPassthroughStage("s2");
      const s3 = createPassthroughStage("s3");
      const s4 = createPassthroughStage("s4");

      const workflow = new WorkflowBuilder(
        "four-stage",
        "Four Stage",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(s1)
        .pipe(s2)
        .pipe(s3)
        .pipe(s4)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const workflowRunId = await runWorkflowToCompletion(
        kernel,
        flush,
        "four-stage",
        ["s1", "s2", "s3", "s4"],
        { value: "start" },
      );

      // When: rerun from s2
      await kernel.dispatch({
        type: "run.rerunFrom",
        workflowRunId,
        fromStageId: "s2",
      });

      // Execute s2
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "four-stage",
        stageId: "s2",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute s3
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "four-stage",
        stageId: "s3",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute s4
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "four-stage",
        stageId: "s4",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: run ends COMPLETED
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });

    it("should rerun from stage 1 (first stage) using workflow input", async () => {
      // Given: A 2-stage workflow with an execution counter
      let executionCount = 0;

      const counter = defineStage({
        id: "counter",
        name: "Counter Stage",
        schemas: {
          input: z.any(),
          output: z.object({ value: z.string(), count: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionCount++;
          return { output: { value: "counted", count: executionCount } };
        },
      });

      const finalStage = createPassthroughStage("final");

      const workflow = new WorkflowBuilder(
        "counter-wf",
        "Counter Workflow",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(counter)
        .pipe(finalStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // Run to completion (counter increments to 1)
      const workflowRunId = await runWorkflowToCompletion(
        kernel,
        flush,
        "counter-wf",
        ["counter", "final"],
        { value: "start" },
      );

      expect(executionCount).toBe(1);

      // When: rerun from first stage
      await kernel.dispatch({
        type: "run.rerunFrom",
        workflowRunId,
        fromStageId: "counter",
      });

      // Execute counter stage again
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "counter-wf",
        stageId: "counter",
        config: {},
      });

      // Then: counter was incremented again
      expect(executionCount).toBe(2);
      expect(result.output).toEqual({ value: "counted", count: 2 });
    });
  });

  describe("error handling", () => {
    it("should throw error when stage does not exist", async () => {
      // Given: A completed workflow
      const s1 = createPassthroughStage("s1");

      const workflow = new WorkflowBuilder(
        "simple-wf",
        "Simple Workflow",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(s1)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const workflowRunId = await runWorkflowToCompletion(
        kernel,
        flush,
        "simple-wf",
        ["s1"],
        { value: "start" },
      );

      // When/Then: rerun with a nonexistent stage
      await expect(
        kernel.dispatch({
          type: "run.rerunFrom",
          workflowRunId,
          fromStageId: "nonexistent",
        }),
      ).rejects.toThrow(/not found/);
    });

    it("should throw error when previous stages have not been executed", async () => {
      // Given: A 3-stage workflow where no stages have been executed
      const s1 = createPassthroughStage("s1");
      const s2 = createPassthroughStage("s2");
      const s3 = createPassthroughStage("s3");

      const workflow = new WorkflowBuilder(
        "three-stage",
        "Three Stage",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(s1)
        .pipe(s2)
        .pipe(s3)
        .build();

      const { kernel, persistence } = createTestKernel([workflow]);

      // Create run and manually set it to FAILED without executing any stages
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "three-stage",
        input: { value: "start" },
      });

      await persistence.updateRun(workflowRunId, { status: "FAILED" });

      // When/Then: rerun from s3 should fail because no prior stages exist
      await expect(
        kernel.dispatch({
          type: "run.rerunFrom",
          workflowRunId,
          fromStageId: "s3",
        }),
      ).rejects.toThrow(/previous stages have not been executed/);
    });
  });

  describe("workflow context", () => {
    it("should have access to previous stage outputs in workflowContext", async () => {
      // Given: A 2-stage workflow where stage1 produces specific output
      let capturedContext: Record<string, unknown> = {};

      const stage1 = defineStage({
        id: "stage1",
        name: "Stage stage1",
        schemas: {
          input: z.any(),
          output: z.object({ computed: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { computed: "from-stage-1" } };
        },
      });

      const stage2 = defineStage({
        id: "stage2",
        name: "Stage stage2",
        schemas: {
          input: z.any(),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          capturedContext = { ...ctx.workflowContext };
          return { output: { value: "done" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "context-wf",
        "Context Workflow",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      // Run to completion first
      const workflowRunId = await runWorkflowToCompletion(
        kernel,
        flush,
        "context-wf",
        ["stage1", "stage2"],
        { value: "start" },
      );

      // When: rerun from stage2 (stage1 output preserved)
      await kernel.dispatch({
        type: "run.rerunFrom",
        workflowRunId,
        fromStageId: "stage2",
      });

      // Execute stage2 again
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "context-wf",
        stageId: "stage2",
        config: {},
      });

      // Then: stage2 sees stage1's output in workflowContext
      expect(capturedContext).toHaveProperty("stage1");
      expect(capturedContext["stage1"]).toEqual({ computed: "from-stage-1" });
    });
  });

  describe("stage records cleanup", () => {
    it("should delete stage records for rerun stages", async () => {
      // Given: A 3-stage workflow run to completion
      const s1 = createPassthroughStage("s1");
      const s2 = createPassthroughStage("s2");
      const s3 = createPassthroughStage("s3");

      const workflow = new WorkflowBuilder(
        "three-stage",
        "Three Stage",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(s1)
        .pipe(s2)
        .pipe(s3)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const workflowRunId = await runWorkflowToCompletion(
        kernel,
        flush,
        "three-stage",
        ["s1", "s2", "s3"],
        { value: "start" },
      );

      // Verify all 3 stages exist
      const stagesBefore = await persistence.getStagesByRun(workflowRunId);
      expect(stagesBefore).toHaveLength(3);

      // When: rerun from s2
      await kernel.dispatch({
        type: "run.rerunFrom",
        workflowRunId,
        fromStageId: "s2",
      });

      // Then: only s1 (old COMPLETED) and s2 (new PENDING) exist; s3 deleted
      const stagesAfter = await persistence.getStagesByRun(workflowRunId);
      const stageMap = new Map(stagesAfter.map((s) => [s.stageId, s]));

      expect(stageMap.size).toBe(2);
      expect(stageMap.has("s1")).toBe(true);
      expect(stageMap.has("s2")).toBe(true);
      expect(stageMap.has("s3")).toBe(false);

      expect(stageMap.get("s1")!.status).toBe("COMPLETED");
      expect(stageMap.get("s2")!.status).toBe("PENDING");
    });
  });
});
