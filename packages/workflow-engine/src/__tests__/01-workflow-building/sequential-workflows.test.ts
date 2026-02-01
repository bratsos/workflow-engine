/**
 * Sequential Workflow Building Tests
 *
 * Tests for creating and configuring sequential workflows using the WorkflowBuilder API.
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

describe("I want to create sequential workflows", () => {
  describe("basic sequential workflow", () => {
    it("should create a workflow with a single stage", () => {
      // Given: A single stage definition
      const stage = createPassthroughStage("stage-a", TestSchemas.string);

      // When: I build a workflow with that stage
      const workflow = new WorkflowBuilder(
        "single-stage",
        "Single Stage Workflow",
        "A workflow with one stage",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      // Then: The workflow has 1 stage and 1 execution group
      expect(workflow.getStageIds()).toHaveLength(1);
      expect(workflow.getStageIds()).toContain("stage-a");

      const plan = workflow.getExecutionPlan();
      expect(plan).toHaveLength(1);
      expect(plan[0]).toHaveLength(1);
    });

    it("should create a workflow with multiple sequential stages", () => {
      // Given: Three stage definitions
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);
      const stageC = createPassthroughStage("stage-c", TestSchemas.string);

      // When: I pipe them sequentially
      const workflow = new WorkflowBuilder(
        "multi-stage",
        "Multi Stage Workflow",
        "A workflow with three stages",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // Then: The workflow has 3 stages in 3 execution groups
      expect(workflow.getStageIds()).toHaveLength(3);
      expect(workflow.getStageIds()).toEqual(["stage-a", "stage-b", "stage-c"]);

      const plan = workflow.getExecutionPlan();
      expect(plan).toHaveLength(3);
      // Each group should have exactly 1 stage (sequential)
      expect(plan.every((group) => group.length === 1)).toBe(true);
    });

    it("should preserve stage order in execution plan", () => {
      // Given: Stages A, B, C
      const stageA = createPassthroughStage("stage-a", TestSchemas.string, {
        name: "Stage A",
      });
      const stageB = createPassthroughStage("stage-b", TestSchemas.string, {
        name: "Stage B",
      });
      const stageC = createPassthroughStage("stage-c", TestSchemas.string, {
        name: "Stage C",
      });

      // When: I build .pipe(A).pipe(B).pipe(C)
      const workflow = new WorkflowBuilder(
        "ordered",
        "Ordered Workflow",
        "Test order",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // Then: getExecutionPlan() returns [[A], [B], [C]]
      const plan = workflow.getExecutionPlan();
      expect(plan[0][0].stage.id).toBe("stage-a");
      expect(plan[1][0].stage.id).toBe("stage-b");
      expect(plan[2][0].stage.id).toBe("stage-c");
    });
  });

  describe("type safety", () => {
    it("should allow stages with compatible input/output types", () => {
      // Given: Stage A outputs { name: string }, Stage B inputs { name: string }
      const nameSchema = z.object({ name: z.string() });

      const stageA = createTransformStage(
        "stage-a",
        TestSchemas.string,
        nameSchema,
        (input) => ({ name: input.value }),
      );

      const stageB = createTransformStage(
        "stage-b",
        nameSchema,
        z.object({ greeting: z.string() }),
        (input) => ({ greeting: `Hello, ${input.name}!` }),
      );

      // When: I pipe them
      const workflow = new WorkflowBuilder(
        "typed",
        "Typed Workflow",
        "Test types",
        TestSchemas.string,
        z.object({ greeting: z.string() }),
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      // Then: Build succeeds with correct type inference
      expect(workflow).toBeDefined();
      expect(workflow.getStageIds()).toEqual(["stage-a", "stage-b"]);
    });

    it("should infer correct workflow input type", () => {
      // Given: First stage expects { userId: string }
      const userIdSchema = z.object({ userId: z.string() });

      const stage = createPassthroughStage("user-stage", userIdSchema);

      // When: I build the workflow
      const workflow = new WorkflowBuilder(
        "user-workflow",
        "User Workflow",
        "Test input type",
        userIdSchema,
        userIdSchema,
      )
        .pipe(stage)
        .build();

      // Then: Workflow input type is { userId: string }
      // This is a compile-time check - if it compiles, the type is correct
      expect(workflow.inputSchema).toBeDefined();
      // Verify the schema accepts the right shape
      const validInput = { userId: "123" };
      expect(workflow.inputSchema.parse(validInput)).toEqual(validInput);
    });

    it("should infer correct workflow output type", () => {
      // Given: Last stage outputs { result: number }
      const inputSchema = z.object({ value: z.string() });
      const outputSchema = z.object({ result: z.number() });

      const stage = createTransformStage(
        "transform",
        inputSchema,
        outputSchema,
        (input) => ({ result: input.value.length }),
      );

      // When: I build the workflow
      const workflow = new WorkflowBuilder(
        "result-workflow",
        "Result Workflow",
        "Test output type",
        inputSchema,
        outputSchema,
      )
        .pipe(stage)
        .build();

      // Then: Workflow output type is { result: number }
      expect(workflow.outputSchema).toBeDefined();
      // Verify the schema accepts the right shape
      const validOutput = { result: 42 };
      expect(workflow.outputSchema.parse(validOutput)).toEqual(validOutput);
    });
  });

  describe("workflow metadata", () => {
    it("should set workflow id, name, and description", () => {
      // Given: Builder with "my-workflow", "My Workflow", "Description"
      const stage = createPassthroughStage("stage-a", TestSchemas.string);

      // When: I build
      const workflow = new WorkflowBuilder(
        "my-workflow",
        "My Workflow",
        "This is a test workflow description",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      // Then: workflow.id, workflow.name, workflow.description are set
      expect(workflow.id).toBe("my-workflow");
      expect(workflow.name).toBe("My Workflow");
      expect(workflow.description).toBe("This is a test workflow description");
    });

    it("should return correct stage count", () => {
      // Given: 5 stages
      const stages = Array.from({ length: 5 }, (_, i) =>
        createPassthroughStage(`stage-${i + 1}`, TestSchemas.string),
      );

      // When: I build and query getStageCount() equivalent
      let builder = new WorkflowBuilder(
        "five-stages",
        "Five Stages",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      );

      for (const stage of stages) {
        builder = builder.pipe(stage) as typeof builder;
      }

      const workflow = builder.build();

      // Then: Returns 5
      expect(workflow.getStageIds().length).toBe(5);
      expect(workflow.getAllStages().length).toBe(5);
    });

    it("should store stage descriptions", () => {
      // Given: Stage with description
      const stage = createPassthroughStage(
        "described-stage",
        TestSchemas.string,
        {
          name: "Described Stage",
          description: "This stage does something important",
        },
      );

      // When: I build and retrieve the stage
      const workflow = new WorkflowBuilder(
        "described",
        "Described Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      // Then: Stage description is preserved
      const retrievedStage = workflow.getStage("described-stage");
      expect(retrievedStage).toBeDefined();
      expect(retrievedStage?.name).toBe("Described Stage");
      expect(retrievedStage?.description).toBe(
        "This stage does something important",
      );
    });
  });
});
