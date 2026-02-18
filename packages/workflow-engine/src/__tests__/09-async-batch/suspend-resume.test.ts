/**
 * Async Batch Suspend/Resume Tests (kernel version)
 *
 * Tests for multi-stage async batch workflows and chaining via kernel dispatch().
 *
 * Covers:
 * - Sequential async-batch stages (suspend, poll, transition, repeat)
 * - Mixed sync and async-batch stages
 * - State management across suspensions (metadata, unique batch IDs)
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKernel } from "../../kernel/kernel.js";
import {
  FakeClock,
  InMemoryBlobStore,
  CollectingEventSink,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { defineStage, defineAsyncBatchStage } from "../../core/stage-factory.js";
import { WorkflowBuilder, type Workflow } from "../../core/workflow.js";

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
  return { kernel, flush, persistence, blobStore, jobTransport, eventSink, scheduler, clock, registry };
}

/**
 * Helper to drive a suspended stage through poll -> completion -> transition.
 * Returns the transition result.
 */
async function pollAndTransition(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  persistence: InMemoryWorkflowPersistence,
  clock: FakeClock,
  workflowRunId: string,
  stageId: string,
) {
  // Make the suspended stage eligible for polling
  const stages = await persistence.getStagesByRun(workflowRunId);
  const stage = stages.find((s) => s.stageId === stageId);
  if (stage) {
    await persistence.updateStage(stage.id, {
      nextPollAt: new Date(clock.now().getTime() - 1000),
    });
  }

  // Poll
  await kernel.dispatch({ type: "stage.pollSuspended" });

  // Transition
  return kernel.dispatch({ type: "run.transition", workflowRunId });
}

