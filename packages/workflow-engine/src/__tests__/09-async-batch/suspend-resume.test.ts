/**
 * Async Batch Suspend/Resume Tests
 *
 * Tests for multi-stage async batch workflows and chaining.
 *
 * Note: Basic suspend/resume mechanics are covered in 03-workflow-execution/suspend-resume.test.ts
 * This file focuses on:
 * - Chaining multiple async-batch stages
 * - Sequential async-batch workflows
 * - Mixed sync and async-batch stages
 * - State preservation across multiple suspensions
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../../core/executor.js";
import type { SimpleSuspendedResult } from "../../core/stage-factory.js";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  createPassthroughStage,
  InMemoryAICallLogger,
  InMemoryWorkflowPersistence,
  TestSchemas,
} from "../utils/index.js";

describe("I want to chain multiple async-batch stages", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  describe("sequential async-batch stages", () => {
    it("should suspend on first async-batch stage, then on second after resume", async () => {
      // Given: Two async-batch stages in sequence
      const executionLog: string[] = [];
      let firstComplete = false;
      let secondComplete = false;

      const firstAsyncStage = defineAsyncBatchStage({
        id: "first-async",
        name: "First Async",
        mode: "async-batch",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ firstResult: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("first-execute");
          if (ctx.resumeState) {
            executionLog.push("first-resume");
            return { output: { firstResult: `processed-${ctx.input.value}` } };
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-first",
              submittedAt: now.toISOString(),
              pollInterval: 100,
              maxWaitTime: 10000,
            },
            pollConfig: {
              pollInterval: 100,
              maxWaitTime: 10000,
              nextPollAt: new Date(now.getTime() + 100),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return {
            ready: firstComplete,
            output: { firstResult: "batch-1-done" },
          };
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
        async execute(ctx) {
          executionLog.push("second-execute");
          if (ctx.resumeState) {
            executionLog.push("second-resume");
            return {
              output: { finalResult: `final-${ctx.input.firstResult}` },
            };
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-second",
              submittedAt: now.toISOString(),
              pollInterval: 100,
              maxWaitTime: 10000,
            },
            pollConfig: {
              pollInterval: 100,
              maxWaitTime: 10000,
              nextPollAt: new Date(now.getTime() + 100),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return {
            ready: secondComplete,
            output: { finalResult: "batch-2-done" },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "chained-async",
        "Chained Async Workflow",
        "Test",
        z.object({ value: z.string() }),
        z.object({ finalResult: z.string() }),
      )
        .pipe(firstAsyncStage)
        .pipe(secondAsyncStage)
        .build();

      // Create run
      await persistence.createRun({
        id: "run-chain-1",
        workflowId: "chained-async",
        workflowName: "Chained Async Workflow",
        status: "PENDING",
        input: { value: "test" },
      });

      // When: First execution - should suspend on first stage
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-chain-1",
        "chained-async",
        {
          persistence,
          aiLogger,
        },
      );
      const result1 = await executor1.execute({ value: "test" }, {});

      // Then: Suspended on first stage
      expect(result1).toBe("suspended");
      expect(executionLog).toEqual(["first-execute"]);

      // When: First stage completes and we resume
      firstComplete = true;
      const stages = await persistence.getStagesByRun("run-chain-1", {});
      const firstStage = stages.find((s) => s.stageId === "first-async");
      if (firstStage) {
        await persistence.updateStage(firstStage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      const executor2 = new WorkflowExecutor(
        workflow,
        "run-chain-1",
        "chained-async",
        {
          persistence,
          aiLogger,
        },
      );
      const result2 = await executor2.execute(
        { value: "test" },
        {},
        { resume: true },
      );

      // Then: Should suspend on second stage
      expect(result2).toBe("suspended");
      expect(executionLog).toContain("first-resume");
      expect(executionLog).toContain("second-execute");

      // When: Second stage completes and we resume
      secondComplete = true;
      const stages2 = await persistence.getStagesByRun("run-chain-1", {});
      const secondStage = stages2.find((s) => s.stageId === "second-async");
      if (secondStage) {
        await persistence.updateStage(secondStage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      const executor3 = new WorkflowExecutor(
        workflow,
        "run-chain-1",
        "chained-async",
        {
          persistence,
          aiLogger,
        },
      );
      const result3 = await executor3.execute(
        { value: "test" },
        {},
        { resume: true },
      );

      // Then: Workflow completes
      expect(result3).toEqual({ finalResult: "final-processed-test" });
      expect(executionLog).toContain("second-resume");
    });

    it("should track suspension count across multiple stages", async () => {
      // Given: Workflow with tracking of suspension events
      const suspendEvents: Array<{ stageId: string; stageName: string }> = [];
      let stagesReady = new Set<string>();

      const createTrackedAsyncStage = (
        id: string,
        inputSchema: z.ZodTypeAny,
        outputSchema: z.ZodTypeAny,
      ) => {
        return defineAsyncBatchStage({
          id,
          name: `Stage ${id}`,
          mode: "async-batch",
          schemas: {
            input: inputSchema,
            output: outputSchema,
            config: z.object({}),
          },
          async execute(ctx) {
            if (ctx.resumeState) {
              return { output: ctx.input };
            }
            const now = new Date();
            return {
              suspended: true,
              state: {
                batchId: `batch-${id}`,
                submittedAt: now.toISOString(),
                pollInterval: 100,
                maxWaitTime: 10000,
              },
              pollConfig: {
                pollInterval: 100,
                maxWaitTime: 10000,
                nextPollAt: new Date(now.getTime() + 100),
              },
            } as SimpleSuspendedResult;
          },
          async checkCompletion() {
            return { ready: stagesReady.has(id) };
          },
        });
      };

      const workflow = new WorkflowBuilder(
        "multi-suspend",
        "Multi Suspend Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(
          createTrackedAsyncStage(
            "stage-a",
            TestSchemas.string,
            TestSchemas.string,
          ),
        )
        .pipe(
          createTrackedAsyncStage(
            "stage-b",
            TestSchemas.string,
            TestSchemas.string,
          ),
        )
        .pipe(
          createTrackedAsyncStage(
            "stage-c",
            TestSchemas.string,
            TestSchemas.string,
          ),
        )
        .build();

      await persistence.createRun({
        id: "run-multi-suspend",
        workflowId: "multi-suspend",
        workflowName: "Multi Suspend Workflow",
        status: "PENDING",
        input: { value: "data" },
      });

      // Execute and track suspensions
      const executeAndResume = async () => {
        const executor = new WorkflowExecutor(
          workflow,
          "run-multi-suspend",
          "multi-suspend",
          { persistence, aiLogger },
        );
        executor.on("stage:suspended", (data) => {
          suspendEvents.push(data as { stageId: string; stageName: string });
        });
        return executor.execute(
          { value: "data" },
          {},
          { resume: suspendEvents.length > 0 },
        );
      };

      // First suspension
      await executeAndResume();
      expect(suspendEvents).toHaveLength(1);
      expect(suspendEvents[0].stageId).toBe("stage-a");

      // Resume stage-a, suspend on stage-b
      stagesReady.add("stage-a");
      const stages1 = await persistence.getStagesByRun("run-multi-suspend", {});
      for (const stage of stages1) {
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }
      await executeAndResume();
      expect(suspendEvents).toHaveLength(2);
      expect(suspendEvents[1].stageId).toBe("stage-b");

      // Resume stage-b, suspend on stage-c
      stagesReady.add("stage-b");
      const stages2 = await persistence.getStagesByRun("run-multi-suspend", {});
      for (const stage of stages2) {
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }
      await executeAndResume();
      expect(suspendEvents).toHaveLength(3);
      expect(suspendEvents[2].stageId).toBe("stage-c");
    });
  });

  describe("mixed sync and async-batch stages", () => {
    it("should execute sync stages before async-batch stage suspends", async () => {
      // Given: Sync -> Async-batch -> Sync workflow
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
        async execute(ctx) {
          executionOrder.push("async-middle");
          if (ctx.resumeState) {
            executionOrder.push("async-middle-resume");
            return { output: { value: ctx.input.value, asyncProcessed: true } };
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-middle",
              submittedAt: now.toISOString(),
              pollInterval: 100,
              maxWaitTime: 10000,
            },
            pollConfig: {
              pollInterval: 100,
              maxWaitTime: 10000,
              nextPollAt: new Date(now.getTime() + 100),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return {
            ready: true,
            output: { value: "async-done", asyncProcessed: true },
          };
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
        "mixed-workflow",
        "Mixed Workflow",
        "Test",
        z.object({ value: z.string() }),
        z.object({ finalValue: z.string() }),
      )
        .pipe(syncFirst)
        .pipe(asyncMiddle)
        .pipe(syncLast)
        .build();

      await persistence.createRun({
        id: "run-mixed",
        workflowId: "mixed-workflow",
        workflowName: "Mixed Workflow",
        status: "PENDING",
        input: { value: "test" },
      });

      // When: First execution
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-mixed",
        "mixed-workflow",
        {
          persistence,
          aiLogger,
        },
      );
      const result1 = await executor1.execute({ value: "test" }, {});

      // Then: Sync first ran, async suspended
      expect(result1).toBe("suspended");
      expect(executionOrder).toEqual(["sync-first", "async-middle"]);

      // When: Resume
      const stages = await persistence.getStagesByRun("run-mixed", {});
      const asyncStage = stages.find((s) => s.stageId === "async-middle");
      if (asyncStage) {
        await persistence.updateStage(asyncStage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      const executor2 = new WorkflowExecutor(
        workflow,
        "run-mixed",
        "mixed-workflow",
        {
          persistence,
          aiLogger,
        },
      );
      const result2 = await executor2.execute(
        { value: "test" },
        {},
        { resume: true },
      );

      // Then: All stages completed
      expect(result2).toEqual({ finalValue: "final-test" });
      expect(executionOrder).toContain("async-middle-resume");
      expect(executionOrder).toContain("sync-last");
    });

    it("should preserve sync stage outputs when async-batch suspends", async () => {
      // Given: Sync stage that produces output used by later stages
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

      let resumeCount = 0;
      const asyncStage = defineAsyncBatchStage({
        id: "data-processor",
        name: "Data Processor",
        mode: "async-batch",
        schemas: {
          input: z.object({ data: z.array(z.number()) }),
          output: z.object({ sum: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            resumeCount++;
            // Should receive the data from sync stage
            const sum = ctx.input.data.reduce((a, b) => a + b, 0);
            return { output: { sum } };
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-process",
              submittedAt: now.toISOString(),
              pollInterval: 100,
              maxWaitTime: 10000,
            },
            pollConfig: {
              pollInterval: 100,
              maxWaitTime: 10000,
              nextPollAt: new Date(now.getTime() + 100),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return { ready: true, output: { sum: 60 } };
        },
      });

      const workflow = new WorkflowBuilder(
        "preserve-output",
        "Preserve Output Workflow",
        "Test",
        z.object({ seed: z.number() }),
        z.object({ sum: z.number() }),
      )
        .pipe(syncStage)
        .pipe(asyncStage)
        .build();

      await persistence.createRun({
        id: "run-preserve",
        workflowId: "preserve-output",
        workflowName: "Preserve Output Workflow",
        status: "PENDING",
        input: { seed: 10 },
      });

      // Execute and suspend
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-preserve",
        "preserve-output",
        {
          persistence,
          aiLogger,
        },
      );
      await executor1.execute({ seed: 10 }, {});

      // Resume
      const stages = await persistence.getStagesByRun("run-preserve", {});
      const asyncStageRecord = stages.find(
        (s) => s.stageId === "data-processor",
      );
      if (asyncStageRecord) {
        await persistence.updateStage(asyncStageRecord.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      const executor2 = new WorkflowExecutor(
        workflow,
        "run-preserve",
        "preserve-output",
        {
          persistence,
          aiLogger,
        },
      );
      const result = await executor2.execute(
        { seed: 10 },
        {},
        { resume: true },
      );

      // Then: Resume received correct data from sync stage
      expect(resumeCount).toBe(1);
      expect(result).toEqual({ sum: 60 }); // 10 + 20 + 30 = 60
    });
  });

  describe("async-batch state management", () => {
    it("should preserve custom metadata in suspended state across resume", async () => {
      // Given: Stage that stores custom metadata
      let capturedMetadata: Record<string, unknown> | undefined;

      const asyncStage = defineAsyncBatchStage({
        id: "metadata-stage",
        name: "Metadata Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ processed: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            capturedMetadata = ctx.resumeState.metadata;
            return { output: { processed: true } };
          }
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
            pollConfig: {
              pollInterval: 100,
              maxWaitTime: 10000,
              nextPollAt: new Date(now.getTime() + 100),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return { ready: true, output: { processed: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "metadata-workflow",
        "Metadata Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ processed: z.boolean() }),
      )
        .pipe(asyncStage)
        .build();

      await persistence.createRun({
        id: "run-metadata",
        workflowId: "metadata-workflow",
        workflowName: "Metadata Workflow",
        status: "PENDING",
        input: {},
      });

      // Execute and suspend
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-metadata",
        "metadata-workflow",
        {
          persistence,
          aiLogger,
        },
      );
      await executor1.execute({}, {});

      // Resume
      const stages = await persistence.getStagesByRun("run-metadata", {});
      const stage = stages.find((s) => s.stageId === "metadata-stage");
      if (stage) {
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      const executor2 = new WorkflowExecutor(
        workflow,
        "run-metadata",
        "metadata-workflow",
        {
          persistence,
          aiLogger,
        },
      );
      await executor2.execute({}, {}, { resume: true });

      // Then: Metadata was preserved
      expect(capturedMetadata).toEqual({
        customField: "custom-value",
        itemCount: 42,
        tags: ["tag1", "tag2"],
      });
    });

    it("should provide unique batch IDs for each stage in chain", async () => {
      // Given: Multiple async stages that record their batch IDs
      const batchIds: string[] = [];

      const createBatchIdStage = (id: string, order: number) => {
        return defineAsyncBatchStage({
          id,
          name: `Stage ${id}`,
          mode: "async-batch",
          schemas: {
            input: z.object({}).passthrough(),
            output: z.object({}).passthrough(),
            config: z.object({}),
          },
          async execute(ctx) {
            if (ctx.resumeState) {
              return { output: {} };
            }
            const batchId = `batch-${id}-${Date.now()}`;
            batchIds.push(batchId);
            const now = new Date();
            return {
              suspended: true,
              state: {
                batchId,
                submittedAt: now.toISOString(),
                pollInterval: 100,
                maxWaitTime: 10000,
              },
              pollConfig: {
                pollInterval: 100,
                maxWaitTime: 10000,
                nextPollAt: new Date(now.getTime() + 100),
              },
            } as SimpleSuspendedResult;
          },
          async checkCompletion() {
            return { ready: true, output: {} };
          },
        });
      };

      const workflow = new WorkflowBuilder(
        "unique-batch-ids",
        "Unique Batch IDs Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}).passthrough(),
      )
        .pipe(createBatchIdStage("stage-1", 1))
        .pipe(createBatchIdStage("stage-2", 2))
        .build();

      await persistence.createRun({
        id: "run-batch-ids",
        workflowId: "unique-batch-ids",
        workflowName: "Unique Batch IDs Workflow",
        status: "PENDING",
        input: {},
      });

      // Execute stage 1
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-batch-ids",
        "unique-batch-ids",
        {
          persistence,
          aiLogger,
        },
      );
      await executor1.execute({}, {});
      expect(batchIds).toHaveLength(1);

      // Resume and execute stage 2
      const stages = await persistence.getStagesByRun("run-batch-ids", {});
      for (const stage of stages) {
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      const executor2 = new WorkflowExecutor(
        workflow,
        "run-batch-ids",
        "unique-batch-ids",
        {
          persistence,
          aiLogger,
        },
      );
      await executor2.execute({}, {}, { resume: true });

      // Then: Each stage has unique batch ID
      expect(batchIds).toHaveLength(2);
      expect(batchIds[0]).not.toBe(batchIds[1]);
      expect(batchIds[0]).toContain("stage-1");
      expect(batchIds[1]).toContain("stage-2");
    });
  });
});
