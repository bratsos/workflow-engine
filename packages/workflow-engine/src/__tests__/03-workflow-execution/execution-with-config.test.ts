/**
 * Workflow Execution with Configuration Tests (Kernel)
 *
 * Tests for passing configuration to stages during workflow execution
 * via kernel dispatch.
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

describe("I want to execute workflows with configuration", () => {
  describe("passing config to stages", () => {
    it("should pass config to each stage", async () => {
      // Given: A workflow with multiple stages that use config
      const capturedConfigs: Record<string, unknown> = {};

      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ value: z.number() }),
          config: z.object({
            multiplier: z.number(),
          }),
        },
        async execute(ctx) {
          capturedConfigs["stage-a"] = ctx.config;
          return { output: { value: ctx.input.value * ctx.config.multiplier } };
        },
      });

      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ value: z.number() }),
          config: z.object({
            offset: z.number(),
          }),
        },
        async execute(ctx) {
          capturedConfigs["stage-b"] = ctx.config;
          return { output: { value: ctx.input.value + ctx.config.offset } };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-config",
        "Multi Config Workflow",
        "Test",
        z.object({ value: z.number() }),
        z.object({ value: z.number() }),
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      const config = {
        "stage-a": { multiplier: 3 },
        "stage-b": { offset: 5 },
      };

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "multi-config",
        input: { value: 10 },
        config,
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute stage-a: 10 * 3 = 30
      const rA = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "multi-config",
        stageId: "stage-a",
        config,
      });
      expect(rA.outcome).toBe("completed");
      expect(rA.output).toEqual({ value: 30 });

      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute stage-b: 30 + 5 = 35
      const rB = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "multi-config",
        stageId: "stage-b",
        config,
      });
      expect(rB.outcome).toBe("completed");
      expect(rB.output).toEqual({ value: 35 });

      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Each stage received its config
      expect(capturedConfigs["stage-a"]).toEqual({ multiplier: 3 });
      expect(capturedConfigs["stage-b"]).toEqual({ offset: 5 });
    });
  });

  describe("merging defaults with provided config", () => {
    it("should merge defaults with provided config", async () => {
      // Given: A stage with default config values
      let capturedConfig: { multiplier: number; addend: number } | null = null;

      const configuredStage = defineStage({
        id: "with-defaults",
        name: "With Defaults Stage",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ value: z.number() }),
          config: z.object({
            multiplier: z.number().default(2),
            addend: z.number().default(0),
          }),
        },
        async execute(ctx) {
          capturedConfig = ctx.config as { multiplier: number; addend: number };
          return {
            output: {
              value:
                ctx.input.value * ctx.config.multiplier + ctx.config.addend,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "defaults-test",
        "Defaults Test Workflow",
        "Test",
        z.object({ value: z.number() }),
        z.object({ value: z.number() }),
      )
        .pipe(configuredStage)
        .build();

      const config = { "with-defaults": { addend: 10 } };

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "defaults-test",
        input: { value: 5 },
        config,
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "defaults-test",
        stageId: "with-defaults",
        config,
      });

      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Default multiplier is used, provided addend is applied
      expect(capturedConfig).toEqual({ multiplier: 2, addend: 10 });
      expect(result.outcome).toBe("completed");
      // Result: 5 * 2 + 10 = 20
      expect(result.output).toEqual({ value: 20 });
    });

    it("should use all defaults when no config provided", async () => {
      // Given: A stage with default config values
      let capturedConfig: { multiplier: number; addend: number } | null = null;

      const configuredStage = defineStage({
        id: "all-defaults",
        name: "All Defaults Stage",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ value: z.number() }),
          config: z.object({
            multiplier: z.number().default(3),
            addend: z.number().default(1),
          }),
        },
        async execute(ctx) {
          capturedConfig = ctx.config as { multiplier: number; addend: number };
          return {
            output: {
              value:
                ctx.input.value * ctx.config.multiplier + ctx.config.addend,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "all-defaults-test",
        "All Defaults Test Workflow",
        "Test",
        z.object({ value: z.number() }),
        z.object({ value: z.number() }),
      )
        .pipe(configuredStage)
        .build();

      const config = { "all-defaults": {} };

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "all-defaults-test",
        input: { value: 4 },
        config,
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "all-defaults-test",
        stageId: "all-defaults",
        config,
      });

      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: All defaults are applied
      expect(capturedConfig).toEqual({ multiplier: 3, addend: 1 });
      expect(result.outcome).toBe("completed");
      // Result: 4 * 3 + 1 = 13
      expect(result.output).toEqual({ value: 13 });
    });
  });

  describe("overriding defaults", () => {
    it("should override defaults with provided values", async () => {
      // Given: A stage with default config values
      let capturedConfig: { multiplier: number; addend: number } | null = null;

      const configuredStage = defineStage({
        id: "override-stage",
        name: "Override Stage",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ value: z.number() }),
          config: z.object({
            multiplier: z.number().default(2),
            addend: z.number().default(0),
          }),
        },
        async execute(ctx) {
          capturedConfig = ctx.config as { multiplier: number; addend: number };
          return {
            output: {
              value:
                ctx.input.value * ctx.config.multiplier + ctx.config.addend,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "override-test",
        "Override Test Workflow",
        "Test",
        z.object({ value: z.number() }),
        z.object({ value: z.number() }),
      )
        .pipe(configuredStage)
        .build();

      const config = { "override-stage": { multiplier: 10, addend: 100 } };

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "override-test",
        input: { value: 6 },
        config,
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "override-test",
        stageId: "override-stage",
        config,
      });

      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Provided values override defaults
      expect(capturedConfig).toEqual({ multiplier: 10, addend: 100 });
      expect(result.outcome).toBe("completed");
      // Result: 6 * 10 + 100 = 160
      expect(result.output).toEqual({ value: 160 });
    });
  });

  describe("input validation", () => {
    it("should reject invalid input", async () => {
      // Given: A stage with strict input validation
      const strictStage = defineStage({
        id: "strict-input",
        name: "Strict Input Stage",
        schemas: {
          input: z.object({
            name: z.string().min(1),
            count: z.number().positive(),
          }),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: { result: `${ctx.input.name}: ${ctx.input.count}` },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "input-validation-test",
        "Input Validation Test",
        "Test",
        z.object({
          name: z.string().min(1),
          count: z.number().positive(),
        }),
        z.object({ result: z.string() }),
      )
        .pipe(strictStage)
        .build();

      const { kernel, persistence } = createTestKernel([workflow]);

      // Create run manually with invalid input (bypass run.create validation)
      const run = await persistence.createRun({
        workflowId: "input-validation-test",
        workflowName: "Input Validation Test",
        workflowType: "input-validation-test",
        input: { name: "", count: -1 }, // Invalid input
      });
      await persistence.updateRun(run.id, { status: "RUNNING" });

      // When/Then: Execution with invalid input should return failed
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: run.id,
        workflowId: "input-validation-test",
        stageId: "strict-input",
        config: {},
      });

      expect(result.outcome).toBe("failed");
    });

    it("should reject input with missing required fields", async () => {
      // Given: A stage that requires specific input fields
      const requiredFieldsStage = defineStage({
        id: "required-fields",
        name: "Required Fields Stage",
        schemas: {
          input: z.object({
            id: z.string(),
            data: z.object({
              type: z.string(),
              payload: z.unknown(),
            }),
          }),
          output: z.object({ processed: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { processed: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "required-fields-test",
        "Required Fields Test",
        "Test",
        z.object({
          id: z.string(),
          data: z.object({
            type: z.string(),
            payload: z.unknown(),
          }),
        }),
        z.object({ processed: z.boolean() }),
      )
        .pipe(requiredFieldsStage)
        .build();

      const { kernel, persistence } = createTestKernel([workflow]);

      // Create run manually with missing field
      const run = await persistence.createRun({
        workflowId: "required-fields-test",
        workflowName: "Required Fields Test",
        workflowType: "required-fields-test",
        input: { id: "test-id" }, // Missing data field
      });
      await persistence.updateRun(run.id, { status: "RUNNING" });

      // When/Then: Execution with missing required fields should return failed
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: run.id,
        workflowId: "required-fields-test",
        stageId: "required-fields",
        config: {},
      });

      expect(result.outcome).toBe("failed");
    });
  });

  describe("config validation", () => {
    it("should reject invalid config types at run creation", async () => {
      // Given: A stage with strict config validation
      const strictConfigStage = defineStage({
        id: "strict-config",
        name: "Strict Config Stage",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({
            model: z.string().min(1),
            temperature: z.number().min(0).max(2),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "config-validation-test",
        "Config Validation Test",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(strictConfigStage)
        .build();

      const { kernel } = createTestKernel([workflow]);

      // When/Then: Kernel validates config at run.create time and rejects wrong types
      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-1",
          workflowId: "config-validation-test",
          input: { value: "test" },
          config: { "strict-config": { model: 123, temperature: "hot" } },
        }),
      ).rejects.toThrow(/invalid workflow config/i);
    });

    it("should reject config with out-of-range values at run creation", async () => {
      // Given: A stage with numeric constraints on config
      const rangeConfigStage = defineStage({
        id: "range-config",
        name: "Range Config Stage",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({
            maxRetries: z.number().int().min(0).max(10),
            timeout: z.number().positive(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "range-config-test",
        "Range Config Test",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(rangeConfigStage)
        .build();

      const { kernel } = createTestKernel([workflow]);

      // When/Then: Kernel validates config at run.create time and rejects out-of-range values
      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-1",
          workflowId: "range-config-test",
          input: { value: "test" },
          config: { "range-config": { maxRetries: 100, timeout: -5 } },
        }),
      ).rejects.toThrow(/invalid workflow config/i);
    });

    it("should reject config with missing required fields at run creation", async () => {
      // Given: A stage requiring specific config fields (no defaults)
      const requiredConfigStage = defineStage({
        id: "required-config",
        name: "Required Config Stage",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({
            apiKey: z.string(),
            endpoint: z.string().url(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "required-config-test",
        "Required Config Test",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(requiredConfigStage)
        .build();

      const { kernel } = createTestKernel([workflow]);

      // When/Then: Kernel validates config at run.create time and rejects missing fields
      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-1",
          workflowId: "required-config-test",
          input: { value: "test" },
          config: { "required-config": { apiKey: "key-123" } },
        }),
      ).rejects.toThrow(/invalid workflow config/i);
    });
  });
});
