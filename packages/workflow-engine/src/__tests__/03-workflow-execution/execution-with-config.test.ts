/**
 * Workflow Execution with Configuration Tests
 *
 * Tests for passing configuration to stages during workflow execution.
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

describe("I want to execute workflows with configuration", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  describe("passing config to stages", () => {
    it("should pass config to each stage", async () => {
      // Given: A workflow with multiple stages that use config
      const capturedConfigs: Record<string, unknown> = {};

      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: TestSchemas.number,
          output: TestSchemas.number,
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
          input: TestSchemas.number,
          output: TestSchemas.number,
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
        TestSchemas.number,
        TestSchemas.number,
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      await persistence.createRun({
        id: "run-multi-config",
        workflowId: "multi-config",
        workflowName: "Multi Config Workflow",
        status: "PENDING",
        input: { value: 10 },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-multi-config",
        "multi-config",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with config for each stage
      const result = await executor.execute(
        { value: 10 },
        {
          "stage-a": { multiplier: 3 },
          "stage-b": { offset: 5 },
        },
      );

      // Then: Each stage received its config
      expect(capturedConfigs["stage-a"]).toEqual({ multiplier: 3 });
      expect(capturedConfigs["stage-b"]).toEqual({ offset: 5 });

      // And: Result is correctly computed (10 * 3 = 30, 30 + 5 = 35)
      expect(result).toEqual({ value: 35 });
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
          input: TestSchemas.number,
          output: TestSchemas.number,
          config: z.object({
            multiplier: z.number().default(2),
            addend: z.number().default(0),
          }),
        },
        async execute(ctx) {
          // Parse config through schema to apply defaults
          const parsedConfig = configuredStage.configSchema.parse(ctx.config);
          capturedConfig = parsedConfig;
          return {
            output: {
              value:
                ctx.input.value * parsedConfig.multiplier + parsedConfig.addend,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "defaults-test",
        "Defaults Test Workflow",
        "Test",
        TestSchemas.number,
        TestSchemas.number,
      )
        .pipe(configuredStage)
        .build();

      await persistence.createRun({
        id: "run-defaults",
        workflowId: "defaults-test",
        workflowName: "Defaults Test Workflow",
        status: "PENDING",
        input: { value: 5 },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-defaults",
        "defaults-test",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with partial config (only addend provided)
      const result = await executor.execute(
        { value: 5 },
        { "with-defaults": { addend: 10 } },
      );

      // Then: Default multiplier is used, provided addend is applied
      expect(capturedConfig).toEqual({ multiplier: 2, addend: 10 });
      // Result: 5 * 2 + 10 = 20
      expect(result).toEqual({ value: 20 });
    });

    it("should use all defaults when no config provided", async () => {
      // Given: A stage with default config values
      let capturedConfig: { multiplier: number; addend: number } | null = null;

      const configuredStage = defineStage({
        id: "all-defaults",
        name: "All Defaults Stage",
        schemas: {
          input: TestSchemas.number,
          output: TestSchemas.number,
          config: z.object({
            multiplier: z.number().default(3),
            addend: z.number().default(1),
          }),
        },
        async execute(ctx) {
          // Parse config through schema to apply defaults
          const parsedConfig = configuredStage.configSchema.parse(ctx.config);
          capturedConfig = parsedConfig;
          return {
            output: {
              value:
                ctx.input.value * parsedConfig.multiplier + parsedConfig.addend,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "all-defaults-test",
        "All Defaults Test Workflow",
        "Test",
        TestSchemas.number,
        TestSchemas.number,
      )
        .pipe(configuredStage)
        .build();

      await persistence.createRun({
        id: "run-all-defaults",
        workflowId: "all-defaults-test",
        workflowName: "All Defaults Test Workflow",
        status: "PENDING",
        input: { value: 4 },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-all-defaults",
        "all-defaults-test",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with empty config for the stage
      const result = await executor.execute(
        { value: 4 },
        { "all-defaults": {} },
      );

      // Then: All defaults are applied
      expect(capturedConfig).toEqual({ multiplier: 3, addend: 1 });
      // Result: 4 * 3 + 1 = 13
      expect(result).toEqual({ value: 13 });
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
          input: TestSchemas.number,
          output: TestSchemas.number,
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
        TestSchemas.number,
        TestSchemas.number,
      )
        .pipe(configuredStage)
        .build();

      await persistence.createRun({
        id: "run-override",
        workflowId: "override-test",
        workflowName: "Override Test Workflow",
        status: "PENDING",
        input: { value: 6 },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-override",
        "override-test",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with full config override
      const result = await executor.execute(
        { value: 6 },
        { "override-stage": { multiplier: 10, addend: 100 } },
      );

      // Then: Provided values override defaults
      expect(capturedConfig).toEqual({ multiplier: 10, addend: 100 });
      // Result: 6 * 10 + 100 = 160
      expect(result).toEqual({ value: 160 });
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

      await persistence.createRun({
        id: "run-invalid-input",
        workflowId: "input-validation-test",
        workflowName: "Input Validation Test",
        status: "PENDING",
        input: { name: "", count: -1 }, // Invalid input
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-invalid-input",
        "input-validation-test",
        { persistence, aiLogger },
      );

      // When/Then: Execution with invalid input should throw
      await expect(
        executor.execute({ name: "", count: -1 }, {}),
      ).rejects.toThrow();
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

      await persistence.createRun({
        id: "run-missing-fields",
        workflowId: "required-fields-test",
        workflowName: "Required Fields Test",
        status: "PENDING",
        input: { id: "test-id" }, // Missing data field
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-missing-fields",
        "required-fields-test",
        { persistence, aiLogger },
      );

      // When/Then: Execution with missing required fields should throw
      await expect(
        executor.execute({ id: "test-id" } as never, {}),
      ).rejects.toThrow();
    });
  });

  describe("config validation", () => {
    it("should reject invalid config", async () => {
      // Given: A stage with strict config validation
      const strictConfigStage = defineStage({
        id: "strict-config",
        name: "Strict Config Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
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
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(strictConfigStage)
        .build();

      await persistence.createRun({
        id: "run-invalid-config",
        workflowId: "config-validation-test",
        workflowName: "Config Validation Test",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-invalid-config",
        "config-validation-test",
        { persistence, aiLogger },
      );

      // When/Then: Execution with invalid config types should throw
      await expect(
        executor.execute(
          { value: "test" },
          { "strict-config": { model: 123, temperature: "hot" } }, // Wrong types
        ),
      ).rejects.toThrow(/config validation failed/i);
    });

    it("should reject config with out-of-range values", async () => {
      // Given: A stage with numeric constraints on config
      const rangeConfigStage = defineStage({
        id: "range-config",
        name: "Range Config Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
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
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(rangeConfigStage)
        .build();

      await persistence.createRun({
        id: "run-out-of-range",
        workflowId: "range-config-test",
        workflowName: "Range Config Test",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-out-of-range",
        "range-config-test",
        { persistence, aiLogger },
      );

      // When/Then: Execution with out-of-range config values should throw
      await expect(
        executor.execute(
          { value: "test" },
          { "range-config": { maxRetries: 100, timeout: -5 } }, // Out of valid range
        ),
      ).rejects.toThrow(/config validation failed/i);
    });

    it("should reject config with missing required fields", async () => {
      // Given: A stage requiring specific config fields (no defaults)
      const requiredConfigStage = defineStage({
        id: "required-config",
        name: "Required Config Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
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
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(requiredConfigStage)
        .build();

      await persistence.createRun({
        id: "run-missing-config",
        workflowId: "required-config-test",
        workflowName: "Required Config Test",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-missing-config",
        "required-config-test",
        { persistence, aiLogger },
      );

      // When/Then: Execution with missing required config fields should throw
      await expect(
        executor.execute(
          { value: "test" },
          { "required-config": { apiKey: "key-123" } }, // Missing endpoint
        ),
      ).rejects.toThrow(/config validation failed/i);
    });
  });
});
