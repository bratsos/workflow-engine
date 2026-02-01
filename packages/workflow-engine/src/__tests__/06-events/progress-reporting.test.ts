/**
 * Progress Reporting Tests
 *
 * Tests for stage progress reporting during workflow execution:
 * - stage:progress events
 * - Multiple progress updates
 * - Progress event details
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow.js";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import {
  InMemoryWorkflowPersistence,
  InMemoryAICallLogger,
  TestSchemas,
} from "../utils/index.js";

describe("I want to track stage progress", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  // Helper to create a workflow run before execution
  async function createRun(
    runId: string,
    workflowId: string,
    input: unknown = {},
  ) {
    await persistence.createRun({
      id: runId,
      workflowId,
      workflowName: workflowId,
      status: "PENDING",
      input,
    });
  }

  describe("basic progress reporting", () => {
    it("should emit stage:progress when reported", async () => {
      // Given: A stage that reports progress
      const stage = defineStage({
        id: "progress-stage",
        name: "Progress Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 50, message: "halfway done" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "progress-test",
        "Progress Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-progress-1", "progress-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-progress-1",
        "progress-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect progress events
      const progressEvents: unknown[] = [];
      executor.on("stage:progress", (data) => {
        progressEvents.push(data);
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Progress event was emitted
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0]).toMatchObject({
        progress: 50,
        message: "halfway done",
      });
    });

    it("should emit progress event with correct properties", async () => {
      // Given: A stage that reports progress with all properties
      const stage = defineStage({
        id: "full-progress-stage",
        name: "Full Progress Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 25, message: "started" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "full-progress-test",
        "Full Progress Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-progress-2", "full-progress-test", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-progress-2",
        "full-progress-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect progress events
      let progressEvent: Record<string, unknown> | null = null;
      executor.on("stage:progress", (data) => {
        progressEvent = data as Record<string, unknown>;
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Progress event includes progress and message
      expect(progressEvent).not.toBeNull();
      expect(progressEvent?.progress).toBe(25);
      expect(progressEvent?.message).toBe("started");
    });
  });

  describe("multiple progress updates", () => {
    it("should emit multiple progress updates", async () => {
      // Given: A stage that reports multiple progress updates
      const stage = defineStage({
        id: "multi-progress-stage",
        name: "Multi Progress Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 25, message: "step 1" });
          ctx.onProgress({ progress: 50, message: "step 2" });
          ctx.onProgress({ progress: 75, message: "step 3" });
          ctx.onProgress({ progress: 100, message: "complete" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-progress-test",
        "Multi Progress Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-progress-3", "multi-progress-test", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-progress-3",
        "multi-progress-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect progress events
      const progressEvents: Array<{ progress: number; message: string }> = [];
      executor.on("stage:progress", (data) => {
        progressEvents.push(data as { progress: number; message: string });
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: All progress updates were emitted
      expect(progressEvents).toHaveLength(4);
      expect(progressEvents.map((e) => e.progress)).toEqual([25, 50, 75, 100]);
      expect(progressEvents.map((e) => e.message)).toEqual([
        "step 1",
        "step 2",
        "step 3",
        "complete",
      ]);
    });

    it("should emit progress in correct order", async () => {
      // Given: A stage that reports progress updates with timestamps
      const timestamps: { progress: number; time: number }[] = [];

      const stage = defineStage({
        id: "ordered-progress-stage",
        name: "Ordered Progress Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 10, message: "first" });
          await new Promise((r) => setTimeout(r, 10));
          ctx.onProgress({ progress: 50, message: "middle" });
          await new Promise((r) => setTimeout(r, 10));
          ctx.onProgress({ progress: 90, message: "last" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "ordered-progress-test",
        "Ordered Progress Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-progress-4", "ordered-progress-test", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-progress-4",
        "ordered-progress-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect progress events with timestamps
      executor.on("stage:progress", (data) => {
        const event = data as { progress: number };
        timestamps.push({ progress: event.progress, time: Date.now() });
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Progress events were in order and times increase
      expect(timestamps).toHaveLength(3);
      expect(timestamps[0].progress).toBe(10);
      expect(timestamps[1].progress).toBe(50);
      expect(timestamps[2].progress).toBe(90);
      expect(timestamps[1].time).toBeGreaterThanOrEqual(timestamps[0].time);
      expect(timestamps[2].time).toBeGreaterThanOrEqual(timestamps[1].time);
    });

    it("should track progress across multiple stages", async () => {
      // Given: Multiple stages that each report progress with identifiable messages
      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 50, message: "A progress" });
          return { output: ctx.input };
        },
      });

      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 50, message: "B progress" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-stage-progress-test",
        "Multi Stage Progress Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      await createRun("run-progress-5", "multi-stage-progress-test", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-progress-5",
        "multi-stage-progress-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect progress events
      const progressEvents: Array<{ progress: number; message: string }> = [];
      executor.on("stage:progress", (data) => {
        progressEvents.push(data as { progress: number; message: string });
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Both stages emitted progress events
      expect(progressEvents).toHaveLength(2);
      expect(progressEvents.map((e) => e.message)).toContain("A progress");
      expect(progressEvents.map((e) => e.message)).toContain("B progress");
    });
  });

  describe("progress event details", () => {
    it("should include details in progress event", async () => {
      // Given: A stage that reports progress with detailed information
      const stage = defineStage({
        id: "detailed-progress-stage",
        name: "Detailed Progress Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({
            progress: 60,
            message: "processing items",
            details: {
              itemsProcessed: 30,
              totalItems: 50,
              currentItem: "item-30",
            },
          });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "detailed-progress-test",
        "Detailed Progress Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-progress-6", "detailed-progress-test", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-progress-6",
        "detailed-progress-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect progress events
      let progressEvent: Record<string, unknown> | null = null;
      executor.on("stage:progress", (data) => {
        progressEvent = data as Record<string, unknown>;
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Progress event includes details
      expect(progressEvent).not.toBeNull();
      expect(progressEvent?.progress).toBe(60);
      expect(progressEvent?.message).toBe("processing items");
      expect(progressEvent?.details).toEqual({
        itemsProcessed: 30,
        totalItems: 50,
        currentItem: "item-30",
      });
    });

    it("should handle progress without details", async () => {
      // Given: A stage that reports progress without details
      const stage = defineStage({
        id: "simple-progress-stage",
        name: "Simple Progress Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 50, message: "halfway" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "simple-progress-test",
        "Simple Progress Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-progress-7", "simple-progress-test", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-progress-7",
        "simple-progress-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect progress events
      let progressEvent: Record<string, unknown> | null = null;
      executor.on("stage:progress", (data) => {
        progressEvent = data as Record<string, unknown>;
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Progress event was emitted without error
      expect(progressEvent).not.toBeNull();
      expect(progressEvent?.progress).toBe(50);
      expect(progressEvent?.message).toBe("halfway");
    });

    it("should handle complex nested details", async () => {
      // Given: A stage that reports progress with deeply nested details
      const stage = defineStage({
        id: "nested-details-stage",
        name: "Nested Details Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({
            progress: 75,
            message: "processing",
            details: {
              batch: {
                id: "batch-123",
                size: 100,
                processed: 75,
              },
              errors: [],
              metadata: {
                startTime: "2024-01-01T00:00:00Z",
                source: "test",
              },
            },
          });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "nested-details-test",
        "Nested Details Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-progress-8", "nested-details-test", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-progress-8",
        "nested-details-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect progress events
      let progressEvent: Record<string, unknown> | null = null;
      executor.on("stage:progress", (data) => {
        progressEvent = data as Record<string, unknown>;
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Nested details are preserved
      expect(progressEvent).not.toBeNull();
      const details = progressEvent?.details as Record<string, unknown>;
      expect(details?.batch).toEqual({
        id: "batch-123",
        size: 100,
        processed: 75,
      });
      expect(details?.errors).toEqual([]);
      expect(details?.metadata).toEqual({
        startTime: "2024-01-01T00:00:00Z",
        source: "test",
      });
    });
  });
});
