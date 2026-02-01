/**
 * Validation Error Tests
 *
 * Tests for input and config validation errors before workflow execution.
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

describe("I want to validate input and config before execution", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  describe("input validation", () => {
    it("should throw for invalid workflow input", async () => {
      // Given: A workflow with strict input schema
      const strictInputStage = defineStage({
        id: "strict-input-stage",
        name: "Strict Input Stage",
        schemas: {
          input: z.object({
            name: z.string().min(1),
            age: z.number().positive(),
          }),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: { result: `${ctx.input.name} is ${ctx.input.age}` },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "input-validation-workflow",
        "Input Validation Workflow",
        "Test",
        z.object({
          name: z.string().min(1),
          age: z.number().positive(),
        }),
        z.object({ result: z.string() }),
      )
        .pipe(strictInputStage)
        .build();

      await persistence.createRun({
        id: "run-invalid-input",
        workflowId: "input-validation-workflow",
        workflowName: "Input Validation Workflow",
        status: "PENDING",
        input: { name: "", age: -5 }, // Invalid: empty name and negative age
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-invalid-input",
        "input-validation-workflow",
        { persistence, aiLogger },
      );

      // When: I execute with invalid input
      // Then: Throws validation error
      await expect(
        executor.execute({ name: "", age: -5 }, {}),
      ).rejects.toThrow();
    });

    it("should throw for missing required input fields", async () => {
      // Given: A workflow requiring specific fields
      const requiredFieldsStage = defineStage({
        id: "required-fields-stage",
        name: "Required Fields Stage",
        schemas: {
          input: z.object({
            userId: z.string(),
            email: z.string().email(),
          }),
          output: z.object({ success: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { success: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "required-fields-workflow",
        "Required Fields Workflow",
        "Test",
        z.object({
          userId: z.string(),
          email: z.string().email(),
        }),
        z.object({ success: z.boolean() }),
      )
        .pipe(requiredFieldsStage)
        .build();

      await persistence.createRun({
        id: "run-missing-fields",
        workflowId: "required-fields-workflow",
        workflowName: "Required Fields Workflow",
        status: "PENDING",
        input: {}, // Missing required fields
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-missing-fields",
        "required-fields-workflow",
        { persistence, aiLogger },
      );

      // When: I execute with missing required fields
      // Then: Throws validation error
      await expect(executor.execute({}, {})).rejects.toThrow();
    });

    it("should provide helpful error messages for input validation", async () => {
      // Given: A workflow with specific validation rules
      const validatedStage = defineStage({
        id: "validated-stage",
        name: "Validated Stage",
        schemas: {
          input: z.object({
            email: z.string().email("Invalid email format"),
            count: z.number().min(1, "Count must be at least 1"),
          }),
          output: z.object({ processed: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { processed: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "helpful-error-workflow",
        "Helpful Error Workflow",
        "Test",
        z.object({
          email: z.string().email("Invalid email format"),
          count: z.number().min(1, "Count must be at least 1"),
        }),
        z.object({ processed: z.boolean() }),
      )
        .pipe(validatedStage)
        .build();

      await persistence.createRun({
        id: "run-helpful-errors",
        workflowId: "helpful-error-workflow",
        workflowName: "Helpful Error Workflow",
        status: "PENDING",
        input: { email: "not-an-email", count: 0 },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-helpful-errors",
        "helpful-error-workflow",
        { persistence, aiLogger },
      );

      // When: I execute with invalid data
      // Then: Error message should be helpful
      try {
        await executor.execute({ email: "not-an-email", count: 0 }, {});
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        // The error should contain information about what went wrong
        const errorMessage = (error as Error).message.toLowerCase();
        expect(
          errorMessage.includes("email") ||
            errorMessage.includes("validation") ||
            errorMessage.includes("invalid"),
        ).toBe(true);
      }
    });
  });

  describe("config validation", () => {
    it("should throw for invalid stage config", async () => {
      // Given: A stage that requires specific config
      const configRequiredStage = defineStage({
        id: "config-required-stage",
        name: "Config Required Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            model: z.string(),
            temperature: z.number().min(0).max(2),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "config-validation-workflow",
        "Config Validation Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(configRequiredStage)
        .build();

      await persistence.createRun({
        id: "run-invalid-config",
        workflowId: "config-validation-workflow",
        workflowName: "Config Validation Workflow",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-invalid-config",
        "config-validation-workflow",
        { persistence, aiLogger },
      );

      // When: I execute with invalid config
      // Then: Throws config validation error before execution
      await expect(
        executor.execute(
          { value: "test" },
          {
            "config-required-stage": {
              model: "", // Invalid: empty string
              temperature: 5, // Invalid: out of range
            },
          },
        ),
      ).rejects.toThrow(/config validation failed/i);
    });

    it("should throw for missing required config", async () => {
      // Given: A stage with required config fields
      const tracker: string[] = [];

      const strictConfigStage = defineStage({
        id: "strict-config-stage",
        name: "Strict Config Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            apiKey: z.string().min(1),
            endpoint: z.string().url(),
          }),
        },
        async execute(ctx) {
          tracker.push("executed");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "strict-config-workflow",
        "Strict Config Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(strictConfigStage)
        .build();

      await persistence.createRun({
        id: "run-missing-config",
        workflowId: "strict-config-workflow",
        workflowName: "Strict Config Workflow",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-missing-config",
        "strict-config-workflow",
        { persistence, aiLogger },
      );

      // When: I execute with missing config
      // Then: Throws before stage executes
      await expect(
        executor.execute({ value: "test" }, { "strict-config-stage": {} }),
      ).rejects.toThrow(/config validation failed/i);

      // Stage should not have been executed
      expect(tracker).toHaveLength(0);
    });

    it("should provide helpful error messages for config validation", async () => {
      // Given: A stage with specific config requirements
      const detailedConfigStage = defineStage({
        id: "detailed-config-stage",
        name: "Detailed Config Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            maxRetries: z.number().int().positive("Must be a positive integer"),
            timeout: z.number().min(100, "Timeout must be at least 100ms"),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "detailed-config-workflow",
        "Detailed Config Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(detailedConfigStage)
        .build();

      await persistence.createRun({
        id: "run-detailed-config",
        workflowId: "detailed-config-workflow",
        workflowName: "Detailed Config Workflow",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-detailed-config",
        "detailed-config-workflow",
        { persistence, aiLogger },
      );

      // When: I execute with invalid config values
      try {
        await executor.execute(
          { value: "test" },
          {
            "detailed-config-stage": {
              maxRetries: -1, // Invalid
              timeout: 50, // Too low
            },
          },
        );
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const errorMessage = (error as Error).message.toLowerCase();
        // Error should mention config validation
        expect(errorMessage).toContain("config validation failed");
      }
    });
  });

  describe("validation timing", () => {
    it("should validate config before execution starts", async () => {
      // Given: A workflow where we track execution
      const executionLog: string[] = [];

      const stage1 = defineStage({
        id: "stage-1",
        name: "Stage 1",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("stage-1-executed");
          return { output: ctx.input };
        },
      });

      const stage2 = defineStage({
        id: "stage-2",
        name: "Stage 2",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            requiredField: z.string(),
          }),
        },
        async execute(ctx) {
          executionLog.push("stage-2-executed");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "validation-timing-workflow",
        "Validation Timing Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      await persistence.createRun({
        id: "run-validation-timing",
        workflowId: "validation-timing-workflow",
        workflowName: "Validation Timing Workflow",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-validation-timing",
        "validation-timing-workflow",
        { persistence, aiLogger },
      );

      // When: I execute with invalid config for stage 2
      await expect(
        executor.execute(
          { value: "test" },
          {
            "stage-2": {}, // Missing required config
          },
        ),
      ).rejects.toThrow(/config validation failed/i);

      // Then: Neither stage should have executed (validation happens first)
      expect(executionLog).toHaveLength(0);
    });
  });
});
