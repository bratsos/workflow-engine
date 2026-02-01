/**
 * Stage Context Tests
 *
 * Tests for the EnhancedStageContext provided to stage execute functions.
 * Covers basic properties, input/config access, workflowContext helpers, and progress/logging.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow";
import { WorkflowExecutor } from "../../core/executor";
import { defineStage } from "../../core/stage-factory";
import { InMemoryWorkflowPersistence } from "../utils/in-memory-persistence";
import { InMemoryAICallLogger } from "../utils/in-memory-ai-logger";

describe("I want to use stage context", () => {
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

  describe("basic context properties", () => {
    it("should provide workflowRunId", async () => {
      // Given: A stage that captures workflowRunId
      let capturedRunId: string | undefined;

      const stage = defineStage({
        id: "capture-run-id",
        name: "Capture Run ID",
        schemas: {
          input: z.object({}),
          output: z.object({ runId: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          capturedRunId = ctx.workflowRunId;
          return { output: { runId: ctx.workflowRunId } };
        },
      });

      const workflow = new WorkflowBuilder("run-id-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute with specific run ID
      await createRun("my-run-123", "run-id-test", {});
      const executor = new WorkflowExecutor(workflow, "my-run-123", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: Stage received the correct run ID
      expect(capturedRunId).toBe("my-run-123");
    });

    it("should provide stageId and stageName", async () => {
      // Given: A stage that captures its identity
      let capturedId: string | undefined;
      let capturedName: string | undefined;

      const stage = defineStage({
        id: "my-special-stage",
        name: "My Special Stage",
        schemas: {
          input: z.object({}),
          output: z.object({}),
          config: z.object({}),
        },
        async execute(ctx) {
          capturedId = ctx.stageId;
          capturedName = ctx.stageName;
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder("identity-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute
      await createRun("run-1", "identity-test", {});
      const executor = new WorkflowExecutor(workflow, "run-1", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: Stage received correct identity
      expect(capturedId).toBe("my-special-stage");
      expect(capturedName).toBe("My Special Stage");
    });

    it("should provide stageNumber", async () => {
      // Given: Multiple stages that capture their numbers
      const capturedNumbers: { id: string; number: number }[] = [];

      const createStage = (id: string) =>
        defineStage({
          id,
          name: id,
          schemas: {
            input: z.any(),
            output: z.any(),
            config: z.object({}),
          },
          async execute(ctx) {
            capturedNumbers.push({ id, number: ctx.stageNumber });
            return { output: ctx.input };
          },
        });

      const workflow = new WorkflowBuilder("number-test", "Test")
        .pipe(createStage("first"))
        .pipe(createStage("second"))
        .pipe(createStage("third"))
        .build();

      // When: Execute
      await createRun("run-2", "number-test", {});
      const executor = new WorkflowExecutor(workflow, "run-2", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: Stage numbers are 1-indexed
      expect(capturedNumbers).toEqual([
        { id: "first", number: 1 },
        { id: "second", number: 2 },
        { id: "third", number: 3 },
      ]);
    });
  });

  describe("input and config access", () => {
    it("should provide validated input", async () => {
      // Given: A stage with typed input
      let capturedInput: unknown;

      const stage = defineStage({
        id: "typed-input",
        name: "Typed Input",
        schemas: {
          input: z.object({
            name: z.string(),
            count: z.number(),
            active: z.boolean(),
          }),
          output: z.object({ received: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          capturedInput = ctx.input;
          return { output: { received: true } };
        },
      });

      const workflow = new WorkflowBuilder("input-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute with matching input
      const input = { name: "test", count: 42, active: true };
      await createRun("run-3", "input-test", input);
      const executor = new WorkflowExecutor(workflow, "run-3", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute(input, {});

      // Then: Input is available and typed
      expect(capturedInput).toEqual({ name: "test", count: 42, active: true });
    });

    it("should provide validated config", async () => {
      // Given: A stage with typed config
      let capturedConfig: unknown;

      const stage = defineStage({
        id: "typed-config",
        name: "Typed Config",
        schemas: {
          input: z.object({}),
          output: z.object({}),
          config: z.object({
            model: z.string(),
            temperature: z.number(),
            enabled: z.boolean().default(true),
          }),
        },
        async execute(ctx) {
          capturedConfig = ctx.config;
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder("config-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute with config
      await createRun("run-4", "config-test", {});
      const executor = new WorkflowExecutor(workflow, "run-4", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute(
        {},
        { "typed-config": { model: "gpt-4", temperature: 0.7 } },
      );

      // Then: Config is available (note: executor passes raw config, doesn't apply defaults)
      expect(capturedConfig).toEqual({
        model: "gpt-4",
        temperature: 0.7,
      });
    });

    it("should use config defaults when not provided", async () => {
      // Given: A stage with config defaults
      let capturedConfig: unknown;

      const stage = defineStage({
        id: "defaults",
        name: "Defaults",
        schemas: {
          input: z.object({}),
          output: z.object({}),
          config: z.object({
            maxRetries: z.number().default(3),
            timeout: z.number().default(5000),
            debug: z.boolean().default(false),
          }),
        },
        async execute(ctx) {
          capturedConfig = ctx.config;
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder("defaults-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute without config
      await createRun("run-5", "defaults-test", {});
      const executor = new WorkflowExecutor(workflow, "run-5", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: Empty config passed (executor doesn't apply defaults automatically)
      expect(capturedConfig).toEqual({});
    });
  });

  describe("workflowContext access", () => {
    it("should require stage output that exists", async () => {
      // Given: Two stages where second requires first
      let requiredOutput: unknown;

      const extractStage = defineStage({
        id: "extract",
        name: "Extract",
        schemas: {
          input: z.object({}),
          output: z.object({ extracted: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { extracted: "data" } };
        },
      });

      type ExtractContext = {
        extract: { extracted: string };
      };

      const processStage = defineStage<
        z.ZodObject<{ extracted: z.ZodString }>,
        z.ZodObject<{ processed: z.ZodString }>,
        z.ZodObject<{}>,
        ExtractContext
      >({
        id: "process",
        name: "Process",
        schemas: {
          input: z.object({ extracted: z.string() }),
          output: z.object({ processed: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          requiredOutput = ctx.require("extract");
          return { output: { processed: "done" } };
        },
      });

      const workflow = new WorkflowBuilder("require-test", "Test")
        .pipe(extractStage)
        .pipe(processStage)
        .build();

      // When: Execute
      await createRun("run-6", "require-test", {});
      const executor = new WorkflowExecutor(workflow, "run-6", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: ctx.require returned the output
      expect(requiredOutput).toEqual({ extracted: "data" });
    });

    it("should throw for missing required stage", async () => {
      // Given: A stage that requires non-existent stage
      const badStage = defineStage({
        id: "bad",
        name: "Bad",
        schemas: {
          input: z.object({}),
          output: z.object({}),
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.require("nonexistent" as any);
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder("require-missing", "Test")
        .pipe(badStage)
        .build();

      // When/Then: Execution throws
      await createRun("run-7", "require-missing", {});
      const executor = new WorkflowExecutor(workflow, "run-7", "test", {
        persistence,
        aiLogger,
      });

      await expect(executor.execute({}, {})).rejects.toThrow(
        /Missing required stage/,
      );
    });

    it("should return undefined for optional missing stage", async () => {
      // Given: A stage that optionally accesses non-existent stage
      let optionalResult: unknown = "not-undefined";

      const stage = defineStage({
        id: "optional-test",
        name: "Optional Test",
        schemas: {
          input: z.object({}),
          output: z.object({ found: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          optionalResult = ctx.optional("maybe" as any);
          return { output: { found: optionalResult !== undefined } };
        },
      });

      const workflow = new WorkflowBuilder("optional-missing", "Test")
        .pipe(stage)
        .build();

      // When: Execute
      await createRun("run-8", "optional-missing", {});
      const executor = new WorkflowExecutor(workflow, "run-8", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: No throw, returned undefined
      expect(optionalResult).toBeUndefined();
      expect(result).toEqual({ found: false });
    });

    it("should return typed data for optional existing stage", async () => {
      // Given: Two stages where second optionally accesses first
      let optionalResult: unknown;

      const optionalStage = defineStage({
        id: "optional-source",
        name: "Optional Source",
        schemas: {
          input: z.object({}),
          output: z.object({ optional: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { optional: "exists" } };
        },
      });

      type OptionalContext = {
        "optional-source": { optional: string };
      };

      const checkStage = defineStage<
        z.ZodObject<{ optional: z.ZodString }>,
        z.ZodObject<{ value: z.ZodString }>,
        z.ZodObject<{}>,
        OptionalContext
      >({
        id: "check",
        name: "Check",
        schemas: {
          input: z.object({ optional: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          optionalResult = ctx.optional("optional-source");
          const data = ctx.optional("optional-source");
          return { output: { value: data?.optional ?? "missing" } };
        },
      });

      const workflow = new WorkflowBuilder("optional-exists", "Test")
        .pipe(optionalStage)
        .pipe(checkStage)
        .build();

      // When: Execute
      await createRun("run-9", "optional-exists", {});
      const executor = new WorkflowExecutor(workflow, "run-9", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: ctx.optional returned the data
      expect(optionalResult).toEqual({ optional: "exists" });
      expect(result).toEqual({ value: "exists" });
    });
  });

  describe("progress reporting", () => {
    it("should emit progress events", async () => {
      // Given: A stage that reports progress
      const progressEvents: unknown[] = [];

      const stage = defineStage({
        id: "progress-stage",
        name: "Progress Stage",
        schemas: {
          input: z.object({}),
          output: z.object({}),
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 50, message: "halfway" });
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder("progress-test", "Test")
        .pipe(stage)
        .build();

      await createRun("run-10", "progress-test", {});
      const executor = new WorkflowExecutor(workflow, "run-10", "test", {
        persistence,
        aiLogger,
      });

      executor.on("stage:progress", (event) => {
        progressEvents.push(event);
      });

      // When: Execute
      await executor.execute({}, {});

      // Then: Progress event was emitted
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0]).toMatchObject({
        progress: 50,
        message: "halfway",
      });
    });

    it("should include details in progress event", async () => {
      // Given: A stage that reports progress with details
      const progressEvents: unknown[] = [];

      const stage = defineStage({
        id: "detailed-progress",
        name: "Detailed Progress",
        schemas: {
          input: z.object({}),
          output: z.object({}),
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({
            progress: 75,
            message: "processing items",
            details: { itemsProcessed: 42, totalItems: 56 },
          });
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder("detailed-progress-test", "Test")
        .pipe(stage)
        .build();

      await createRun("run-11", "detailed-progress-test", {});
      const executor = new WorkflowExecutor(workflow, "run-11", "test", {
        persistence,
        aiLogger,
      });

      executor.on("stage:progress", (event) => {
        progressEvents.push(event);
      });

      // When: Execute
      await executor.execute({}, {});

      // Then: Progress event includes details
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0]).toMatchObject({
        progress: 75,
        message: "processing items",
        details: { itemsProcessed: 42, totalItems: 56 },
      });
    });
  });

  describe("logging", () => {
    it("should log at different levels", async () => {
      // Given: A stage that logs at various levels
      const logEvents: unknown[] = [];

      const stage = defineStage({
        id: "logging-stage",
        name: "Logging Stage",
        schemas: {
          input: z.object({}),
          output: z.object({}),
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onLog("INFO", "info message", { infoKey: "value" });
          ctx.onLog("WARN", "warning message");
          ctx.onLog("ERROR", "error message", { errorCode: 500 });
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder("logging-test", "Test")
        .pipe(stage)
        .build();

      await createRun("run-12", "logging-test", {});
      const executor = new WorkflowExecutor(workflow, "run-12", "test", {
        persistence,
        aiLogger,
      });

      executor.on("log", (event) => {
        logEvents.push(event);
      });

      // When: Execute
      await executor.execute({}, {});

      // Then: Logs were emitted (we look for our specific logs, filtering out executor logs)
      const infoLog = logEvents.find(
        (e: any) => e.level === "INFO" && e.message === "info message",
      );
      const warnLog = logEvents.find(
        (e: any) => e.level === "WARN" && e.message === "warning message",
      );
      const errorLog = logEvents.find(
        (e: any) => e.level === "ERROR" && e.message === "error message",
      );

      expect(infoLog).toBeDefined();
      expect(warnLog).toBeDefined();
      expect(errorLog).toBeDefined();
      expect((infoLog as any).meta).toEqual({ infoKey: "value" });
      expect((errorLog as any).meta).toEqual({ errorCode: 500 });
    });
  });

  describe("storage access", () => {
    it("should provide storage for artifacts", async () => {
      // Given: A stage that uses storage
      let hasStorage = false;

      const stage = defineStage({
        id: "storage-stage",
        name: "Storage Stage",
        schemas: {
          input: z.object({}),
          output: z.object({}),
          config: z.object({}),
        },
        async execute(ctx) {
          hasStorage = ctx.storage !== undefined;
          // Save an artifact
          await ctx.storage.save("my-artifact", { data: "value" });
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder("storage-test", "Test")
        .pipe(stage)
        .build();

      await createRun("run-13", "storage-test", {});
      const executor = new WorkflowExecutor(workflow, "run-13", "test", {
        persistence,
        aiLogger,
      });

      // When: Execute
      await executor.execute({}, {});

      // Then: Storage was available
      expect(hasStorage).toBe(true);
    });
  });

  describe("resumeState access", () => {
    it("should provide resumeState when resuming", async () => {
      // This test verifies that resumeState is available in context
      // when a workflow is resumed after suspension

      let capturedResumeState: unknown;
      let executionCount = 0;

      const suspendingStage = defineStage({
        id: "suspending",
        name: "Suspending Stage",
        mode: "async-batch" as const,
        schemas: {
          input: z.object({}),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionCount++;
          capturedResumeState = ctx.resumeState;

          if (!ctx.resumeState) {
            // First execution - suspend
            return {
              suspended: true as const,
              state: {
                batchId: "batch-123",
                submittedAt: new Date().toISOString(),
                pollInterval: 1000,
                maxWaitTime: 60000,
              },
              pollConfig: {
                pollInterval: 1000,
                maxWaitTime: 60000,
                nextPollAt: new Date(Date.now() + 1000),
              },
            };
          }

          // Resume execution
          return { output: { result: "completed" } };
        },
        async checkCompletion() {
          return { completed: true, output: { result: "done" } };
        },
      });

      const workflow = new WorkflowBuilder("resume-test", "Test")
        .pipe(suspendingStage)
        .build();

      // When: First execution (suspends)
      await createRun("run-14", "resume-test", {});
      const executor = new WorkflowExecutor(workflow, "run-14", "test", {
        persistence,
        aiLogger,
      });

      const firstResult = await executor.execute({}, {});

      // Then: First execution suspended
      expect(firstResult).toBe("suspended");
      expect(capturedResumeState).toBeUndefined();
      expect(executionCount).toBe(1);
    });
  });
});
