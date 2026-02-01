/**
 * Workflow Query Tests
 *
 * Tests for querying workflow structure and configuration.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { createPassthroughStage, TestSchemas } from "../utils/index.js";

describe("I want to query my workflow", () => {
  describe("execution order", () => {
    it("should return execution order as readable string", () => {
      // Given: A 3-stage workflow
      const stageA = createPassthroughStage("stage-a", TestSchemas.string, {
        name: "Stage A",
        description: "First stage",
      });
      const stageB = createPassthroughStage("stage-b", TestSchemas.string, {
        name: "Stage B",
        description: "Second stage",
      });
      const stageC = createPassthroughStage("stage-c", TestSchemas.string, {
        name: "Stage C",
      });

      const workflow = new WorkflowBuilder(
        "query-workflow",
        "Query Workflow",
        "Test queries",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // When: I call getExecutionOrder()
      const order = workflow.getExecutionOrder();

      // Then: Returns human-readable execution order
      expect(order).toContain("Query Workflow");
      expect(order).toContain("Total stages: 3");
      expect(order).toContain("Stage A");
      expect(order).toContain("Stage B");
      expect(order).toContain("Stage C");
      expect(order).toContain("First stage"); // Description
    });

    it("should show parallel stages in execution order", () => {
      // Given: Workflow with parallel stages
      const stageA = createPassthroughStage("stage-a", TestSchemas.string, {
        name: "Stage A",
      });
      const stageB = createPassthroughStage("stage-b", TestSchemas.string, {
        name: "Stage B",
      });

      const workflow = new WorkflowBuilder(
        "parallel-order",
        "Parallel Order",
        "Test",
        TestSchemas.string,
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      // When: I call getExecutionOrder()
      const order = workflow.getExecutionOrder();

      // Then: Shows parallel indicator
      expect(order).toContain("[PARALLEL]");
    });
  });

  describe("stage retrieval", () => {
    it("should return stage by ID", () => {
      // Given: A workflow with stage "my-stage"
      const myStage = createPassthroughStage("my-stage", TestSchemas.string, {
        name: "My Stage",
        description: "A specific stage",
      });

      const workflow = new WorkflowBuilder(
        "stage-by-id",
        "Stage By ID",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(myStage)
        .build();

      // When: I call getStage("my-stage")
      const retrieved = workflow.getStage("my-stage");

      // Then: Returns the stage definition
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe("my-stage");
      expect(retrieved?.name).toBe("My Stage");
      expect(retrieved?.description).toBe("A specific stage");
    });

    it("should return undefined for unknown stage", () => {
      // Given: A workflow
      const stage = createPassthroughStage("existing", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "unknown-stage",
        "Unknown Stage",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      // When: I call getStage("nonexistent")
      const result = workflow.getStage("nonexistent");

      // Then: Returns undefined
      expect(result).toBeUndefined();
    });

    it("should check if stage exists", () => {
      // Given: A workflow with stage "exists"
      const existsStage = createPassthroughStage("exists", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "has-stage",
        "Has Stage",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(existsStage)
        .build();

      // When: I call hasStage("exists") and hasStage("nope")
      // Then: Returns true and false respectively
      expect(workflow.hasStage("exists")).toBe(true);
      expect(workflow.hasStage("nope")).toBe(false);
    });

    it("should return all stage IDs", () => {
      // Given: Workflow with stages A, B, C
      const stageA = createPassthroughStage("a", TestSchemas.string);
      const stageB = createPassthroughStage("b", TestSchemas.string);
      const stageC = createPassthroughStage("c", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "all-ids",
        "All IDs",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // When: I call getStageIds()
      const ids = workflow.getStageIds();

      // Then: Returns ["a", "b", "c"]
      expect(ids).toEqual(["a", "b", "c"]);
    });
  });

  describe("stage configurations", () => {
    it("should return stage configurations", () => {
      // Given: Stages with config schemas
      const stageWithConfig = defineStage({
        id: "config-stage",
        name: "Config Stage",
        description: "Has configuration",
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
        "stage-configs",
        "Stage Configs",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageWithConfig)
        .build();

      // When: I call getStageConfigs()
      const configs = workflow.getStageConfigs();

      // Then: Returns map of stageId -> { schema, defaults, name }
      expect(configs["config-stage"]).toBeDefined();
      expect(configs["config-stage"].name).toBe("Config Stage");
      expect(configs["config-stage"].description).toBe("Has configuration");
      expect(configs["config-stage"].defaults).toEqual({
        model: "gpt-4",
        temperature: 0.7,
      });
    });

    it("should return default configuration for all stages", () => {
      // Given: Workflow with stages having different defaults
      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            fieldA: z.string().default("default-a"),
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
            fieldB: z.number().default(42),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "default-configs",
        "Default Configs",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      // When: I call getDefaultConfig()
      const defaultConfig = workflow.getDefaultConfig();

      // Then: Returns { "stage-a": {...}, "stage-b": {...} }
      expect(defaultConfig["stage-a"]).toEqual({ fieldA: "default-a" });
      expect(defaultConfig["stage-b"]).toEqual({ fieldB: 42 });
    });

    it("should handle stages with empty config", () => {
      // Given: Stage with no config requirements
      const simpleStage = createPassthroughStage("simple", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "empty-config",
        "Empty Config",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(simpleStage)
        .build();

      // When: I call getDefaultConfig()
      const defaultConfig = workflow.getDefaultConfig();

      // Then: Returns empty object for that stage
      expect(defaultConfig["simple"]).toEqual({});
    });
  });

  describe("stage indexing", () => {
    it("should return stage index", () => {
      // Given: Workflow with 3 stages
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);
      const stageC = createPassthroughStage("stage-c", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "indexing",
        "Indexing Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // Then: getStageIndex returns correct indices
      expect(workflow.getStageIndex("stage-a")).toBe(0);
      expect(workflow.getStageIndex("stage-b")).toBe(1);
      expect(workflow.getStageIndex("stage-c")).toBe(2);
      expect(workflow.getStageIndex("nonexistent")).toBe(-1);
    });

    it("should return execution group index", () => {
      // Given: Workflow with sequential and parallel stages
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);
      const stageC = createPassthroughStage("stage-c", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "groups",
        "Groups Test",
        "Test",
        TestSchemas.string,
        z.any(),
      )
        .pipe(stageA)
        .parallel([stageB, stageC])
        .build();

      // Then: getExecutionGroupIndex returns correct group
      expect(workflow.getExecutionGroupIndex("stage-a")).toBe(1); // First group
      expect(workflow.getExecutionGroupIndex("stage-b")).toBe(2); // Second group (parallel)
      expect(workflow.getExecutionGroupIndex("stage-c")).toBe(2); // Same group
    });

    it("should return previous stage ID", () => {
      // Given: Workflow with stages A -> B -> C
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);
      const stageC = createPassthroughStage("stage-c", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "previous",
        "Previous Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // Then: getPreviousStageId returns correct previous stage
      expect(workflow.getPreviousStageId("stage-a")).toBeUndefined();
      expect(workflow.getPreviousStageId("stage-b")).toBe("stage-a");
      expect(workflow.getPreviousStageId("stage-c")).toBe("stage-b");
    });
  });

  describe("get all stages", () => {
    it("should return all stage nodes", () => {
      // Given: Workflow with 3 stages
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);
      const stageC = createPassthroughStage("stage-c", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "all-stages",
        "All Stages",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // When: I call getAllStages()
      const allStages = workflow.getAllStages();

      // Then: Returns all stage nodes
      expect(allStages).toHaveLength(3);
      expect(allStages[0].stage.id).toBe("stage-a");
      expect(allStages[1].stage.id).toBe("stage-b");
      expect(allStages[2].stage.id).toBe("stage-c");
    });

    it("should include execution group in stage nodes", () => {
      // Given: Workflow with parallel stages
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "groups-nodes",
        "Groups Nodes",
        "Test",
        TestSchemas.string,
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      // When: I call getAllStages()
      const allStages = workflow.getAllStages();

      // Then: Both stages have same execution group
      expect(allStages[0].executionGroup).toBe(allStages[1].executionGroup);
    });
  });
});
