/**
 * Stage Context Tests (Kernel)
 *
 * Tests for the EnhancedStageContext provided to stage execute functions.
 * Covers basic properties, input/config access, workflowContext helpers,
 * progress reporting, logging, and storage access.
 *
 * All tests use kernel dispatch (run.create + job.execute) instead of
 * the old WorkflowExecutor.
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

/** Helper: create run, mark RUNNING, execute stage, return result */
async function runSingleStageWorkflow(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  persistence: InMemoryWorkflowPersistence,
  flush: () => Promise<any>,
  workflowId: string,
  input: Record<string, unknown>,
  config: Record<string, unknown> = {},
) {
  const createResult = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: `key-${Date.now()}-${Math.random()}`,
    workflowId,
    input,
    config,
  });
  await persistence.updateRun(createResult.workflowRunId, {
    status: "RUNNING",
  });
  await flush();
  return createResult;
}

describe("I want to use stage context", () => {
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

      const workflow = new WorkflowBuilder(
        "run-id-test",
        "Test",
        "Test",
        z.object({}),
        z.object({ runId: z.string() }),
      )
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute with kernel dispatch
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "run-id-test",
        {},
      );

      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "run-id-test",
        stageId: "capture-run-id",
        config: {},
      });

      // Then: Stage received the correct run ID
      expect(result.outcome).toBe("completed");
      expect(capturedRunId).toBe(createResult.workflowRunId);
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

      const workflow = new WorkflowBuilder(
        "identity-test",
        "Test",
        "Test",
        z.object({}),
        z.object({}),
      )
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "identity-test",
        {},
      );
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "identity-test",
        stageId: "my-special-stage",
        config: {},
      });

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

      const workflow = new WorkflowBuilder(
        "number-test",
        "Test",
        "Test",
        z.any(),
        z.any(),
      )
        .pipe(createStage("first"))
        .pipe(createStage("second"))
        .pipe(createStage("third"))
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute all stages in order via kernel
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "number-test",
        {},
      );
      const runId = createResult.workflowRunId;

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "number-test",
        stageId: "first",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "number-test",
        stageId: "second",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "number-test",
        stageId: "third",
        config: {},
      });

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

      const inputSchema = z.object({
        name: z.string(),
        count: z.number(),
        active: z.boolean(),
      });
      const workflow = new WorkflowBuilder(
        "input-test",
        "Test",
        "Test",
        inputSchema,
        z.object({ received: z.boolean() }),
      )
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute with matching input
      const input = { name: "test", count: 42, active: true };
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "input-test",
        input,
      );
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "input-test",
        stageId: "typed-input",
        config: {},
      });

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

      const workflow = new WorkflowBuilder(
        "config-test",
        "Test",
        "Test",
        z.object({}),
        z.object({}),
      )
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute with config
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "config-test",
        {},
        {
          "typed-config": { model: "gpt-4", temperature: 0.7 },
        },
      );
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "config-test",
        stageId: "typed-config",
        config: { "typed-config": { model: "gpt-4", temperature: 0.7 } },
      });

      // Then: Config is available with parsed values
      expect(capturedConfig).toMatchObject({
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

      const workflow = new WorkflowBuilder(
        "defaults-test",
        "Test",
        "Test",
        z.object({}),
        z.object({}),
      )
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute without config
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "defaults-test",
        {},
      );
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "defaults-test",
        stageId: "defaults",
        config: {},
      });

      // Then: Config defaults are applied via zod parsing
      expect(capturedConfig).toEqual({
        maxRetries: 3,
        timeout: 5000,
        debug: false,
      });
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

      const workflow = new WorkflowBuilder(
        "require-test",
        "Test",
        "Test",
        z.object({}),
        z.object({ processed: z.string() }),
      )
        .pipe(extractStage)
        .pipe(processStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute both stages in order
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "require-test",
        {},
      );
      const runId = createResult.workflowRunId;

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "require-test",
        stageId: "extract",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "require-test",
        stageId: "process",
        config: {},
      });

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

      const workflow = new WorkflowBuilder(
        "require-missing",
        "Test",
        "Test",
        z.object({}),
        z.object({}),
      )
        .pipe(badStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "require-missing",
        {},
      );
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "require-missing",
        stageId: "bad",
        config: {},
      });

      // Then: Execution fails with missing stage error
      expect(result.outcome).toBe("failed");
      expect(result.error).toMatch(/Missing required stage/);
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

      const workflow = new WorkflowBuilder(
        "optional-missing",
        "Test",
        "Test",
        z.object({}),
        z.object({ found: z.boolean() }),
      )
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "optional-missing",
        {},
      );
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "optional-missing",
        stageId: "optional-test",
        config: {},
      });

      // Then: No throw, returned undefined
      expect(result.outcome).toBe("completed");
      expect(optionalResult).toBeUndefined();
      expect(result.output).toEqual({ found: false });
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

      const workflow = new WorkflowBuilder(
        "optional-exists",
        "Test",
        "Test",
        z.object({}),
        z.object({ value: z.string() }),
      )
        .pipe(optionalStage)
        .pipe(checkStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute both stages in order
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "optional-exists",
        {},
      );
      const runId = createResult.workflowRunId;

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "optional-exists",
        stageId: "optional-source",
        config: {},
      });
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "optional-exists",
        stageId: "check",
        config: {},
      });

      // Then: ctx.optional returned the data
      expect(optionalResult).toEqual({ optional: "exists" });
      expect(result.output).toEqual({ value: "exists" });
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

      const workflow = new WorkflowBuilder(
        "storage-test",
        "Test",
        "Test",
        z.object({}),
        z.object({}),
      )
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "storage-test",
        {},
      );
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "storage-test",
        stageId: "storage-stage",
        config: {},
      });

      // Then: Storage was available
      expect(hasStorage).toBe(true);
    });
  });

  describe("progress reporting", () => {
    it("should emit progress events via event sink", async () => {
      // Given: A stage that reports progress
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

      const workflow = new WorkflowBuilder(
        "progress-test",
        "Test",
        "Test",
        z.object({}),
        z.object({}),
      )
        .pipe(stage)
        .build();

      const { kernel, flush, persistence, eventSink } = createTestKernel([
        workflow,
      ]);

      // When: Execute
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "progress-test",
        {},
      );
      eventSink.clear();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "progress-test",
        stageId: "progress-stage",
        config: {},
      });

      // Then: Progress event was captured in outbox events
      // Progress events are written to the outbox by the kernel
      await flush();
      const progressEvents = eventSink.getByType("stage:progress");
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0]).toMatchObject({
        progress: 50,
        message: "halfway",
      });
    });
  });

  describe("logging", () => {
    it("should persist log entries at different levels", async () => {
      // Given: A stage that logs at various levels
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

      const workflow = new WorkflowBuilder(
        "logging-test",
        "Test",
        "Test",
        z.object({}),
        z.object({}),
      )
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const createResult = await runSingleStageWorkflow(
        kernel,
        persistence,
        flush,
        "logging-test",
        {},
      );
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "logging-test",
        stageId: "logging-stage",
        config: {},
      });

      // Then: Stage completed successfully (logs are persisted asynchronously)
      expect(result.outcome).toBe("completed");
    });
  });
});
