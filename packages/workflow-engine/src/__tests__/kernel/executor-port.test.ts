import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { createKernel } from "../../kernel/kernel.js";
import type { ActivityExecutor, ActivityRunInput } from "../../kernel/ports.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeInfra() {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const scheduler = new NoopScheduler();
  const clock = new FakeClock();
  return { persistence, blobStore, jobTransport, eventSink, scheduler, clock };
}

function makeSimpleWorkflow() {
  const schema = z.object({ value: z.string() });
  const stage = defineStage({
    id: "s1",
    name: "Stage One",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: { value: ctx.input.value + "-processed" } };
    },
  });
  return new WorkflowBuilder(
    "wf-executor-test",
    "Executor Test",
    "ExecutorTest",
    schema,
    schema,
  )
    .pipe(stage)
    .build();
}

async function runStage(
  kernel: ReturnType<typeof createKernel>,
  infra: ReturnType<typeof makeInfra>,
  workflowRunId: string,
) {
  const job = await infra.jobTransport.dequeue();
  if (!job) throw new Error("No job in queue");
  await kernel.dispatch({
    type: "job.execute" as const,
    workflowRunId,
    workflowId: "wf-executor-test",
    stageId: job.stageId,
    config: {},
    idempotencyKey: `exec-${workflowRunId}-${job.stageId}`,
  });
}

// ---------------------------------------------------------------------------
// Test 1: custom ActivityExecutor spy is invoked
// ---------------------------------------------------------------------------

describe("ActivityExecutor port", () => {
  it("invokes a custom executor spy and persists its returned result and annotations", async () => {
    const infra = makeInfra();
    const workflow = makeSimpleWorkflow();
    const registry = { getWorkflow: (_id: string) => workflow };

    // Build a spy executor that returns a known result + one annotation.
    // The annotation's workflowRunId is taken from the input so listAnnotations
    // can find it (it filters by workflowRunId).
    const spyRun = vi.fn(async (input: ActivityRunInput, _deps: unknown) => ({
      result: {
        output: { value: "spy-output" },
        metrics: {
          startTime: 0,
          endTime: 10,
          duration: 10,
        },
      },
      progress: [],
      annotations: [
        {
          workflowRunId: input.workflowRunId,
          workflowStageRecordId: input.stageRecordId,
          attempt: input.attempt,
          scope: "stage" as const,
          scopeId: "s1",
          key: "spy.annotation",
          value: "present",
          actor: undefined,
          payload: undefined,
          idempotencyKey: undefined,
          emitEvent: undefined,
        },
      ],
      logs: [],
    }));

    const customExecutor: ActivityExecutor = { run: spyRun };

    const kernel = createKernel({
      ...infra,
      registry,
      executor: customExecutor,
    });

    // Create + claim a run to get it to RUNNING
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create" as const,
      workflowId: "wf-executor-test",
      input: { value: "hello" },
    });

    await kernel.dispatch({
      type: "run.claimPending" as const,
      workflowRunId,
    });

    await runStage(kernel, infra, workflowRunId);

    // spy was called
    expect(spyRun).toHaveBeenCalledOnce();
    const callArg = spyRun.mock.calls[0][0] as ActivityRunInput;
    expect(callArg.stageId).toBe("s1");
    expect(callArg.workflowId).toBe("wf-executor-test");

    // The spy's output was persisted (stage completed)
    const stages = await infra.persistence.getStagesByRun(workflowRunId);
    expect(stages).toHaveLength(1);
    expect(stages[0].status).toBe("COMPLETED");

    // The spy's annotation was persisted
    const annotations = await infra.persistence.listAnnotations(workflowRunId);
    expect(annotations.some((a) => a.key === "spy.annotation")).toBe(true);
  });

  it("uses default LocalExecutor when no executor is configured and stage output is persisted", async () => {
    const infra = makeInfra();
    const workflow = makeSimpleWorkflow();
    const registry = { getWorkflow: (_id: string) => workflow };

    // No executor in config — should default to LocalExecutor
    const kernel = createKernel({ ...infra, registry });

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create" as const,
      workflowId: "wf-executor-test",
      input: { value: "default" },
    });

    await kernel.dispatch({
      type: "run.claimPending" as const,
      workflowRunId,
    });

    await runStage(kernel, infra, workflowRunId);

    const stages = await infra.persistence.getStagesByRun(workflowRunId);
    expect(stages).toHaveLength(1);
    expect(stages[0].status).toBe("COMPLETED");

    // The output blob was written by LocalExecutor path
    const blobKeys = await infra.blobStore.list("workflow-v2");
    expect(blobKeys.length).toBeGreaterThan(0);
  });
});
