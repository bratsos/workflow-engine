import type { Workflow } from "@bratsos/workflow-engine";
import { defineStage, defineWorkflow } from "@bratsos/workflow-engine";
import { createKernel } from "@bratsos/workflow-engine/kernel";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
} from "@bratsos/workflow-engine/kernel/testing";
import {
  InMemoryJobQueue,
  InMemoryStepLedger,
  InMemoryWorkflowPersistence,
} from "@bratsos/workflow-engine/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runToCompletion } from "../run-to-completion.js";

// ============================================================================
// Test helpers
// ============================================================================

const schema = z.object({ data: z.string() });
const outputSchema = z.object({ result: z.string() });

function createPassthroughStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: { input: schema, output: outputSchema, config: z.object({}) },
    async execute(ctx) {
      return { output: { result: ctx.input.data.toUpperCase() } };
    },
  });
}

function createChainedStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: {
      input: outputSchema,
      output: outputSchema,
      config: z.object({}),
    },
    async execute(ctx) {
      return { output: { result: ctx.input.result + "!" } };
    },
  });
}

function createFailingStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: {
      input: schema,
      output: outputSchema,
      config: z.object({}),
    },
    async execute() {
      throw new Error("Stage exploded");
    },
  });
}

function createSimpleWorkflow(): Workflow<any, any> {
  return defineWorkflow({
    id: "simple-workflow",
    name: "Simple Workflow",
    input: schema,
  })
    .pipe(createPassthroughStage("stage-1"))
    .build();
}

function createTwoStageWorkflow(): Workflow<any, any> {
  return defineWorkflow({
    id: "two-stage",
    name: "Two Stage",
    input: schema,
  })
    .pipe(createPassthroughStage("stage-1"))
    .pipe(createChainedStage("stage-2"))
    .build();
}

function createThreeStageWorkflow(): Workflow<any, any> {
  return defineWorkflow({
    id: "three-stage",
    name: "Three Stage",
    input: schema,
  })
    .pipe(createPassthroughStage("stage-1"))
    .pipe(createChainedStage("stage-2"))
    .pipe(createChainedStage("stage-3"))
    .build();
}

function createFailingWorkflow(): Workflow<any, any> {
  return defineWorkflow({
    id: "failing-workflow",
    name: "Failing Workflow",
    input: schema,
  })
    .pipe(createFailingStage("stage-1"))
    .build();
}

function createSleepingWorkflow(): Workflow<any, any> {
  const stage = defineStage({
    id: "sleep-stage",
    name: "Sleep Stage",
    schemas: { input: schema, output: outputSchema, config: z.object({}) },
    async execute(ctx) {
      await ctx.step.sleep("nap", "1h");
      return { output: { result: "awake" } };
    },
  });

  return defineWorkflow({
    id: "sleeping-workflow",
    name: "Sleeping Workflow",
    input: schema,
  })
    .pipe(stage)
    .build();
}

function createTestEnv(
  workflows: Workflow<any, any>[] = [],
  extra: { stepLedger?: InMemoryStepLedger } = {},
) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const clock = new FakeClock();

  const registry = new Map<string, Workflow<any, any>>();
  for (const w of workflows) {
    registry.set(w.id, w);
  }

  const kernel = createKernel({
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    clock,
    registry: { getWorkflow: (id) => registry.get(id) },
    ...extra,
  });

  return { kernel, persistence, blobStore, jobTransport, eventSink, clock };
}

// ============================================================================
// Tests
// ============================================================================

