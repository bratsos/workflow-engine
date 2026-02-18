/**
 * Logging Tests (Kernel)
 *
 * In the kernel architecture, stage logging via ctx.log(level, message, meta)
 * calls persistence.createLog() directly (fire-and-forget). These tests verify
 * that log entries are correctly persisted with the expected level, message,
 * metadata, workflowRunId, and workflowStageId.
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
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder, type Workflow } from "../../core/workflow.js";

// ---------------------------------------------------------------------------
// Shared schema for all test stages
// ---------------------------------------------------------------------------

const valueSchema = z.object({ value: z.string() });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestKernel(workflows: Workflow<any, any>[]) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const scheduler = new NoopScheduler();
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
    scheduler,
    clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });

  return { kernel, persistence, eventSink, clock };
}

/**
 * Creates a run, sets it to RUNNING, and executes the specified stage.
 * Returns the workflowRunId so callers can inspect persistence afterwards.
 */
async function setupAndExecute(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  persistence: InMemoryWorkflowPersistence,
  workflowId: string,
  stageId: string,
  input: unknown,
): Promise<string> {
  const createResult = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: `key-${Date.now()}-${Math.random()}`,
    workflowId,
    input,
  });

  await persistence.updateRun(createResult.workflowRunId, { status: "RUNNING" });

  await kernel.dispatch({
    type: "job.execute",
    workflowRunId: createResult.workflowRunId,
    workflowId,
    stageId,
    config: {},
  });

  return createResult.workflowRunId;
}

// ===========================================================================
// Tests
// ===========================================================================

