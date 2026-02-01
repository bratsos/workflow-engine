/**
 * Workflow Validation Tests
 *
 * Tests for workflow dependency and configuration validation.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  createConfigurableStage,
  createPassthroughStage,
  TestConfigSchemas,
  TestSchemas,
} from "../utils/index.js";

describe("I want to validate my workflow", () => {
  describe("dependency validation", () => {
    it("should accept valid dependencies", () => {
      // Given: Stage B depends on Stage A, and A is added first
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string, {
        dependencies: ["stage-a"],
      });

      // When: I build .pipe(A).pipe(B)
      // Then: Build succeeds
      expect(() => {
        new WorkflowBuilder(
          "valid-deps",
          "Valid Dependencies",
          "Test",
          TestSchemas.string,
          TestSchemas.string,
        )
          .pipe(stageA)
          .pipe(stageB)
          .build();
      }).not.toThrow();
    });

    it("should reject missing dependencies", () => {
      // Given: Stage B depends on "stage-a" which doesn't exist
      const stageB = createPassthroughStage("stage-b", TestSchemas.string, {
        dependencies: ["stage-a"],
      });

      // When: I try to pipe B without A
      // Then: Build throws with clear error message
      expect(() => {
        new WorkflowBuilder(
          "missing-dep",
          "Missing Dependency",
          "Test",
          TestSchemas.string,
          TestSchemas.string,
        )
          .pipe(stageB)
          .build();
      }).toThrow(/missing dependencies.*stage-a/i);
    });

    it("should reject forward dependencies", () => {
      // Given: Stage A depends on Stage B, but A comes first
      const stageA = createPassthroughStage("stage-a", TestSchemas.string, {
        dependencies: ["stage-b"], // B doesn't exist yet
      });
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);

      // When: I try to build with A first
      // Then: Build throws (can't depend on later stage)
      expect(() => {
        new WorkflowBuilder(
          "forward-dep",
          "Forward Dependency",
          "Test",
          TestSchemas.string,
          TestSchemas.string,
        )
          .pipe(stageA)
          .pipe(stageB)
          .build();
      }).toThrow(/missing dependencies.*stage-b/i);
    });

    it("should validate dependencies in parallel stages", () => {
      // Given: Parallel stage depends on non-existent stage
      const stageA = createPassthroughStage("stage-a", TestSchemas.string, {
        dependencies: ["nonexistent"],
      });
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);

      // When: I try to add them as parallel
      // Then: Should throw
      expect(() => {
        new WorkflowBuilder(
          "parallel-missing-dep",
          "Parallel Missing Dependency",
          "Test",
          TestSchemas.string,
          z.any(),
        )
          .parallel([stageA, stageB])
          .build();
      }).toThrow(/missing dependencies.*nonexistent/i);
    });

    it("should accept parallel stages depending on previous sequential stage", () => {
      // Given: Sequential stage, then parallel stages that depend on it
      const prepStage = createPassthroughStage("prep", TestSchemas.string);
      const stageA = createPassthroughStage("stage-a", TestSchemas.string, {
        dependencies: ["prep"],
      });
      const stageB = createPassthroughStage("stage-b", TestSchemas.string, {
        dependencies: ["prep"],
      });

      // When: I build with sequential then parallel
      // Then: Build succeeds
      expect(() => {
        new WorkflowBuilder(
          "parallel-valid-dep",
          "Parallel Valid Dependency",
          "Test",
          TestSchemas.string,
          z.any(),
        )
          .pipe(prepStage)
          .parallel([stageA, stageB])
          .build();
      }).not.toThrow();
    });
  });

  describe("configuration validation", () => {
    it("should validate config against all stage schemas", () => {
      // Given: A workflow with stages requiring specific config
      const stageWithConfig = defineStage({
        id: "config-stage",
        name: "Config Stage",
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
        "config-validation",
        "Config Validation",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageWithConfig)
        .build();

      // When: I call validateConfig() with invalid config
      const result = workflow.validateConfig({
        "config-stage": { model: 123, temperature: 5 }, // Invalid types
      });

      // Then: Returns { valid: false, errors: [...] }
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should pass validation for correct config", () => {
      // Given: Stage with config schema
      const stageWithConfig = defineStage({
        id: "config-stage",
        name: "Config Stage",
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
        "valid-config",
        "Valid Config",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageWithConfig)
        .build();

      // When: I call validateConfig() with correct config
      const result = workflow.validateConfig({
        "config-stage": { model: "gpt-4", temperature: 0.7 },
      });

      // Then: Returns { valid: true, errors: [] }
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should report which stage has invalid config", () => {
      // Given: Multiple stages, one with invalid config
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            requiredField: z.string(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-config",
        "Multi Config",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      // When: I validate with invalid config for stage-b
      const result = workflow.validateConfig({
        "stage-a": {},
        "stage-b": {}, // Missing requiredField
      });

      // Then: Error includes stageId: "stage-b"
      expect(result.valid).toBe(false);
      const errorForB = result.errors.find((e) => e.stageId === "stage-b");
      expect(errorForB).toBeDefined();
      expect(errorForB?.error).toContain("requiredField");
    });

    it("should validate all stages, not just the first error", () => {
      // Given: Multiple stages with different config requirements
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

      const workflow = new WorkflowBuilder(
        "multi-validation",
        "Multi Validation",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      // When: Both stages have invalid config
      const result = workflow.validateConfig({
        "stage-a": { fieldA: 123 }, // Wrong type
        "stage-b": { fieldB: "not a number" }, // Wrong type
      });

      // Then: Returns errors for both stages
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(2);

      const stageIds = result.errors.map((e) => e.stageId);
      expect(stageIds).toContain("stage-a");
      expect(stageIds).toContain("stage-b");
    });

    it("should use defaults for missing optional config", () => {
      // Given: Stage with optional config that has defaults
      const stageWithDefaults = defineStage({
        id: "defaults-stage",
        name: "Defaults Stage",
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

      const workflow = new WorkflowBuilder(
        "defaults-config",
        "Defaults Config",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageWithDefaults)
        .build();

      // When: I call validateConfig() with empty config
      const result = workflow.validateConfig({
        "defaults-stage": {},
      });

      // Then: Passes validation (defaults used)
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