describe("runToCompletion", () => {
  it("drives a multi-stage workflow to completion in one call", async () => {
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    const result = await runToCompletion({
      kernel,
      jobTransport,
      persistence,
      command: {
        type: "run.create",
        idempotencyKey: "multi-stage-1",
        workflowId: "two-stage",
        input: { data: "hello" },
      },
    });

    expect(result.outcome).toBe("completed");
    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ result: "HELLO!" });
    expect(result.jobsProcessed).toBe(2);
    expect(result.foreignJobsProcessed).toBe(0);
  });

  it("reports a failed run rather than throwing", async () => {
    const workflow = createFailingWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);
    jobTransport.setDefaultMaxAttempts(1);

    const callPromise = runToCompletion({
      kernel,
      jobTransport,
      persistence,
      command: {
        type: "run.create",
        idempotencyKey: "failing-1",
        workflowId: "failing-workflow",
        input: { data: "boom" },
      },
    });

    await expect(callPromise).resolves.toBeDefined();
    const result = await callPromise;
    expect(result.outcome).toBe("failed");
    expect(result.status).toBe("FAILED");
  });

  it("stops and says so when a stage suspends", async () => {
    const workflow = createSleepingWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow], {
      stepLedger: new InMemoryStepLedger(),
    });

    const result = await runToCompletion({
      kernel,
      jobTransport,
      persistence,
      command: {
        type: "run.create",
        idempotencyKey: "sleeping-1",
        workflowId: "sleeping-workflow",
        input: { data: "sleep" },
      },
    });

    expect(result.outcome).toBe("suspended");
    expect(result.suspendedStageId).toBe("sleep-stage");
    expect(result.reason).toContain("suspended");
    expect(["COMPLETED", "FAILED", "CANCELLED"]).not.toContain(result.status);
    expect(result.jobsProcessed).toBe(1);
  });

  it("is bounded by maxJobs", async () => {
    const workflow = createThreeStageWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    const result = await runToCompletion({
      kernel,
      jobTransport,
      persistence,
      command: {
        type: "run.create",
        idempotencyKey: "max-jobs-1",
        workflowId: "three-stage",
        input: { data: "hello" },
      },
      maxJobs: 2,
    });

    expect(result.outcome).toBe("incomplete");
    expect(result.jobsProcessed).toBe(2);
    expect(result.reason).toContain("budget");
  });

  it("counts jobs it executed for another caller's run", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    // Create a SECOND run directly through kernel.dispatch BEFORE calling runToCompletion
    const otherRun = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "foreign-run-1",
      workflowId: "simple-workflow",
      input: { data: "foreign" },
    });

    const result = await runToCompletion({
      kernel,
      jobTransport,
      persistence,
      command: {
        type: "run.create",
        idempotencyKey: "my-run-1",
        workflowId: "simple-workflow",
        input: { data: "mine" },
      },
    });

    expect(result.foreignJobsProcessed).toBeGreaterThanOrEqual(1);
    const completedOtherRun = await persistence.getRun(otherRun.workflowRunId);
    expect(completedOtherRun?.status).toBe("COMPLETED");
  });

  it("publishes the run's events before returning", async () => {
    const workflow = createSimpleWorkflow();

    // Default flushOutbox (true)
    const envWithFlush = createTestEnv([workflow]);
    const resultWithFlush = await runToCompletion({
      kernel: envWithFlush.kernel,
      jobTransport: envWithFlush.jobTransport,
      persistence: envWithFlush.persistence,
      command: {
        type: "run.create",
        idempotencyKey: "flush-default-1",
        workflowId: "simple-workflow",
        input: { data: "hello" },
      },
    });

    expect(resultWithFlush.outcome).toBe("completed");
    expect(
      envWithFlush.eventSink.events.some(
        (e) => e.type === "workflow:completed",
      ),
    ).toBe(true);

    // flushOutbox: false
    const envWithoutFlush = createTestEnv([workflow]);
    const resultWithoutFlush = await runToCompletion({
      kernel: envWithoutFlush.kernel,
      jobTransport: envWithoutFlush.jobTransport,
      persistence: envWithoutFlush.persistence,
      command: {
        type: "run.create",
        idempotencyKey: "flush-disabled-1",
        workflowId: "simple-workflow",
        input: { data: "hello" },
      },
      flushOutbox: false,
    });

    expect(resultWithoutFlush.outcome).toBe("completed");
    expect(
      envWithoutFlush.eventSink.events.some(
        (e) => e.type === "workflow:completed",
      ),
    ).toBe(false);
  });
});
