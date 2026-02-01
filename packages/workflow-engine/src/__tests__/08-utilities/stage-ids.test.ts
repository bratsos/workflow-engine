/**
 * Stage IDs Tests
 *
 * Tests for stage ID utilities: createStageIds, defineStageIds, isValidStageId, assertValidStageId.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import {
  assertValidStageId,
  createStageIds,
  defineStageIds,
  isValidStageId,
} from "../../core/stage-ids.js";
import { WorkflowBuilder } from "../../core/workflow.js";

// Helper to create a test stage
function createTestStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: {
      input: z.object({}).passthrough(),
      output: z.object({}),
      config: z.object({}),
    },
    async execute() {
      return { output: {} };
    },
  });
}

describe("I want to use type-safe stage IDs", () => {
  describe("createStageIds", () => {
    it("should create constants from workflow stages", () => {
      // Given: A workflow with multiple stages
      const workflow = new WorkflowBuilder(
        "test-workflow",
        "Test Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage("data-extraction"))
        .pipe(createTestStage("guidelines"))
        .pipe(createTestStage("generator"))
        .build();

      // When: I create stage IDs
      const STAGE_IDS = createStageIds(workflow);

      // Then: Constants are created with SCREAMING_SNAKE_CASE keys
      expect(STAGE_IDS.DATA_EXTRACTION).toBe("data-extraction");
      expect(STAGE_IDS.GUIDELINES).toBe("guidelines");
      expect(STAGE_IDS.GENERATOR).toBe("generator");
    });

    it("should handle multi-word kebab-case IDs", () => {
      // Given: A workflow with complex stage IDs
      const workflow = new WorkflowBuilder(
        "complex-workflow",
        "Complex Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage("unified-smart-retrieval"))
        .pipe(createTestStage("analysis-synthesis"))
        .pipe(createTestStage("legal-guidance-extraction"))
        .build();

      // When: I create stage IDs
      const STAGE_IDS = createStageIds(workflow);

      // Then: Multi-word IDs are converted correctly
      expect(STAGE_IDS.UNIFIED_SMART_RETRIEVAL).toBe("unified-smart-retrieval");
      expect(STAGE_IDS.ANALYSIS_SYNTHESIS).toBe("analysis-synthesis");
      expect(STAGE_IDS.LEGAL_GUIDANCE_EXTRACTION).toBe(
        "legal-guidance-extraction",
      );
    });

    it("should return frozen object", () => {
      // Given: A workflow
      const workflow = new WorkflowBuilder(
        "frozen-test",
        "Frozen Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage("stage-one"))
        .build();

      // When: I create stage IDs
      const STAGE_IDS = createStageIds(workflow);

      // Then: Object is frozen
      expect(Object.isFrozen(STAGE_IDS)).toBe(true);
    });
  });

  describe("defineStageIds", () => {
    it("should create constants from string array", () => {
      // Given: An array of stage IDs
      const stageIds = ["data-extraction", "guidelines", "generator"] as const;

      // When: I define stage IDs
      const STAGE_IDS = defineStageIds(stageIds);

      // Then: Constants are created
      expect(STAGE_IDS.DATA_EXTRACTION).toBe("data-extraction");
      expect(STAGE_IDS.GUIDELINES).toBe("guidelines");
      expect(STAGE_IDS.GENERATOR).toBe("generator");
    });

    it("should handle complex IDs", () => {
      // Given: Complex stage IDs
      const stageIds = [
        "pdf-text-extraction",
        "multi-step-analysis",
        "a-b-c-d-e",
      ] as const;

      // When: I define stage IDs
      const STAGE_IDS = defineStageIds(stageIds);

      // Then: All hyphens are converted to underscores
      expect(STAGE_IDS.PDF_TEXT_EXTRACTION).toBe("pdf-text-extraction");
      expect(STAGE_IDS.MULTI_STEP_ANALYSIS).toBe("multi-step-analysis");
      expect(STAGE_IDS.A_B_C_D_E).toBe("a-b-c-d-e");
    });

    it("should return frozen object", () => {
      // Given: Stage IDs
      const STAGE_IDS = defineStageIds(["stage-one"] as const);

      // Then: Object is frozen
      expect(Object.isFrozen(STAGE_IDS)).toBe(true);
    });

    it("should work with single stage", () => {
      // Given: A single stage ID
      const STAGE_IDS = defineStageIds(["only-stage"] as const);

      // Then: Works correctly
      expect(STAGE_IDS.ONLY_STAGE).toBe("only-stage");
      expect(Object.keys(STAGE_IDS)).toHaveLength(1);
    });
  });

  describe("isValidStageId", () => {
    it("should return true for valid stage ID", () => {
      // Given: A workflow with stages
      const workflow = new WorkflowBuilder(
        "valid-test",
        "Valid Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage("existing-stage"))
        .build();

      // When: I check a valid stage ID
      const isValid = isValidStageId(workflow, "existing-stage");

      // Then: Returns true
      expect(isValid).toBe(true);
    });

    it("should return false for invalid stage ID", () => {
      // Given: A workflow with stages
      const workflow = new WorkflowBuilder(
        "invalid-test",
        "Invalid Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage("real-stage"))
        .build();

      // When: I check an invalid stage ID
      const isValid = isValidStageId(workflow, "non-existent-stage");

      // Then: Returns false
      expect(isValid).toBe(false);
    });

    it("should work as type guard", () => {
      // Given: A workflow
      const workflow = new WorkflowBuilder(
        "guard-test",
        "Guard Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage("my-stage"))
        .build();

      // When: I use it as a type guard
      const stageId: string = "my-stage";
      if (isValidStageId(workflow, stageId)) {
        // Then: TypeScript knows stageId is valid
        expect(stageId).toBe("my-stage");
      }
    });
  });

  describe("assertValidStageId", () => {
    it("should not throw for valid stage ID", () => {
      // Given: A workflow with stages
      const workflow = new WorkflowBuilder(
        "assert-valid",
        "Assert Valid",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage("valid-stage"))
        .build();

      // When/Then: Does not throw for valid ID
      expect(() => assertValidStageId(workflow, "valid-stage")).not.toThrow();
    });

    it("should throw for invalid stage ID", () => {
      // Given: A workflow with stages
      const workflow = new WorkflowBuilder(
        "assert-invalid",
        "Assert Invalid",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage("only-stage"))
        .build();

      // When/Then: Throws for invalid ID
      expect(() => assertValidStageId(workflow, "wrong-stage")).toThrow(
        /Invalid stage ID: "wrong-stage"/,
      );
    });

    it("should include workflow ID in error message", () => {
      // Given: A workflow
      const workflow = new WorkflowBuilder(
        "my-workflow-id",
        "My Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage("stage-a"))
        .build();

      // When/Then: Error includes workflow ID
      expect(() => assertValidStageId(workflow, "invalid")).toThrow(
        /workflow "my-workflow-id"/,
      );
    });

    it("should include valid stage IDs in error message", () => {
      // Given: A workflow with multiple stages
      const workflow = new WorkflowBuilder(
        "error-msg-test",
        "Error Msg Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage("stage-one"))
        .pipe(createTestStage("stage-two"))
        .pipe(createTestStage("stage-three"))
        .build();

      // When/Then: Error includes all valid IDs
      try {
        assertValidStageId(workflow, "wrong");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("stage-one");
        expect(message).toContain("stage-two");
        expect(message).toContain("stage-three");
      }
    });
  });

  describe("real-world usage patterns", () => {
    it("should support defining IDs before building workflow", () => {
      // Given: Stage IDs defined first
      const CERTIFICATE_STAGES = defineStageIds([
        "data-extraction",
        "guidelines",
        "generator",
      ] as const);

      // When: I build a workflow using those IDs
      const workflow = new WorkflowBuilder(
        "certificate",
        "Certificate Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage(CERTIFICATE_STAGES.DATA_EXTRACTION))
        .pipe(createTestStage(CERTIFICATE_STAGES.GUIDELINES))
        .pipe(createTestStage(CERTIFICATE_STAGES.GENERATOR))
        .build();

      // Then: Workflow has all the stages
      expect(workflow.hasStage(CERTIFICATE_STAGES.DATA_EXTRACTION)).toBe(true);
      expect(workflow.hasStage(CERTIFICATE_STAGES.GUIDELINES)).toBe(true);
      expect(workflow.hasStage(CERTIFICATE_STAGES.GENERATOR)).toBe(true);
    });

    it("should support validating user input stage IDs", () => {
      // Given: A workflow
      const workflow = new WorkflowBuilder(
        "user-input-test",
        "User Input Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(createTestStage("stage-a"))
        .pipe(createTestStage("stage-b"))
        .build();

      // When: I validate user input
      const userInput = "stage-a";
      const invalidInput = "stage-c";

      // Then: Can distinguish valid from invalid
      expect(isValidStageId(workflow, userInput)).toBe(true);
      expect(isValidStageId(workflow, invalidInput)).toBe(false);
    });
  });
});
