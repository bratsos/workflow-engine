/**
 * Validation Error Tests
 *
 * Tests for input and config validation errors, rewritten to use kernel dispatch().
 *
 * - Input validation: `run.create` throws for invalid input
 * - Config validation: `run.create` throws for invalid config
 * - Stage-level input validation failures: `job.execute` returns `{ outcome: "failed" }`
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
    persistence, blobStore, jobTransport, eventSink, scheduler, clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });
  const flush = () => kernel.dispatch({ type: "outbox.flush" as const });
  return { kernel, flush, persistence, blobStore, jobTransport, eventSink, scheduler, clock, registry };
}

const StringSchema = z.object({ value: z.string() });

describe("I want to validate input and config before execution", () => {
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

      const { kernel } = createTestKernel([workflow]);

      // When: I create a run with invalid input
      // Then: Throws validation error
      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-invalid-input",
          workflowId: "input-validation-workflow",
          input: { name: "", age: -5 }, // Invalid: empty name and negative age
        }),
      ).rejects.toThrow("Invalid workflow input");
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

      const { kernel } = createTestKernel([workflow]);

      // When: I create a run with missing required fields
      // Then: Throws validation error
      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-missing-fields",
          workflowId: "required-fields-workflow",
          input: {}, // Missing required fields
        }),
      ).rejects.toThrow("Invalid workflow input");
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

      const { kernel } = createTestKernel([workflow]);

      // When: I create a run with invalid data
      // Then: Error message should be helpful
      try {
        await kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-helpful-errors",
          workflowId: "helpful-error-workflow",
          input: { email: "not-an-email", count: 0 },
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const errorMessage = (error as Error).message.toLowerCase();
        expect(
          errorMessage.includes("invalid") ||
            errorMessage.includes("email") ||
            errorMessage.includes("validation"),
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
          input: StringSchema,
          output: StringSchema,
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
        StringSchema,
        StringSchema,
      )
        .pipe(configRequiredStage)
        .build();

      const { kernel } = createTestKernel([workflow]);

      // When: I create a run with invalid config
      // Then: Throws config validation error
      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-invalid-config",
          workflowId: "config-validation-workflow",
          input: { value: "test" },
          config: {
            "config-required-stage": {
              model: "", // Invalid: empty string
              temperature: 5, // Invalid: out of range
            },
          },
        }),
      ).rejects.toThrow(/invalid workflow config/i);
    });

    it("should throw for missing required config", async () => {
      // Given: A stage with required config fields
      const tracker: string[] = [];

      const strictConfigStage = defineStage({
        id: "strict-config-stage",
        name: "Strict Config Stage",
        schemas: {
          input: StringSchema,
          output: StringSchema,
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
        StringSchema,
        StringSchema,
      )
        .pipe(strictConfigStage)
        .build();

      const { kernel } = createTestKernel([workflow]);

      // When: I create a run with missing config
      // Then: Throws before stage executes
      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-missing-config",
          workflowId: "strict-config-workflow",
          input: { value: "test" },
          config: { "strict-config-stage": {} },
        }),
      ).rejects.toThrow(/invalid workflow config/i);

      // Stage should not have been executed
      expect(tracker).toHaveLength(0);
    });

    it("should provide helpful error messages for config validation", async () => {
      // Given: A stage with specific config requirements
      const detailedConfigStage = defineStage({
        id: "detailed-config-stage",
        name: "Detailed Config Stage",
        schemas: {
          input: StringSchema,
          output: StringSchema,
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
        StringSchema,
        StringSchema,
      )
        .pipe(detailedConfigStage)
        .build();

      const { kernel } = createTestKernel([workflow]);

      // When: I create a run with invalid config values
      try {
        await kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-detailed-config",
          workflowId: "detailed-config-workflow",
          input: { value: "test" },
          config: {
            "detailed-config-stage": {
              maxRetries: -1, // Invalid
              timeout: 50, // Too low
            },
          },
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const errorMessage = (error as Error).message.toLowerCase();
        // Error should mention config validation
        expect(errorMessage).toContain("invalid workflow config");
      }
    });
  });

  describe("validation timing", () => {
    it("should validate config at run.create time, before any execution", async () => {
      // Given: A workflow where we track execution
      const executionLog: string[] = [];

      const stage1 = defineStage({
        id: "stage-1",
        name: "Stage 1",
        schemas: { input: StringSchema, output: StringSchema, config: z.object({}) },
        async execute(ctx) {
          executionLog.push("stage-1-executed");
          return { output: ctx.input };
        },
      });

      const stage2 = defineStage({
        id: "stage-2",
        name: "Stage 2",
        schemas: {
          input: StringSchema,
          output: StringSchema,
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
        StringSchema,
        StringSchema,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      const { kernel } = createTestKernel([workflow]);

      // When: I create a run with invalid config for stage 2
      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-validation-timing",
          workflowId: "validation-timing-workflow",
          input: { value: "test" },
          config: {
            "stage-2": {}, // Missing required config
          },
        }),
      ).rejects.toThrow(/invalid workflow config/i);

      // Then: Neither stage should have executed (validation happens at create time)
      expect(executionLog).toHaveLength(0);
    });
  });
});
