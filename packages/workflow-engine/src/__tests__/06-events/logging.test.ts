/**
 * Logging Tests
 *
 * Tests for log events during workflow execution:
 * - log events via ctx.onLog()
 * - Different log levels (INFO, WARN, ERROR, DEBUG)
 * - Metadata in log events
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  InMemoryAICallLogger,
  InMemoryWorkflowPersistence,
  TestSchemas,
} from "../utils/index.js";

describe("I want to log from stages", () => {
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

  describe("basic logging", () => {
    it("should emit log events", async () => {
      // Given: A stage that logs a message
      const stage = defineStage({
        id: "logging-stage",
        name: "Logging Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("INFO", "This is a log message");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "logging-test",
        "Logging Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-log-1", "logging-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-1",
        "logging-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events
      const logEvents: unknown[] = [];
      executor.on("log", (data) => {
        logEvents.push(data);
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Log event was emitted
      const stageLog = logEvents.find(
        (e: any) => e.message === "This is a log message",
      );
      expect(stageLog).toBeDefined();
    });

    it("should emit log event with correct structure", async () => {
      // Given: A stage that logs
      const stage = defineStage({
        id: "structured-logging-stage",
        name: "Structured Logging Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("INFO", "Stage-specific log", { key: "value" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "structured-log-test",
        "Structured Log Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-log-2", "structured-log-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-2",
        "structured-log-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events
      const logEvents: Array<{
        level: string;
        message: string;
        meta?: Record<string, unknown>;
      }> = [];
      executor.on("log", (data) => {
        logEvents.push(
          data as {
            level: string;
            message: string;
            meta?: Record<string, unknown>;
          },
        );
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Log event has correct structure (level, message, meta)
      const stageLog = logEvents.find(
        (e) => e.message === "Stage-specific log",
      );
      expect(stageLog).toBeDefined();
      expect(stageLog?.level).toBe("INFO");
      expect(stageLog?.meta).toEqual({ key: "value" });
    });
  });

  describe("log levels", () => {
    it("should support different log levels", async () => {
      // Given: A stage that logs at various levels
      const stage = defineStage({
        id: "multi-level-stage",
        name: "Multi Level Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("INFO", "info message");
          ctx.onLog("WARN", "warning message");
          ctx.onLog("ERROR", "error message");
          ctx.onLog("DEBUG", "debug message");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "log-levels-test",
        "Log Levels Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-log-3", "log-levels-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-3",
        "log-levels-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events
      const logEvents: Array<{ level: string; message: string }> = [];
      executor.on("log", (data) => {
        logEvents.push(data as { level: string; message: string });
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: All log levels were captured
      const infoLog = logEvents.find(
        (e) => e.level === "INFO" && e.message === "info message",
      );
      const warnLog = logEvents.find(
        (e) => e.level === "WARN" && e.message === "warning message",
      );
      const errorLog = logEvents.find(
        (e) => e.level === "ERROR" && e.message === "error message",
      );
      const debugLog = logEvents.find(
        (e) => e.level === "DEBUG" && e.message === "debug message",
      );

      expect(infoLog).toBeDefined();
      expect(warnLog).toBeDefined();
      expect(errorLog).toBeDefined();
      expect(debugLog).toBeDefined();
    });

    it("should correctly tag INFO level logs", async () => {
      // Given: A stage that logs at INFO level
      const stage = defineStage({
        id: "info-stage",
        name: "Info Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("INFO", "information message");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "info-log-test",
        "Info Log Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-log-4", "info-log-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-4",
        "info-log-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events
      let logEvent: Record<string, unknown> | null = null;
      executor.on("log", (data) => {
        const event = data as Record<string, unknown>;
        if (event.message === "information message") {
          logEvent = event;
        }
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Log has INFO level
      expect(logEvent).not.toBeNull();
      expect(logEvent?.level).toBe("INFO");
    });

    it("should correctly tag WARN level logs", async () => {
      // Given: A stage that logs at WARN level
      const stage = defineStage({
        id: "warn-stage",
        name: "Warn Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("WARN", "warning message");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "warn-log-test",
        "Warn Log Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-log-5", "warn-log-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-5",
        "warn-log-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events
      let logEvent: Record<string, unknown> | null = null;
      executor.on("log", (data) => {
        const event = data as Record<string, unknown>;
        if (event.message === "warning message") {
          logEvent = event;
        }
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Log has WARN level
      expect(logEvent).not.toBeNull();
      expect(logEvent?.level).toBe("WARN");
    });

    it("should correctly tag ERROR level logs", async () => {
      // Given: A stage that logs at ERROR level
      const stage = defineStage({
        id: "error-stage",
        name: "Error Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("ERROR", "error message");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "error-log-test",
        "Error Log Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-log-6", "error-log-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-6",
        "error-log-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events
      let logEvent: Record<string, unknown> | null = null;
      executor.on("log", (data) => {
        const event = data as Record<string, unknown>;
        if (event.message === "error message") {
          logEvent = event;
        }
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Log has ERROR level
      expect(logEvent).not.toBeNull();
      expect(logEvent?.level).toBe("ERROR");
    });
  });

  describe("log metadata", () => {
    it("should include metadata in logs", async () => {
      // Given: A stage that logs with metadata
      const stage = defineStage({
        id: "metadata-stage",
        name: "Metadata Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("INFO", "log with metadata", { key: "value", count: 42 });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "metadata-log-test",
        "Metadata Log Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-log-7", "metadata-log-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-7",
        "metadata-log-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events
      let logEvent: Record<string, unknown> | null = null;
      executor.on("log", (data) => {
        const event = data as Record<string, unknown>;
        if (event.message === "log with metadata") {
          logEvent = event;
        }
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Log event includes metadata
      expect(logEvent).not.toBeNull();
      expect(logEvent?.meta).toEqual({ key: "value", count: 42 });
    });

    it("should handle logs without metadata", async () => {
      // Given: A stage that logs without metadata
      const stage = defineStage({
        id: "no-metadata-stage",
        name: "No Metadata Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("INFO", "log without metadata");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "no-metadata-log-test",
        "No Metadata Log Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-log-8", "no-metadata-log-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-8",
        "no-metadata-log-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events
      let logEvent: Record<string, unknown> | null = null;
      executor.on("log", (data) => {
        const event = data as Record<string, unknown>;
        if (event.message === "log without metadata") {
          logEvent = event;
        }
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Log event was emitted without error
      expect(logEvent).not.toBeNull();
      expect(logEvent?.message).toBe("log without metadata");
    });

    it("should handle complex nested metadata", async () => {
      // Given: A stage that logs with deeply nested metadata
      const stage = defineStage({
        id: "nested-metadata-stage",
        name: "Nested Metadata Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("INFO", "log with nested metadata", {
            user: {
              id: "user-123",
              name: "Test User",
            },
            operation: {
              type: "processing",
              status: "in-progress",
              metrics: {
                duration: 100,
                itemCount: 50,
              },
            },
            tags: ["important", "automated"],
          });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "nested-metadata-test",
        "Nested Metadata Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-log-9", "nested-metadata-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-9",
        "nested-metadata-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events
      let logEvent: Record<string, unknown> | null = null;
      executor.on("log", (data) => {
        const event = data as Record<string, unknown>;
        if (event.message === "log with nested metadata") {
          logEvent = event;
        }
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Nested metadata is preserved
      expect(logEvent).not.toBeNull();
      const meta = logEvent?.meta as Record<string, unknown>;
      expect(meta?.user).toEqual({ id: "user-123", name: "Test User" });
      expect(meta?.operation).toEqual({
        type: "processing",
        status: "in-progress",
        metrics: { duration: 100, itemCount: 50 },
      });
      expect(meta?.tags).toEqual(["important", "automated"]);
    });

    it("should include error code in ERROR level logs", async () => {
      // Given: A stage that logs an error with error code
      const stage = defineStage({
        id: "error-code-stage",
        name: "Error Code Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("ERROR", "operation failed", {
            errorCode: 500,
            errorType: "InternalError",
            details: "Database connection failed",
          });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "error-code-test",
        "Error Code Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-log-10", "error-code-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-10",
        "error-code-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events
      let logEvent: Record<string, unknown> | null = null;
      executor.on("log", (data) => {
        const event = data as Record<string, unknown>;
        if (event.message === "operation failed") {
          logEvent = event;
        }
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Error metadata is included
      expect(logEvent).not.toBeNull();
      expect(logEvent?.level).toBe("ERROR");
      const meta = logEvent?.meta as Record<string, unknown>;
      expect(meta?.errorCode).toBe(500);
      expect(meta?.errorType).toBe("InternalError");
      expect(meta?.details).toBe("Database connection failed");
    });
  });

  describe("multiple logs from stages", () => {
    it("should emit multiple logs from a single stage", async () => {
      // Given: A stage that logs multiple messages
      const stage = defineStage({
        id: "multi-log-stage",
        name: "Multi Log Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("INFO", "starting processing");
          ctx.onLog("DEBUG", "item 1 processed");
          ctx.onLog("DEBUG", "item 2 processed");
          ctx.onLog("INFO", "finished processing");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-log-test",
        "Multi Log Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-log-11", "multi-log-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-11",
        "multi-log-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events with specific messages we're looking for
      const stageLogMessages = [
        "starting processing",
        "item 1 processed",
        "item 2 processed",
        "finished processing",
      ];
      const logEvents: Array<{ message: string; level: string }> = [];
      executor.on("log", (data) => {
        const event = data as { message: string; level: string };
        if (stageLogMessages.includes(event.message)) {
          logEvents.push({ message: event.message, level: event.level });
        }
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: All our logs were emitted
      expect(logEvents).toHaveLength(4);
      expect(logEvents.map((e) => e.message)).toEqual([
        "starting processing",
        "item 1 processed",
        "item 2 processed",
        "finished processing",
      ]);
    });

    it("should track logs across multiple stages", async () => {
      // Given: Multiple stages that each log with identifiable messages
      const stageA = defineStage({
        id: "log-stage-a",
        name: "Log Stage A",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("INFO", "stage A log");
          return { output: ctx.input };
        },
      });

      const stageB = defineStage({
        id: "log-stage-b",
        name: "Log Stage B",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("INFO", "stage B log");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-stage-log-test",
        "Multi Stage Log Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      await createRun("run-log-12", "multi-stage-log-test", { value: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-log-12",
        "multi-stage-log-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect log events for specific messages
      const logMessages: string[] = [];
      executor.on("log", (data) => {
        const event = data as { message: string };
        if (
          event.message === "stage A log" ||
          event.message === "stage B log"
        ) {
          logMessages.push(event.message);
        }
      });

      // When: Execute
      await executor.execute({ value: "test" }, {});

      // Then: Both stages emitted their logs
      expect(logMessages).toContain("stage A log");
      expect(logMessages).toContain("stage B log");
      expect(logMessages).toHaveLength(2);
    });
  });
});
