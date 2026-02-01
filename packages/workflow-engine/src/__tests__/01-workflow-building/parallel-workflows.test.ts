/**
 * Parallel Workflow Building Tests
 *
 * Tests for creating workflows with parallel stage execution.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  createFixedOutputStage,
  createPassthroughStage,
  createTransformStage,
  TestSchemas,
} from "../utils/index.js";

describe("I want to create workflows with parallel stages", () => {
  describe("basic parallel execution", () => {
    it("should group parallel stages in same execution group", () => {
      // Given: Stages A, B, C for parallel execution
      const stageA = createPassthroughStage("stage-a", TestSchemas.string, {
        name: "Stage A",
      });
      const stageB = createPassthroughStage("stage-b", TestSchemas.string, {
        name: "Stage B",
      });
      const stageC = createPassthroughStage("stage-c", TestSchemas.string, {
        name: "Stage C",
      });

      // When: I use .parallel([A, B, C])
      const workflow = new WorkflowBuilder(
        "parallel-workflow",
        "Parallel Workflow",
        "Test parallel stages",
        TestSchemas.string,
        z.any(),
      )
        .parallel([stageA, stageB, stageC])
        .build();

      // Then: getExecutionPlan() returns [[A, B, C]] (single group)
      const plan = workflow.getExecutionPlan();
      expect(plan).toHaveLength(1);
      expect(plan[0]).toHaveLength(3);

      const stageIds = plan[0].map((node) => node.stage.id);
      expect(stageIds).toContain("stage-a");
      expect(stageIds).toContain("stage-b");
      expect(stageIds).toContain("stage-c");
    });

    it("should place stages before parallel in separate group", () => {
      // Given: Stage PREP, then parallel [A, B, C]
      const prepStage = createPassthroughStage("prep", TestSchemas.string, {
        name: "Prep Stage",
      });
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);
      const stageC = createPassthroughStage("stage-c", TestSchemas.string);

      // When: I build .pipe(PREP).parallel([A, B, C])
      const workflow = new WorkflowBuilder(
        "prep-parallel",
        "Prep + Parallel",
        "Test",
        TestSchemas.string,
        z.any(),
      )
        .pipe(prepStage)
        .parallel([stageA, stageB, stageC])
        .build();

      // Then: getExecutionPlan() returns [[PREP], [A, B, C]]
      const plan = workflow.getExecutionPlan();
      expect(plan).toHaveLength(2);

      // First group: just prep
      expect(plan[0]).toHaveLength(1);
      expect(plan[0][0].stage.id).toBe("prep");

      // Second group: parallel stages
      expect(plan[1]).toHaveLength(3);
      const parallelIds = plan[1].map((node) => node.stage.id);
      expect(parallelIds).toContain("stage-a");
      expect(parallelIds).toContain("stage-b");
      expect(parallelIds).toContain("stage-c");
    });

    it("should place stages after parallel in separate group", () => {
      // Given: Parallel [A, B], then AGGREGATE
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);
      const aggregateStage = createFixedOutputStage(
        "aggregate",
        TestSchemas.string,
        { value: "aggregated" },
        { name: "Aggregate Stage" },
      );

      // When: I build .parallel([A, B]).pipe(AGGREGATE)
      const workflow = new WorkflowBuilder(
        "parallel-aggregate",
        "Parallel + Aggregate",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .parallel([stageA, stageB])
        .pipe(aggregateStage)
        .build();

      // Then: getExecutionPlan() returns [[A, B], [AGGREGATE]]
      const plan = workflow.getExecutionPlan();
      expect(plan).toHaveLength(2);

      // First group: parallel stages
      expect(plan[0]).toHaveLength(2);
      const parallelIds = plan[0].map((node) => node.stage.id);
      expect(parallelIds).toContain("stage-a");
      expect(parallelIds).toContain("stage-b");

      // Second group: aggregate
      expect(plan[1]).toHaveLength(1);
      expect(plan[1][0].stage.id).toBe("aggregate");
    });
  });

  describe("parallel with sequential", () => {
    it("should handle sequential-parallel-sequential pattern", () => {
      // Given: LOAD -> [ANALYZE_A, ANALYZE_B] -> MERGE
      const loadStage = createPassthroughStage("load", TestSchemas.string, {
        name: "Load",
      });
      const analyzeA = createPassthroughStage("analyze-a", TestSchemas.string, {
        name: "Analyze A",
      });
      const analyzeB = createPassthroughStage("analyze-b", TestSchemas.string, {
        name: "Analyze B",
      });
      const mergeStage = createFixedOutputStage(
        "merge",
        TestSchemas.string,
        { value: "merged" },
        { name: "Merge" },
      );

      // When: I build that pattern
      const workflow = new WorkflowBuilder(
        "seq-par-seq",
        "Sequential-Parallel-Sequential",
        "Test mixed pattern",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(loadStage)
        .parallel([analyzeA, analyzeB])
        .pipe(mergeStage)
        .build();

      // Then: Execution plan is [[LOAD], [ANALYZE_A, ANALYZE_B], [MERGE]]
      const plan = workflow.getExecutionPlan();
      expect(plan).toHaveLength(3);

      // Group 1: LOAD
      expect(plan[0]).toHaveLength(1);
      expect(plan[0][0].stage.id).toBe("load");

      // Group 2: parallel analysis
      expect(plan[1]).toHaveLength(2);
      const parallelIds = plan[1].map((node) => node.stage.id);
      expect(parallelIds).toContain("analyze-a");
      expect(parallelIds).toContain("analyze-b");

      // Group 3: MERGE
      expect(plan[2]).toHaveLength(1);
      expect(plan[2][0].stage.id).toBe("merge");
    });

    it("should handle multiple parallel groups", () => {
      // Given: [A, B] -> C -> [D, E]
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);
      const stageC = createFixedOutputStage("stage-c", TestSchemas.string, {
        value: "c",
      });
      const stageD = createPassthroughStage("stage-d", TestSchemas.string);
      const stageE = createPassthroughStage("stage-e", TestSchemas.string);

      // When: I build
      const workflow = new WorkflowBuilder(
        "multi-parallel",
        "Multiple Parallel Groups",
        "Test",
        TestSchemas.string,
        z.any(),
      )
        .parallel([stageA, stageB])
        .pipe(stageC)
        .parallel([stageD, stageE])
        .build();

      // Then: Execution plan is [[A, B], [C], [D, E]]
      const plan = workflow.getExecutionPlan();
      expect(plan).toHaveLength(3);

      // Group 1: [A, B]
      expect(plan[0]).toHaveLength(2);
      const group1Ids = plan[0].map((node) => node.stage.id);
      expect(group1Ids).toContain("stage-a");
      expect(group1Ids).toContain("stage-b");

      // Group 2: [C]
      expect(plan[1]).toHaveLength(1);
      expect(plan[1][0].stage.id).toBe("stage-c");

      // Group 3: [D, E]
      expect(plan[2]).toHaveLength(2);
      const group3Ids = plan[2].map((node) => node.stage.id);
      expect(group3Ids).toContain("stage-d");
      expect(group3Ids).toContain("stage-e");
    });
  });

  describe("workflow queries with parallel stages", () => {
    it("should return all stage IDs including parallel stages", () => {
      // Given: Workflow with parallel stages
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);
      const stageC = createPassthroughStage("stage-c", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "parallel-ids",
        "Parallel IDs Test",
        "Test",
        TestSchemas.string,
        z.any(),
      )
        .pipe(stageA)
        .parallel([stageB, stageC])
        .build();

      // Then: getStageIds returns all IDs
      const ids = workflow.getStageIds();
      expect(ids).toContain("stage-a");
      expect(ids).toContain("stage-b");
      expect(ids).toContain("stage-c");
      expect(ids).toHaveLength(3);
    });

    it("should find individual stages in parallel groups", () => {
      // Given: Workflow with parallel stages
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string, {
        name: "Stage B Name",
        description: "Stage B Description",
      });

      const workflow = new WorkflowBuilder(
        "find-parallel",
        "Find Parallel Test",
        "Test",
        TestSchemas.string,
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      // Then: Can retrieve individual parallel stages
      const foundB = workflow.getStage("stage-b");
      expect(foundB).toBeDefined();
      expect(foundB?.name).toBe("Stage B Name");
      expect(foundB?.description).toBe("Stage B Description");
    });

    it("should check existence of parallel stages", () => {
      // Given: Workflow with parallel stages
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "has-parallel",
        "Has Parallel Test",
        "Test",
        TestSchemas.string,
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      // Then: hasStage works for parallel stages
      expect(workflow.hasStage("stage-a")).toBe(true);
      expect(workflow.hasStage("stage-b")).toBe(true);
      expect(workflow.hasStage("nonexistent")).toBe(false);
    });
  });
});