describe("I want to log from stages", () => {
  // -------------------------------------------------------------------------
  // basic logging
  // -------------------------------------------------------------------------
  describe("basic logging", () => {
    it("should persist log entries via ctx.log()", async () => {
      const stage = defineStage({
        id: "log-stage",
        name: "Log Stage",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("INFO", "Hello from stage");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "log-wf", "Log Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage).build();

      const { kernel, persistence } = createTestKernel([workflow]);
      await setupAndExecute(kernel, persistence, "log-wf", "log-stage", { value: "test" });

      const logs = persistence.getAllLogs();
      const match = logs.find((l) => l.message === "Hello from stage");
      expect(match).toBeDefined();
      expect(match!.level).toBe("INFO");
      expect(match!.message).toBe("Hello from stage");
    });

    it("should include workflowRunId and workflowStageId on log records", async () => {
      const stage = defineStage({
        id: "id-stage",
        name: "ID Stage",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("INFO", "check ids");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "id-wf", "ID Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage).build();

      const { kernel, persistence } = createTestKernel([workflow]);
      const runId = await setupAndExecute(kernel, persistence, "id-wf", "id-stage", { value: "test" });

      const logs = persistence.getAllLogs();
      const match = logs.find((l) => l.message === "check ids");
      expect(match).toBeDefined();
      expect(match!.workflowRunId).toBe(runId);
      expect(match!.workflowStageId).toBeDefined();
      expect(typeof match!.workflowStageId).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // log levels
  // -------------------------------------------------------------------------
  describe("log levels", () => {
    it("should persist DEBUG level logs", async () => {
      const stage = defineStage({
        id: "debug-stage",
        name: "Debug Stage",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("DEBUG", "debug message");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "debug-wf", "Debug Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage).build();

      const { kernel, persistence } = createTestKernel([workflow]);
      await setupAndExecute(kernel, persistence, "debug-wf", "debug-stage", { value: "test" });

      const logs = persistence.getAllLogs();
      const match = logs.find((l) => l.message === "debug message");
      expect(match).toBeDefined();
      expect(match!.level).toBe("DEBUG");
    });

    it("should persist INFO level logs", async () => {
      const stage = defineStage({
        id: "info-stage",
        name: "Info Stage",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("INFO", "info message");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "info-wf", "Info Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage).build();

      const { kernel, persistence } = createTestKernel([workflow]);
      await setupAndExecute(kernel, persistence, "info-wf", "info-stage", { value: "test" });

      const logs = persistence.getAllLogs();
      const match = logs.find((l) => l.message === "info message");
      expect(match).toBeDefined();
      expect(match!.level).toBe("INFO");
    });

    it("should persist WARN level logs", async () => {
      const stage = defineStage({
        id: "warn-stage",
        name: "Warn Stage",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("WARN", "warn message");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "warn-wf", "Warn Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage).build();

      const { kernel, persistence } = createTestKernel([workflow]);
      await setupAndExecute(kernel, persistence, "warn-wf", "warn-stage", { value: "test" });

      const logs = persistence.getAllLogs();
      const match = logs.find((l) => l.message === "warn message");
      expect(match).toBeDefined();
      expect(match!.level).toBe("WARN");
    });

    it("should persist ERROR level logs", async () => {
      const stage = defineStage({
        id: "error-stage",
        name: "Error Stage",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("ERROR", "error message");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "error-wf", "Error Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage).build();

      const { kernel, persistence } = createTestKernel([workflow]);
      await setupAndExecute(kernel, persistence, "error-wf", "error-stage", { value: "test" });

      const logs = persistence.getAllLogs();
      const match = logs.find((l) => l.message === "error message");
      expect(match).toBeDefined();
      expect(match!.level).toBe("ERROR");
    });
  });

  // -------------------------------------------------------------------------
  // log metadata
  // -------------------------------------------------------------------------
  describe("log metadata", () => {
    it("should persist log metadata", async () => {
      const stage = defineStage({
        id: "meta-stage",
        name: "Meta Stage",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("INFO", "with meta", { key: "value", count: 42 });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "meta-wf", "Meta Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage).build();

      const { kernel, persistence } = createTestKernel([workflow]);
      await setupAndExecute(kernel, persistence, "meta-wf", "meta-stage", { value: "test" });

      const logs = persistence.getAllLogs();
      const match = logs.find((l) => l.message === "with meta");
      expect(match).toBeDefined();
      expect(match!.metadata).toEqual({ key: "value", count: 42 });
    });

    it("should persist logs without metadata", async () => {
      const stage = defineStage({
        id: "no-meta-stage",
        name: "No Meta Stage",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("INFO", "no metadata");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "no-meta-wf", "No Meta Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage).build();

      const { kernel, persistence } = createTestKernel([workflow]);
      await setupAndExecute(kernel, persistence, "no-meta-wf", "no-meta-stage", { value: "test" });

      const logs = persistence.getAllLogs();
      const match = logs.find((l) => l.message === "no metadata");
      expect(match).toBeDefined();
      // metadata should be null when not provided (persistence defaults undefined -> null)
      expect(match!.metadata).toBeNull();
    });

    it("should persist nested metadata", async () => {
      const stage = defineStage({
        id: "nested-stage",
        name: "Nested Stage",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("INFO", "nested meta", { outer: { inner: "deep" } });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "nested-wf", "Nested Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage).build();

      const { kernel, persistence } = createTestKernel([workflow]);
      await setupAndExecute(kernel, persistence, "nested-wf", "nested-stage", { value: "test" });

      const logs = persistence.getAllLogs();
      const match = logs.find((l) => l.message === "nested meta");
      expect(match).toBeDefined();
      expect(match!.metadata).toEqual({ outer: { inner: "deep" } });
    });

    it("should persist error code metadata", async () => {
      const stage = defineStage({
        id: "errcode-stage",
        name: "Error Code Stage",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("ERROR", "timeout occurred", { errorCode: "ERR_TIMEOUT", retryable: true });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "errcode-wf", "Error Code Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage).build();

      const { kernel, persistence } = createTestKernel([workflow]);
      await setupAndExecute(kernel, persistence, "errcode-wf", "errcode-stage", { value: "test" });

      const logs = persistence.getAllLogs();
      const match = logs.find((l) => l.message === "timeout occurred");
      expect(match).toBeDefined();
      expect(match!.metadata).toEqual({ errorCode: "ERR_TIMEOUT", retryable: true });
    });
  });

  // -------------------------------------------------------------------------
  // multiple logs from stages
  // -------------------------------------------------------------------------
  describe("multiple logs from stages", () => {
    it("should persist multiple logs from a single stage", async () => {
      const stage = defineStage({
        id: "multi-log-stage",
        name: "Multi Log Stage",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("INFO", "first log");
          ctx.log("DEBUG", "second log");
          ctx.log("WARN", "third log");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-wf", "Multi Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage).build();

      const { kernel, persistence } = createTestKernel([workflow]);
      await setupAndExecute(kernel, persistence, "multi-wf", "multi-log-stage", { value: "test" });

      const logs = persistence.getAllLogs();
      const first = logs.find((l) => l.message === "first log");
      const second = logs.find((l) => l.message === "second log");
      const third = logs.find((l) => l.message === "third log");

      expect(first).toBeDefined();
      expect(first!.level).toBe("INFO");
      expect(second).toBeDefined();
      expect(second!.level).toBe("DEBUG");
      expect(third).toBeDefined();
      expect(third!.level).toBe("WARN");
    });

    it("should persist logs across multiple stages", async () => {
      const stage1 = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("INFO", "log from stage A");
          return { output: ctx.input };
        },
      });

      const stage2 = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: { input: valueSchema, output: valueSchema, config: z.object({}) },
        async execute(ctx) {
          ctx.log("INFO", "log from stage B");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "two-stage-wf", "Two Stage Workflow", "Test", valueSchema, valueSchema,
      ).pipe(stage1).pipe(stage2).build();

      const { kernel, persistence } = createTestKernel([workflow]);

      // Create a run and set it to RUNNING
      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: `key-two-stage-${Date.now()}`,
        workflowId: "two-stage-wf",
        input: { value: "test" },
      });

      await persistence.updateRun(createResult.workflowRunId, { status: "RUNNING" });

      // Execute stage A
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "two-stage-wf",
        stageId: "stage-a",
        config: {},
      });

      // Execute stage B
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "two-stage-wf",
        stageId: "stage-b",
        config: {},
      });

      const logs = persistence.getAllLogs();
      const logA = logs.find((l) => l.message === "log from stage A");
      const logB = logs.find((l) => l.message === "log from stage B");

      expect(logA).toBeDefined();
      expect(logB).toBeDefined();

      // Both logs should share the same workflowRunId
      expect(logA!.workflowRunId).toBe(createResult.workflowRunId);
      expect(logB!.workflowRunId).toBe(createResult.workflowRunId);

      // But they should have different workflowStageIds
      expect(logA!.workflowStageId).toBeDefined();
      expect(logB!.workflowStageId).toBeDefined();
      expect(logA!.workflowStageId).not.toBe(logB!.workflowStageId);
    });
  });
});