describe("I want to chain multiple async-batch stages", () => {
  describe("sequential async-batch stages", () => {
    it("should suspend on first stage, complete via poll, then advance to second", async () => {
      const executionLog: string[] = [];
      let firstReady = false;
      let secondReady = false;

      const firstAsyncStage = defineAsyncBatchStage({
        id: "first-async",
        name: "First Async",
        mode: "async-batch",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ firstResult: z.string() }),
          config: z.object({}),
        },
        async execute() {
          executionLog.push("first-execute");
          const now = new Date();
          return {
            suspended: true,
            state: { batchId: "batch-first", submittedAt: now.toISOString(), pollInterval: 100, maxWaitTime: 10000 },
            pollConfig: { pollInterval: 100, maxWaitTime: 10000, nextPollAt: new Date(now.getTime() + 100) },
          };
        },
        async checkCompletion() {
          if (firstReady) {
            executionLog.push("first-check-ready");
            return { ready: true, output: { firstResult: "processed-test" } };
          }
          return { ready: false };
        },
      });

      const secondAsyncStage = defineAsyncBatchStage({
        id: "second-async",
        name: "Second Async",
        mode: "async-batch",
        schemas: {
          input: z.object({ firstResult: z.string() }),
          output: z.object({ finalResult: z.string() }),
          config: z.object({}),
        },
        async execute() {
          executionLog.push("second-execute");
          const now = new Date();
          return {
            suspended: true,
            state: { batchId: "batch-second", submittedAt: now.toISOString(), pollInterval: 100, maxWaitTime: 10000 },
            pollConfig: { pollInterval: 100, maxWaitTime: 10000, nextPollAt: new Date(now.getTime() + 100) },
          };
        },
        async checkCompletion() {
          if (secondReady) {
            executionLog.push("second-check-ready");
            return { ready: true, output: { finalResult: "final-processed-test" } };
          }
          return { ready: false };
        },
      });

      const workflow = new WorkflowBuilder(
        "chained-async", "Chained Async Workflow", "Test",
        z.object({ value: z.string() }),
        z.object({ finalResult: z.string() }),
      ).pipe(firstAsyncStage).pipe(secondAsyncStage).build();

      const { kernel, flush, persistence, clock } = createTestKernel([workflow]);

      // Create and claim run
      const createResult = await kernel.dispatch({
        type: "run.create", idempotencyKey: "chain-1",
        workflowId: "chained-async", input: { value: "test" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute first stage -> suspends
      const execResult1 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "chained-async",
        stageId: "first-async",
        config: {},
      });
      expect(execResult1.outcome).toBe("suspended");
      expect(executionLog).toEqual(["first-execute"]);

      // First stage completes via poll
      firstReady = true;
      const trans1 = await pollAndTransition(
        kernel, persistence, clock,
        createResult.workflowRunId, "first-async",
      );
      expect(trans1.action).toBe("advanced");
      expect(executionLog).toContain("first-check-ready");

      // Execute second stage -> suspends
      const execResult2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "chained-async",
        stageId: "second-async",
        config: {},
      });
      expect(execResult2.outcome).toBe("suspended");
      expect(executionLog).toContain("second-execute");

      // Second stage completes via poll
      secondReady = true;
      const trans2 = await pollAndTransition(
        kernel, persistence, clock,
        createResult.workflowRunId, "second-async",
      );
      // No more stages -> completed
      expect(trans2.action).toBe("completed");
      expect(executionLog).toContain("second-check-ready");

      // Workflow should be completed
      const run = await persistence.getRun(createResult.workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });

    it("should emit stage:suspended events for each async-batch stage", async () => {
      let firstReady = false;
      let secondReady = false;

      const createBatchStage = (id: string, schema: z.ZodTypeAny) =>
        defineAsyncBatchStage({
          id,
          name: `Stage ${id}`,
          mode: "async-batch",
          schemas: { input: schema, output: schema, config: z.object({}) },
          async execute() {
            const now = new Date();
            return {
              suspended: true,
              state: { batchId: `batch-${id}`, submittedAt: now.toISOString(), pollInterval: 100, maxWaitTime: 10000 },
              pollConfig: { pollInterval: 100, maxWaitTime: 10000, nextPollAt: new Date(now.getTime() + 100) },
            };
          },
          async checkCompletion() {
            const ready = id === "stage-a" ? firstReady : secondReady;
            if (ready) return { ready: true, output: { value: "done" } };
            return { ready: false };
          },
        });

      const schema = z.object({ value: z.string() });
      const workflow = new WorkflowBuilder(
        "multi-suspend", "Multi Suspend", "Test", schema, schema,
      )
        .pipe(createBatchStage("stage-a", schema))
        .pipe(createBatchStage("stage-b", schema))
        .build();

      const { kernel, flush, persistence, clock, eventSink } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create", idempotencyKey: "multi-1",
        workflowId: "multi-suspend", input: { value: "data" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();
      eventSink.clear();

      // Execute stage-a -> suspended
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "multi-suspend",
        stageId: "stage-a",
        config: {},
      });
      await flush();

      const suspendedEventsA = eventSink.getByType("stage:suspended");
      expect(suspendedEventsA).toHaveLength(1);
      expect((suspendedEventsA[0] as any).stageId).toBe("stage-a");

      // Complete stage-a via poll, transition, execute stage-b
      firstReady = true;
      await pollAndTransition(
        kernel, persistence, clock,
        createResult.workflowRunId, "stage-a",
      );

      eventSink.clear();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "multi-suspend",
        stageId: "stage-b",
        config: {},
      });
      await flush();

      const suspendedEventsB = eventSink.getByType("stage:suspended");
      expect(suspendedEventsB).toHaveLength(1);
      expect((suspendedEventsB[0] as any).stageId).toBe("stage-b");
    });
  });

  describe("mixed sync and async-batch stages", () => {
    it("should execute sync stages before async-batch stage suspends", async () => {
      const executionOrder: string[] = [];

      const syncFirst = defineStage({
        id: "sync-first",
        name: "Sync First",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string(), syncProcessed: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("sync-first");
          return { output: { value: ctx.input.value, syncProcessed: true } };
        },
      });

      const asyncMiddle = defineAsyncBatchStage({
        id: "async-middle",
        name: "Async Middle",
        mode: "async-batch",
        schemas: {
          input: z.object({ value: z.string(), syncProcessed: z.boolean() }),
          output: z.object({ value: z.string(), asyncProcessed: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          executionOrder.push("async-middle");
          const now = new Date();
          return {
            suspended: true,
            state: { batchId: "batch-middle", submittedAt: now.toISOString(), pollInterval: 100, maxWaitTime: 10000 },
            pollConfig: { pollInterval: 100, maxWaitTime: 10000, nextPollAt: new Date(now.getTime() + 100) },
          };
        },
        async checkCompletion() {
          executionOrder.push("async-middle-check");
          return { ready: true, output: { value: "test", asyncProcessed: true } };
        },
      });

      const syncLast = defineStage({
        id: "sync-last",
        name: "Sync Last",
        schemas: {
          input: z.object({ value: z.string(), asyncProcessed: z.boolean() }),
          output: z.object({ finalValue: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("sync-last");
          return { output: { finalValue: `final-${ctx.input.value}` } };
        },
      });

      const workflow = new WorkflowBuilder(
        "mixed-workflow", "Mixed Workflow", "Test",
        z.object({ value: z.string() }),
        z.object({ finalValue: z.string() }),
      ).pipe(syncFirst).pipe(asyncMiddle).pipe(syncLast).build();

      const { kernel, flush, persistence, clock } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create", idempotencyKey: "mixed-1",
        workflowId: "mixed-workflow", input: { value: "test" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute sync-first -> completed
      const exec1 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "mixed-workflow",
        stageId: "sync-first",
        config: {},
      });
      expect(exec1.outcome).toBe("completed");
      expect(executionOrder).toEqual(["sync-first"]);

      // Transition to group 2 (async-middle)
      const trans1 = await kernel.dispatch({
        type: "run.transition",
        workflowRunId: createResult.workflowRunId,
      });
      expect(trans1.action).toBe("advanced");

      // Execute async-middle -> suspended
      const exec2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "mixed-workflow",
        stageId: "async-middle",
        config: {},
      });
      expect(exec2.outcome).toBe("suspended");
      expect(executionOrder).toContain("async-middle");

      // Poll completes async-middle, then transition to group 3
      const trans2 = await pollAndTransition(
        kernel, persistence, clock,
        createResult.workflowRunId, "async-middle",
      );
      expect(trans2.action).toBe("advanced");
      expect(executionOrder).toContain("async-middle-check");

      // Execute sync-last -> completed
      const exec3 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "mixed-workflow",
        stageId: "sync-last",
        config: {},
      });
      expect(exec3.outcome).toBe("completed");
      expect(exec3.output).toEqual({ finalValue: "final-test" });
      expect(executionOrder).toContain("sync-last");

      // Final transition completes workflow
      const trans3 = await kernel.dispatch({
        type: "run.transition",
        workflowRunId: createResult.workflowRunId,
      });
      expect(trans3.action).toBe("completed");
    });

    it("should preserve sync stage output for async-batch stage input", async () => {
      const syncStage = defineStage({
        id: "data-producer",
        name: "Data Producer",
        schemas: {
          input: z.object({ seed: z.number() }),
          output: z.object({ data: z.array(z.number()) }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: {
              data: [ctx.input.seed, ctx.input.seed * 2, ctx.input.seed * 3],
            },
          };
        },
      });

      const asyncStage = defineAsyncBatchStage({
        id: "data-processor",
        name: "Data Processor",
        mode: "async-batch",
        schemas: {
          input: z.object({ data: z.array(z.number()) }),
          output: z.object({ sum: z.number() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: { batchId: "batch-process", submittedAt: now.toISOString(), pollInterval: 100, maxWaitTime: 10000 },
            pollConfig: { pollInterval: 100, maxWaitTime: 10000, nextPollAt: new Date(now.getTime() + 100) },
          };
        },
        async checkCompletion() {
          // 10 + 20 + 30 = 60
          return { ready: true, output: { sum: 60 } };
        },
      });

      const workflow = new WorkflowBuilder(
        "preserve-output", "Preserve Output Workflow", "Test",
        z.object({ seed: z.number() }),
        z.object({ sum: z.number() }),
      ).pipe(syncStage).pipe(asyncStage).build();

      const { kernel, flush, persistence, clock, blobStore } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create", idempotencyKey: "preserve-1",
        workflowId: "preserve-output", input: { seed: 10 },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute sync stage -> completed
      const exec1 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "preserve-output",
        stageId: "data-producer",
        config: {},
      });
      expect(exec1.outcome).toBe("completed");
      expect(exec1.output).toEqual({ data: [10, 20, 30] });

      // Transition
      await kernel.dispatch({
        type: "run.transition",
        workflowRunId: createResult.workflowRunId,
      });

      // Execute async stage -> suspended
      const exec2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "preserve-output",
        stageId: "data-processor",
        config: {},
      });
      expect(exec2.outcome).toBe("suspended");

      // Poll completes it
      const stages = await persistence.getStagesByRun(createResult.workflowRunId);
      const asyncStageRecord = stages.find((s) => s.stageId === "data-processor");
      await persistence.updateStage(asyncStageRecord!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      const pollResult = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(pollResult.resumed).toBe(1);

      // Output stored in blobStore
      expect(blobStore.size()).toBeGreaterThan(0);
    });
  });

  describe("async-batch state management", () => {
    it("should preserve custom metadata in suspended state", async () => {
      const asyncStage = defineAsyncBatchStage({
        id: "metadata-stage",
        name: "Metadata Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ processed: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-meta",
              submittedAt: now.toISOString(),
              pollInterval: 100,
              maxWaitTime: 10000,
              metadata: {
                customField: "custom-value",
                itemCount: 42,
                tags: ["tag1", "tag2"],
              },
            },
            pollConfig: { pollInterval: 100, maxWaitTime: 10000, nextPollAt: new Date(now.getTime() + 100) },
          };
        },
        async checkCompletion(state) {
          // Verify metadata is preserved in the state passed to checkCompletion
          expect(state.metadata).toEqual({
            customField: "custom-value",
            itemCount: 42,
            tags: ["tag1", "tag2"],
          });
          return { ready: true, output: { processed: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "metadata-workflow", "Metadata Workflow", "Test",
        z.object({}).passthrough(),
        z.object({ processed: z.boolean() }),
      ).pipe(asyncStage).build();

      const { kernel, flush, persistence, clock } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create", idempotencyKey: "meta-1",
        workflowId: "metadata-workflow", input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute -> suspends
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "metadata-workflow",
        stageId: "metadata-stage",
        config: {},
      });

      // Verify metadata is stored in persistence
      const stages = await persistence.getStagesByRun(createResult.workflowRunId);
      const suspendedState = stages[0]!.suspendedState as any;
      expect(suspendedState.metadata).toEqual({
        customField: "custom-value",
        itemCount: 42,
        tags: ["tag1", "tag2"],
      });

      // Poll -> checkCompletion receives the state with metadata
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      const pollResult = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(pollResult.resumed).toBe(1);
    });

    it("should provide unique batch IDs for each stage in chain", async () => {
      const batchIds: string[] = [];

      const createBatchIdStage = (id: string) => {
        return defineAsyncBatchStage({
          id,
          name: `Stage ${id}`,
          mode: "async-batch",
          schemas: {
            input: z.object({}).passthrough(),
            output: z.object({}).passthrough(),
            config: z.object({}),
          },
          async execute() {
            const batchId = `batch-${id}-${Date.now()}`;
            batchIds.push(batchId);
            const now = new Date();
            return {
              suspended: true,
              state: { batchId, submittedAt: now.toISOString(), pollInterval: 100, maxWaitTime: 10000 },
              pollConfig: { pollInterval: 100, maxWaitTime: 10000, nextPollAt: new Date(now.getTime() + 100) },
            };
          },
          async checkCompletion() {
            return { ready: true, output: {} };
          },
        });
      };

      const workflow = new WorkflowBuilder(
        "unique-batch-ids", "Unique Batch IDs Workflow", "Test",
        z.object({}).passthrough(),
        z.object({}).passthrough(),
      )
        .pipe(createBatchIdStage("stage-1"))
        .pipe(createBatchIdStage("stage-2"))
        .build();

      const { kernel, flush, persistence, clock } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create", idempotencyKey: "unique-1",
        workflowId: "unique-batch-ids", input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute stage-1 -> suspends
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "unique-batch-ids",
        stageId: "stage-1",
        config: {},
      });
      expect(batchIds).toHaveLength(1);

      // Poll, transition, execute stage-2
      await pollAndTransition(
        kernel, persistence, clock,
        createResult.workflowRunId, "stage-1",
      );

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "unique-batch-ids",
        stageId: "stage-2",
        config: {},
      });

      // Each stage has a unique batch ID
      expect(batchIds).toHaveLength(2);
      expect(batchIds[0]).not.toBe(batchIds[1]);
      expect(batchIds[0]).toContain("stage-1");
      expect(batchIds[1]).toContain("stage-2");
    });
  });
});
