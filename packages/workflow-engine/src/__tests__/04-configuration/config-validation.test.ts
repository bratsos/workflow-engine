/**
 * Config Validation Tests
 *
 * Tests for workflow configuration validation using workflow.validateConfig().
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow.js";
import { defineStage } from "../../core/stage-factory.js";
import { createPassthroughStage, TestSchemas } from "../utils/index.js";

describe("I want to validate workflow configuration", () => {
  describe("validating all stage configs", () => {
    it("should validate all stage configs", () => {
      // Given: A workflow with multiple stages with different config schemas
      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
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

      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            concurrency: z.number().positive(),
            retries: z.number().int().min(0),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-stage-validation",
        "Multi Stage Validation",
        "Test workflow with multiple config schemas",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      // When: I validate with correct config for all stages
      const result = workflow.validateConfig({
        "stage-a": { model: "gpt-4", temperature: 0.7 },
        "stage-b": { concurrency: 5, retries: 3 },
      });

      // Then: Validation passes
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should return all errors not just first", () => {
      // Given: A workflow with multiple stages
      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            fieldA: z.string(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            fieldB: z.number(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const stageC = defineStage({
        id: "stage-c",
        name: "Stage C",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            fieldC: z.boolean(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "all-errors-validation",
        "All Errors Validation",
        "Test returning all errors",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // When: All stages have invalid config
      const result = workflow.validateConfig({
        "stage-a": { fieldA: 123 }, // Should be string
        "stage-b": { fieldB: "not a number" }, // Should be number
        "stage-c": { fieldC: "not a boolean" }, // Should be boolean
      });

      // Then: Returns errors for all three stages
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(3);

      const stageIds = result.errors.map((e) => e.stageId);
      expect(stageIds).toContain("stage-a");
      expect(stageIds).toContain("stage-b");
      expect(stageIds).toContain("stage-c");
    });

    it("should identify which stage has error", () => {
      // Given: A workflow with multiple stages, only one with invalid config
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            requiredField: z.string(),
            numericField: z.number(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });
      const stageC = createPassthroughStage("stage-c", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "identify-stage-error",
        "Identify Stage Error",
        "Test identifying which stage has error",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // When: Only stage-b has invalid config
      const result = workflow.validateConfig({
        "stage-a": {},
        "stage-b": { requiredField: 123, numericField: "wrong" }, // Both fields wrong type
        "stage-c": {},
      });

      // Then: Error identifies stage-b specifically
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].stageId).toBe("stage-b");
      expect(result.errors[0].error).toContain("requiredField");
    });

    it("should pass with missing optional config", () => {
      // Given: A workflow with stages that have optional config with defaults
      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            model: z.string().default("gpt-4"),
            temperature: z.number().default(0.7),
            maxTokens: z.number().optional(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            retries: z.number().default(3),
            timeout: z.number().optional(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "optional-config",
        "Optional Config",
        "Test with optional config",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      // When: I validate with empty configs (relying on defaults)
      const result = workflow.validateConfig({
        "stage-a": {},
        "stage-b": {},
      });

      // Then: Validation passes (defaults fill in required values)
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should pass when no config is provided for stage with all defaults", () => {
      // Given: A stage where all config fields have defaults
      const stageWithDefaults = defineStage({
        id: "all-defaults",
        name: "All Defaults Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            enabled: z.boolean().default(true),
            count: z.number().default(10),
            label: z.string().default("default"),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "all-defaults-test",
        "All Defaults Test",
        "Test with all defaults",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageWithDefaults)
        .build();

      // When: No config provided at all for the stage
      const result = workflow.validateConfig({});

      // Then: Validation passes
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("validation error details", () => {
    it("should include field path in error message", () => {
      // Given: A stage with nested config
      const stageWithNested = defineStage({
        id: "nested-config",
        name: "Nested Config Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            settings: z.object({
              maxItems: z.number().positive(),
            }),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "nested-error-test",
        "Nested Error Test",
        "Test nested config error",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageWithNested)
        .build();

      // When: Nested field has invalid value
      const result = workflow.validateConfig({
        "nested-config": { settings: { maxItems: -5 } },
      });

      // Then: Error includes the field path
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toContain("settings.maxItems");
    });

    it("should report multiple errors for same stage", () => {
      // Given: A stage with multiple required fields
      const stageMultiError = defineStage({
        id: "multi-error",
        name: "Multi Error Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            name: z.string().min(1),
            count: z.number().positive(),
            enabled: z.boolean(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-error-test",
        "Multi Error Test",
        "Test multiple errors in one stage",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageMultiError)
        .build();

      // When: Multiple fields have invalid values
      const result = workflow.validateConfig({
        "multi-error": { name: "", count: -1, enabled: "yes" },
      });

      // Then: Error message contains info about all invalid fields
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(1);
      const errorMsg = result.errors[0].error;
      expect(errorMsg).toContain("name");
      expect(errorMsg).toContain("count");
      expect(errorMsg).toContain("enabled");
    });
  });

  describe("validation with complex schemas", () => {
    it("should validate array config fields", () => {
      // Given: A stage with array config
      const stageWithArray = defineStage({
        id: "array-config",
        name: "Array Config Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            tags: z.array(z.string()),
            scores: z.array(z.number().min(0).max(100)),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "array-config-test",
        "Array Config Test",
        "Test array config validation",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageWithArray)
        .build();

      // When: Array contains invalid elements
      const result = workflow.validateConfig({
        "array-config": { tags: ["valid", 123], scores: [50, 150] },
      });

      // Then: Validation fails
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(1);
    });

    it("should validate enum config fields", () => {
      // Given: A stage with enum config
      const stageWithEnum = defineStage({
        id: "enum-config",
        name: "Enum Config Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            mode: z.enum(["fast", "balanced", "quality"]),
            priority: z.enum(["low", "medium", "high"]).default("medium"),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "enum-config-test",
        "Enum Config Test",
        "Test enum config validation",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageWithEnum)
        .build();

      // When: Enum has invalid value
      const invalidResult = workflow.validateConfig({
        "enum-config": { mode: "invalid-mode" },
      });

      expect(invalidResult.valid).toBe(false);

      // When: Enum has valid value
      const validResult = workflow.validateConfig({
        "enum-config": { mode: "fast" },
      });

      expect(validResult.valid).toBe(true);
    });
  });
});
