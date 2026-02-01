/**
 * Schema Helpers Tests
 *
 * Tests for requireStageOutput, getStageOutput, and NoInputSchema.
 */

import { describe, expect, it } from "vitest";
import {
  getStageOutput,
  NoInputSchema,
  requireStageOutput,
} from "../../core/schema-helpers.js";

describe("I want to use schema helpers to access stage outputs", () => {
  describe("NoInputSchema", () => {
    it("should parse empty object", () => {
      // Given: NoInputSchema
      // When: I parse an empty object
      const result = NoInputSchema.parse({});

      // Then: Returns empty object
      expect(result).toEqual({});
    });

    it("should strip extra properties", () => {
      // Given: NoInputSchema
      // When: I parse an object with extra properties
      const result = NoInputSchema.parse({ foo: "bar" });

      // Then: Returns empty object (extra properties stripped)
      expect(result).toEqual({});
    });
  });

  describe("requireStageOutput", () => {
    describe("full output access", () => {
      it("should return stage output when present", () => {
        // Given: A workflow context with stage output
        const workflowContext: Record<string, unknown> = {
          "data-extraction": { text: "extracted content", pages: 5 },
        };

        // When: I require the stage output
        const output = requireStageOutput<{ text: string; pages: number }>(
          workflowContext,
          "data-extraction",
        );

        // Then: Returns the full output
        expect(output).toEqual({ text: "extracted content", pages: 5 });
      });

      it("should throw when stage output is missing", () => {
        // Given: An empty workflow context
        const workflowContext: Record<string, unknown> = {};

        // When/Then: Requiring missing stage throws
        expect(() =>
          requireStageOutput(workflowContext, "missing-stage"),
        ).toThrow("Missing output from required stage: missing-stage");
      });

      it("should include available stages in error message", () => {
        // Given: A workflow context with some stages
        const workflowContext: Record<string, unknown> = {
          "stage-a": { value: 1 },
          "stage-b": { value: 2 },
        };

        // When/Then: Error includes available stages
        expect(() => requireStageOutput(workflowContext, "stage-c")).toThrow(
          "Available stages: stage-a, stage-b",
        );
      });
    });

    describe("field access", () => {
      it("should return specific field when present", () => {
        // Given: A workflow context with stage output containing fields
        const workflowContext: Record<string, unknown> = {
          guidelines: {
            guidelines: [
              { id: "g1", text: "Guideline 1" },
              { id: "g2", text: "Guideline 2" },
            ],
            metadata: { count: 2 },
          },
        };

        // When: I require a specific field
        const guidelines = requireStageOutput<
          Array<{ id: string; text: string }>
        >(workflowContext, "guidelines", "guidelines");

        // Then: Returns just that field
        expect(guidelines).toEqual([
          { id: "g1", text: "Guideline 1" },
          { id: "g2", text: "Guideline 2" },
        ]);
      });

      it("should throw when field is missing", () => {
        // Given: A workflow context with stage output
        const workflowContext: Record<string, unknown> = {
          "my-stage": { existingField: "value" },
        };

        // When/Then: Requiring missing field throws
        expect(() =>
          requireStageOutput(workflowContext, "my-stage", "missingField"),
        ).toThrow("Missing required field 'missingField' in my-stage output");
      });

      it("should include available fields in error message", () => {
        // Given: A workflow context with stage output
        const workflowContext: Record<string, unknown> = {
          "my-stage": { fieldA: 1, fieldB: 2 },
        };

        // When/Then: Error includes available fields
        expect(() =>
          requireStageOutput(workflowContext, "my-stage", "fieldC"),
        ).toThrow("Available fields: fieldA, fieldB");
      });

      it("should throw when accessing field on non-object output", () => {
        // Given: A workflow context with primitive output
        const workflowContext: Record<string, unknown> = {
          "primitive-stage": "just a string",
        };

        // When/Then: Accessing field on non-object throws
        expect(() =>
          requireStageOutput(workflowContext, "primitive-stage", "field"),
        ).toThrow("output is not an object, cannot access field 'field'");
      });

      it("should throw when accessing field on null output", () => {
        // Given: A workflow context with null output
        // Note: null is treated as falsy, so it throws "Missing output" not "not an object"
        const workflowContext: Record<string, unknown> = {
          "null-stage": null,
        };

        // When/Then: Accessing field on null throws (null is falsy, so treated as missing)
        expect(() =>
          requireStageOutput(workflowContext, "null-stage", "field"),
        ).toThrow("Missing output from required stage: null-stage");
      });
    });
  });

  describe("getStageOutput", () => {
    describe("full output access", () => {
      it("should return stage output when present", () => {
        // Given: A workflow context with stage output
        const workflowContext: Record<string, unknown> = {
          "optional-stage": { data: "some data" },
        };

        // When: I get the optional stage output
        const output = getStageOutput<{ data: string }>(
          workflowContext,
          "optional-stage",
        );

        // Then: Returns the output
        expect(output).toEqual({ data: "some data" });
      });

      it("should return undefined when stage output is missing", () => {
        // Given: An empty workflow context
        const workflowContext: Record<string, unknown> = {};

        // When: I get a missing stage output
        const output = getStageOutput(workflowContext, "missing-stage");

        // Then: Returns undefined
        expect(output).toBeUndefined();
      });

      it("should return undefined when stage output is explicitly undefined", () => {
        // Given: A workflow context with undefined output
        const workflowContext: Record<string, unknown> = {
          "undefined-stage": undefined,
        };

        // When: I get the output
        const output = getStageOutput(workflowContext, "undefined-stage");

        // Then: Returns undefined
        expect(output).toBeUndefined();
      });
    });

    describe("field access", () => {
      it("should return specific field when present", () => {
        // Given: A workflow context with stage output containing fields
        const workflowContext: Record<string, unknown> = {
          "multi-field-stage": {
            items: [1, 2, 3],
            count: 3,
            metadata: { source: "test" },
          },
        };

        // When: I get a specific field
        const items = getStageOutput<number[]>(
          workflowContext,
          "multi-field-stage",
          "items",
        );

        // Then: Returns just that field
        expect(items).toEqual([1, 2, 3]);
      });

      it("should return undefined when field is missing", () => {
        // Given: A workflow context with stage output
        const workflowContext: Record<string, unknown> = {
          "my-stage": { existingField: "value" },
        };

        // When: I get a missing field
        const value = getStageOutput(
          workflowContext,
          "my-stage",
          "missingField",
        );

        // Then: Returns undefined (not throw)
        expect(value).toBeUndefined();
      });

      it("should return undefined when accessing field on non-object output", () => {
        // Given: A workflow context with primitive output
        const workflowContext: Record<string, unknown> = {
          "primitive-stage": 42,
        };

        // When: I get a field from primitive output
        const value = getStageOutput(
          workflowContext,
          "primitive-stage",
          "field",
        );

        // Then: Returns undefined (not throw)
        expect(value).toBeUndefined();
      });

      it("should return undefined when accessing field on null output", () => {
        // Given: A workflow context with null output
        const workflowContext: Record<string, unknown> = {
          "null-stage": null,
        };

        // When: I get a field from null output
        const value = getStageOutput(workflowContext, "null-stage", "field");

        // Then: Returns undefined
        expect(value).toBeUndefined();
      });
    });
  });

  describe("real-world usage patterns", () => {
    it("should support typed extraction from workflow context", () => {
      // Given: A realistic workflow context
      interface ExtractionOutput {
        text: string;
        tables: Array<{ headers: string[]; rows: string[][] }>;
        metadata: { pageCount: number; wordCount: number };
      }

      interface GuidelinesOutput {
        guidelines: Array<{ id: string; text: string; priority: number }>;
      }

      const workflowContext: Record<string, unknown> = {
        "pdf-extraction": {
          text: "Document content...",
          tables: [{ headers: ["Name", "Value"], rows: [["Item1", "100"]] }],
          metadata: { pageCount: 10, wordCount: 5000 },
        },
        guidelines: {
          guidelines: [
            { id: "g1", text: "Guideline 1", priority: 1 },
            { id: "g2", text: "Guideline 2", priority: 2 },
          ],
        },
      };

      // When: I access multiple stages
      const extraction = requireStageOutput<ExtractionOutput>(
        workflowContext,
        "pdf-extraction",
      );
      const guidelines = requireStageOutput<GuidelinesOutput["guidelines"]>(
        workflowContext,
        "guidelines",
        "guidelines",
      );

      // Then: Data is correctly typed and accessible
      expect(extraction.metadata.pageCount).toBe(10);
      expect(guidelines).toHaveLength(2);
      expect(guidelines[0]?.priority).toBe(1);
    });

    it("should support conditional stage access", () => {
      // Given: A workflow context where optional stage may not exist
      const workflowContext: Record<string, unknown> = {
        "required-stage": { value: "required data" },
        // "optional-enrichment" not present
      };

      // When: I conditionally access stages
      const required = requireStageOutput<{ value: string }>(
        workflowContext,
        "required-stage",
      );
      const optional = getStageOutput<{ enrichedValue: string }>(
        workflowContext,
        "optional-enrichment",
      );

      // Then: Required exists, optional is undefined
      expect(required.value).toBe("required data");
      expect(optional).toBeUndefined();

      // And: I can use conditional logic
      const finalValue = optional?.enrichedValue ?? required.value;
      expect(finalValue).toBe("required data");
    });
  });
});
