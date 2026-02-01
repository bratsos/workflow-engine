/**
 * Config Defaults Tests
 *
 * Tests for workflow.getDefaultConfig() which extracts default configuration
 * values from stage config schemas.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow.js";
import { defineStage } from "../../core/stage-factory.js";
import { createPassthroughStage, TestSchemas } from "../utils/index.js";

describe("I want to get default configuration for my workflow", () => {
  describe("returning defaults for all stages", () => {
    it("should return defaults for all stages", () => {
      // Given: A workflow with multiple stages, each with default configs
      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            model: z.string().default("gpt-4"),
            temperature: z.number().default(0.7),
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
            concurrency: z.number().default(5),
            retries: z.number().default(3),
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
            enabled: z.boolean().default(true),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-defaults",
        "Multi Defaults Workflow",
        "Test workflow with multiple stage defaults",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // When: I get default config
      const defaults = workflow.getDefaultConfig();

      // Then: Returns defaults for all three stages
      expect(Object.keys(defaults)).toHaveLength(3);
      expect(defaults["stage-a"]).toEqual({ model: "gpt-4", temperature: 0.7 });
      expect(defaults["stage-b"]).toEqual({ concurrency: 5, retries: 3 });
      expect(defaults["stage-c"]).toEqual({ enabled: true });
    });

    it("should return empty object for stages without defaults", () => {
      // Given: A workflow with a stage that has no defaults
      const stageNoDefaults = defineStage({
        id: "no-defaults",
        name: "No Defaults Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            requiredString: z.string(),
            requiredNumber: z.number(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "no-defaults-test",
        "No Defaults Test",
        "Test stage without defaults",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageNoDefaults)
        .build();

      // When: I get default config
      const defaults = workflow.getDefaultConfig();

      // Then: Returns empty object for that stage
      expect(defaults["no-defaults"]).toEqual({});
    });

    it("should return partial defaults when only some fields have defaults", () => {
      // Given: A stage with mixed required and default fields
      const mixedStage = defineStage({
        id: "mixed-stage",
        name: "Mixed Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            apiKey: z.string(), // Required, no default
            model: z.string().default("gpt-4"), // Has default
            timeout: z.number(), // Required, no default
            retries: z.number().default(3), // Has default
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "mixed-defaults",
        "Mixed Defaults Test",
        "Test mixed defaults",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(mixedStage)
        .build();

      // When: I get default config
      const defaults = workflow.getDefaultConfig();

      // Then: Only fields with defaults are included
      expect(defaults["mixed-stage"]).toEqual({
        model: "gpt-4",
        retries: 3,
      });
      expect(defaults["mixed-stage"]).not.toHaveProperty("apiKey");
      expect(defaults["mixed-stage"]).not.toHaveProperty("timeout");
    });
  });

  describe("using schema defaults", () => {
    it("should use schema defaults", () => {
      // Given: A stage with various Zod default types
      const schemaDefaultsStage = defineStage({
        id: "schema-defaults",
        name: "Schema Defaults Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            stringField: z.string().default("hello"),
            numberField: z.number().default(42),
            booleanField: z.boolean().default(false),
            arrayField: z.array(z.string()).default(["a", "b"]),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "schema-defaults-test",
        "Schema Defaults Test",
        "Test Zod schema defaults",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(schemaDefaultsStage)
        .build();

      // When: I get default config
      const defaults = workflow.getDefaultConfig();

      // Then: All schema defaults are extracted correctly
      expect(defaults["schema-defaults"]).toEqual({
        stringField: "hello",
        numberField: 42,
        booleanField: false,
        arrayField: ["a", "b"],
      });
    });

    it("should handle optional fields with defaults", () => {
      // Given: A stage with optional fields that have defaults
      const optionalDefaultsStage = defineStage({
        id: "optional-defaults",
        name: "Optional Defaults Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            required: z.string(),
            optionalWithDefault: z.string().optional().default("default-value"),
            pureOptional: z.string().optional(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "optional-defaults-test",
        "Optional Defaults Test",
        "Test optional with defaults",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(optionalDefaultsStage)
        .build();

      // When: I get default config
      const defaults = workflow.getDefaultConfig();

      // Then: Only fields with defaults are included
      expect(defaults["optional-defaults"]).toEqual({
        optionalWithDefault: "default-value",
      });
    });

    it("should handle function defaults", () => {
      // Given: A stage with a dynamic default (function)
      const functionDefaultStage = defineStage({
        id: "function-default",
        name: "Function Default Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            timestamp: z.number().default(() => 12345), // Static for testing
            items: z.array(z.string()).default(() => ["item1", "item2"]),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "function-default-test",
        "Function Default Test",
        "Test function defaults",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(functionDefaultStage)
        .build();

      // When: I get default config
      const defaults = workflow.getDefaultConfig();

      // Then: Function defaults are evaluated
      expect(defaults["function-default"]).toEqual({
        timestamp: 12345,
        items: ["item1", "item2"],
      });
    });
  });

  describe("working with nested schemas", () => {
    it("should work with nested schemas", () => {
      // Given: A stage with nested config schema
      const nestedStage = defineStage({
        id: "nested-stage",
        name: "Nested Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            settings: z
              .object({
                innerValue: z.string().default("inner-default"),
                innerNumber: z.number().default(100),
              })
              .default({ innerValue: "inner-default", innerNumber: 100 }),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "nested-defaults-test",
        "Nested Defaults Test",
        "Test nested schema defaults",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(nestedStage)
        .build();

      // When: I get default config
      const defaults = workflow.getDefaultConfig();

      // Then: Nested defaults are extracted
      expect(defaults["nested-stage"]).toEqual({
        settings: { innerValue: "inner-default", innerNumber: 100 },
      });
    });

    it("should handle deeply nested defaults", () => {
      // Given: A stage with deeply nested config
      const deepNestedStage = defineStage({
        id: "deep-nested",
        name: "Deep Nested Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            level1: z
              .object({
                level2: z
                  .object({
                    level3Value: z.string().default("deep-default"),
                  })
                  .default({ level3Value: "deep-default" }),
              })
              .default({ level2: { level3Value: "deep-default" } }),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "deep-nested-test",
        "Deep Nested Test",
        "Test deeply nested defaults",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(deepNestedStage)
        .build();

      // When: I get default config
      const defaults = workflow.getDefaultConfig();

      // Then: Deep nested defaults are extracted
      expect(defaults["deep-nested"]).toEqual({
        level1: {
          level2: {
            level3Value: "deep-default",
          },
        },
      });
    });

    it("should handle mixed nested and flat defaults", () => {
      // Given: A stage with both flat and nested config with defaults
      const mixedNestedStage = defineStage({
        id: "mixed-nested",
        name: "Mixed Nested Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            flatString: z.string().default("flat-value"),
            flatNumber: z.number().default(42),
            nested: z
              .object({
                nestedBool: z.boolean().default(true),
              })
              .default({ nestedBool: true }),
            anotherFlat: z.boolean().default(false),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "mixed-nested-test",
        "Mixed Nested Test",
        "Test mixed nested and flat defaults",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(mixedNestedStage)
        .build();

      // When: I get default config
      const defaults = workflow.getDefaultConfig();

      // Then: Both flat and nested defaults are extracted
      expect(defaults["mixed-nested"]).toEqual({
        flatString: "flat-value",
        flatNumber: 42,
        nested: { nestedBool: true },
        anotherFlat: false,
      });
    });
  });

  describe("integration with empty config stages", () => {
    it("should handle stages with empty config schema", () => {
      // Given: A workflow with a passthrough stage (empty config)
      const passthroughStage = createPassthroughStage(
        "passthrough",
        TestSchemas.string,
      );

      const workflow = new WorkflowBuilder(
        "empty-config-test",
        "Empty Config Test",
        "Test with empty config stage",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(passthroughStage)
        .build();

      // When: I get default config
      const defaults = workflow.getDefaultConfig();

      // Then: Returns empty object for passthrough stage
      expect(defaults["passthrough"]).toEqual({});
    });

    it("should return correct defaults for mixed workflow", () => {
      // Given: A workflow with stages having different config complexities
      const simpleStage = createPassthroughStage("simple", TestSchemas.string);

      const configuredStage = defineStage({
        id: "configured",
        name: "Configured Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            model: z.string().default("gpt-4"),
            temperature: z.number().default(0.7),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const requiredConfigStage = defineStage({
        id: "required-config",
        name: "Required Config Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            apiKey: z.string(), // No default
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "mixed-workflow",
        "Mixed Workflow",
        "Test mixed config complexity",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(simpleStage)
        .pipe(configuredStage)
        .pipe(requiredConfigStage)
        .build();

      // When: I get default config
      const defaults = workflow.getDefaultConfig();

      // Then: Returns appropriate defaults for each stage
      expect(defaults["simple"]).toEqual({});
      expect(defaults["configured"]).toEqual({
        model: "gpt-4",
        temperature: 0.7,
      });
      expect(defaults["required-config"]).toEqual({});
    });
  });
});
