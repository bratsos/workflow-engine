/**
 * Stage Events Tests
 *
 * Tests for stage lifecycle events during workflow execution:
 * - stage:started
 * - stage:completed (with timing)
 * - stage:failed
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow.js";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import {
  InMemoryWorkflowPersistence,
  InMemoryAICallLogger,
  createPassthroughStage,
  createErrorStage,
  TestSchemas,
} from "../utils/index.js";

describe("I want to track stage lifecycle events", () => {
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

  describe("stage:started events", () => {
    it("should emit stage:started for each stage", async () => {
      // Given: A workflow with multiple stages
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);
      const stageC = createPassthroughStage("stage-c", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "multi-stage-started",
        "Multi Stage Started Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      await createRun("run-started-1", "multi-stage-started", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-started-1",
        "multi-stage-started",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect stage:started events
      const startedEvents: Array<{ stageId: string; stageName: string }> = [];
      executor.on("stage:started", (data) => {
        startedEvents.push(data as { stageId: string; stageName: string });
      });

      // When: Execute the workflow
      await executor.execute({ value: "test" }, {});

      // Then: stage:started was emitted for each stage
      expect(startedEvents).toHaveLength(3);
      expect(startedEvents.map((e) => e.stageId)).toEqual([
        "stage-a",
        "stage-b",
        "stage-c",
      ]);
    });

    it("should include stageId and stageName in stage:started event", async () => {
      // Given: A stage with specific id and name
      const stage = defineStage({
        id: "my-stage-id",
        name: "My Stage Name",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "stage-info-test",
        "Stage Info Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-started-2", "stage-info-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-started-2",
        "stage-info-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect stage:started events
      let startedEvent: Record<string, unknown> | null = null;
      executor.on("stage:started", (data) => {
        startedEvent = data as Record<string, unknown>;
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Event includes both stageId and stageName
      expect(startedEvent).not.toBeNull();
      expect(startedEvent?.stageId).toBe("my-stage-id");
      expect(startedEvent?.stageName).toBe("My Stage Name");
    });

    it("should emit stage:started before stage execution begins", async () => {
      // Given: A stage that tracks when it starts executing
      const timeline: string[] = [];

      const stage = defineStage({
        id: "timing-stage",
        name: "Timing Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          timeline.push("stage-execute");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "timing-test",
        "Timing Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-started-3", "timing-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-started-3",
        "timing-test",
        {
          persistence,
          aiLogger,
        },
      );

      executor.on("stage:started", () => {
        timeline.push("stage:started");
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: stage:started was emitted before execute ran
      expect(timeline[0]).toBe("stage:started");
      expect(timeline[1]).toBe("stage-execute");
    });
  });

  describe("stage:completed events", () => {
    it("should emit stage:completed for each stage", async () => {
      // Given: A workflow with multiple stages
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "multi-stage-completed",
        "Multi Stage Completed Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      await createRun("run-completed-1", "multi-stage-completed", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-completed-1",
        "multi-stage-completed",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect stage:completed events
      const completedEvents: Array<{ stageId: string }> = [];
      executor.on("stage:completed", (data) => {
        completedEvents.push(data as { stageId: string });
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: stage:completed was emitted for each stage
      expect(completedEvents).toHaveLength(2);
      expect(completedEvents.map((e) => e.stageId)).toEqual([
        "stage-a",
        "stage-b",
      ]);
    });

    it("should include timing in stage:completed event", async () => {
      // Given: A stage that takes some time
      const stage = defineStage({
        id: "slow-stage",
        name: "Slow Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          await new Promise((r) => setTimeout(r, 50)); // Wait 50ms
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "timing-complete-test",
        "Timing Complete Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-completed-2", "timing-complete-test", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-completed-2",
        "timing-complete-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect stage:completed event
      let completedEvent: Record<string, unknown> | null = null;
      executor.on("stage:completed", (data) => {
        completedEvent = data as Record<string, unknown>;
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Event includes timing info
      expect(completedEvent).not.toBeNull();
      expect(completedEvent?.stageId).toBe("slow-stage");
      // Duration should be at least 50ms (the event uses 'duration' not 'durationMs')
      expect(completedEvent?.duration).toBeDefined();
      expect(typeof completedEvent?.duration).toBe("number");
      expect(completedEvent?.duration as number).toBeGreaterThanOrEqual(45); // Allow some tolerance
    });

    it("should emit stage:completed after stage:started", async () => {
      // Given: A stage
      const stage = createPassthroughStage("order-test", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "event-order-test",
        "Event Order Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-completed-3", "event-order-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-completed-3",
        "event-order-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect events in order
      const events: string[] = [];
      executor.on("stage:started", () => events.push("stage:started"));
      executor.on("stage:completed", () => events.push("stage:completed"));

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Events are in correct order
      expect(events).toEqual(["stage:started", "stage:completed"]);
    });

    it("should include stageId and stageName in stage:completed event", async () => {
      // Given: A stage with specific id and name
      const stage = defineStage({
        id: "complete-info-stage",
        name: "Complete Info Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "complete-info-test",
        "Complete Info Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-completed-4", "complete-info-test", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-completed-4",
        "complete-info-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect stage:completed event
      let completedEvent: Record<string, unknown> | null = null;
      executor.on("stage:completed", (data) => {
        completedEvent = data as Record<string, unknown>;
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Event includes stageId and stageName
      expect(completedEvent).not.toBeNull();
      expect(completedEvent?.stageId).toBe("complete-info-stage");
      expect(completedEvent?.stageName).toBe("Complete Info Stage");
    });
  });

  describe("stage:failed events", () => {
    it("should emit stage:failed on stage error", async () => {
      // Given: A stage that throws an error
      const errorStage = createErrorStage(
        "failing-stage",
        "Stage error message",
      );

      const workflow = new WorkflowBuilder(
        "stage-failed-test",
        "Stage Failed Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      await createRun("run-failed-1", "stage-failed-test", {});

      const executor = new WorkflowExecutor(
        workflow,
        "run-failed-1",
        "stage-failed-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect stage:failed events
      let failedEvent: Record<string, unknown> | null = null;
      executor.on("stage:failed", (data) => {
        failedEvent = data as Record<string, unknown>;
      });

      // When: Execute (and it fails)
      await expect(executor.execute({}, {})).rejects.toThrow();

      // Then: stage:failed was emitted
      expect(failedEvent).not.toBeNull();
      expect(failedEvent?.stageId).toBe("failing-stage");
    });

    it("should include error message in stage:failed event", async () => {
      // Given: A stage that throws a specific error
      const errorStage = createErrorStage(
        "error-msg-stage",
        "Specific error message",
      );

      const workflow = new WorkflowBuilder(
        "error-msg-test",
        "Error Message Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      await createRun("run-failed-2", "error-msg-test", {});

      const executor = new WorkflowExecutor(
        workflow,
        "run-failed-2",
        "error-msg-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect stage:failed event
      let failedEvent: Record<string, unknown> | null = null;
      executor.on("stage:failed", (data) => {
        failedEvent = data as Record<string, unknown>;
      });

      // When: Execute (and it fails)
      await expect(executor.execute({}, {})).rejects.toThrow();

      // Then: Event includes the error message
      expect(failedEvent).not.toBeNull();
      expect(failedEvent?.error).toContain("Specific error message");
    });

    it("should emit stage:started before stage:failed", async () => {
      // Given: A failing stage
      const errorStage = createErrorStage(
        "fail-order-stage",
        "Fail order test",
      );

      const workflow = new WorkflowBuilder(
        "fail-order-test",
        "Fail Order Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      await createRun("run-failed-3", "fail-order-test", {});

      const executor = new WorkflowExecutor(
        workflow,
        "run-failed-3",
        "fail-order-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect events in order
      const events: string[] = [];
      executor.on("stage:started", () => events.push("stage:started"));
      executor.on("stage:failed", () => events.push("stage:failed"));

      // When: Execute (and it fails)
      await expect(executor.execute({}, {})).rejects.toThrow();

      // Then: stage:started came before stage:failed
      expect(events).toEqual(["stage:started", "stage:failed"]);
    });

    it("should only emit stage:failed for the failing stage in multi-stage workflow", async () => {
      // Given: A workflow where the second stage fails
      const successStage = createPassthroughStage(
        "success-stage",
        TestSchemas.string,
      );
      const errorStage = defineStage({
        id: "error-stage",
        name: "Error Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute() {
          throw new Error("Second stage failed");
        },
      });

      const workflow = new WorkflowBuilder(
        "partial-fail-test",
        "Partial Fail Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(successStage)
        .pipe(errorStage)
        .build();

      await createRun("run-failed-4", "partial-fail-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-failed-4",
        "partial-fail-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect events
      const completedStages: string[] = [];
      const failedStages: string[] = [];

      executor.on("stage:completed", (data) => {
        completedStages.push((data as { stageId: string }).stageId);
      });
      executor.on("stage:failed", (data) => {
        failedStages.push((data as { stageId: string }).stageId);
      });

      // When: Execute (and it fails)
      await expect(executor.execute({ value: "test" }, {})).rejects.toThrow();

      // Then: First stage completed, second stage failed
      expect(completedStages).toEqual(["success-stage"]);
      expect(failedStages).toEqual(["error-stage"]);
    });
  });
});
