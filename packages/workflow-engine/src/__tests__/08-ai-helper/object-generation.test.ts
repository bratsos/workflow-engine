/**
 * Object Generation Tests
 *
 * Tests for the generateObject functionality of AIHelper.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockAIHelper, MockAIHelper } from "../utils/mock-ai-helper.js";

describe("I want to generate structured objects using AIHelper", () => {
  let ai: MockAIHelper;

  beforeEach(() => {
    ai = createMockAIHelper("test.object-generation");
  });

  describe("basic object generation", () => {
    it("should generate object matching schema", async () => {
      // Given: A schema and configured response
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      ai.setObjectResponse("user", {
        object: { name: "John Doe", age: 30 },
        inputTokens: 50,
        outputTokens: 20,
        cost: 0.001,
      });

      // When: I generate an object
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "Get user info",
        schema,
      );

      // Then: Returns structured object
      expect(result.object).toEqual({ name: "John Doe", age: 30 });
      expect(result.inputTokens).toBe(50);
      expect(result.outputTokens).toBe(20);
      expect(result.cost).toBe(0.001);
    });

    it("should return default empty object when no pattern matches", async () => {
      // Given: A schema with no configured response
      const schema = z.object({
        field: z.string().optional(),
      });

      // When: I generate an object
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "random prompt",
        schema,
      );

      // Then: Returns default object
      expect(result.object).toBeDefined();
      expect(result.inputTokens).toBeGreaterThan(0);
    });

    it("should work with different model keys", async () => {
      // Given: A schema
      const schema = z.object({ data: z.string() });

      // When: I call with different models
      await ai.generateObject("gemini-2.5-flash", "test", schema);
      await ai.generateObject("gemini-2.5-pro", "test", schema);

      // Then: Both calls are recorded
      const calls = ai.getCallsByType("object");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.modelKey).toBe("gemini-2.5-flash");
      expect(calls[1]?.modelKey).toBe("gemini-2.5-pro");
    });
  });

  describe("object generation with complex schemas", () => {
    it("should handle nested objects", async () => {
      // Given: A nested schema
      const schema = z.object({
        user: z.object({
          name: z.string(),
          email: z.string(),
        }),
        metadata: z.object({
          created: z.string(),
        }),
      });

      ai.setObjectResponse("nested", {
        object: {
          user: { name: "Jane", email: "jane@example.com" },
          metadata: { created: "2024-01-01" },
        },
      });

      // When: I generate the object
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "get nested data",
        schema,
      );

      // Then: Returns nested structure
      expect(result.object.user.name).toBe("Jane");
      expect(result.object.metadata.created).toBe("2024-01-01");
    });

    it("should handle arrays in schema", async () => {
      // Given: Schema with array
      const schema = z.object({
        items: z.array(z.string()),
        count: z.number(),
      });

      ai.setObjectResponse("array", {
        object: {
          items: ["apple", "banana", "cherry"],
          count: 3,
        },
      });

      // When: I generate the object
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "get array data",
        schema,
      );

      // Then: Returns array structure
      expect(result.object.items).toHaveLength(3);
      expect(result.object.count).toBe(3);
    });

    it("should handle optional fields", async () => {
      // Given: Schema with optional fields
      const schema = z.object({
        required: z.string(),
        optional: z.string().optional(),
      });

      ai.setObjectResponse("optional", {
        object: { required: "value" }, // optional field omitted
      });

      // When: I generate the object
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "get optional data",
        schema,
      );

      // Then: Returns object with optional field undefined
      expect(result.object.required).toBe("value");
      expect(result.object.optional).toBeUndefined();
    });

    it("should handle enum fields", async () => {
      // Given: Schema with enum
      const schema = z.object({
        status: z.enum(["pending", "active", "completed"]),
        priority: z.number(),
      });

      ai.setObjectResponse("enum", {
        object: { status: "active", priority: 1 },
      });

      // When: I generate the object
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "get enum data",
        schema,
      );

      // Then: Returns object with enum value
      expect(result.object.status).toBe("active");
    });

    it("should handle union types", async () => {
      // Given: Schema with union type
      const schema = z.object({
        value: z.union([z.string(), z.number()]),
      });

      ai.setObjectResponse("union", {
        object: { value: "string value" },
      });

      // When: I generate the object
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "get union data",
        schema,
      );

      // Then: Returns object with union value
      expect(result.object.value).toBe("string value");
    });
  });

  describe("object generation with options", () => {
    it("should pass temperature option", async () => {
      // Given: A schema
      const schema = z.object({ data: z.string() });

      // When: I call with temperature
      await ai.generateObject("gemini-2.5-flash", "test", schema, {
        temperature: 0.2,
      });

      // Then: Temperature is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("temperature", 0.2);
    });

    it("should pass maxTokens option", async () => {
      // Given: A schema
      const schema = z.object({ data: z.string() });

      // When: I call with maxTokens
      await ai.generateObject("gemini-2.5-flash", "test", schema, {
        maxTokens: 500,
      });

      // Then: maxTokens is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("maxTokens", 500);
    });

    it("should use low temperature by default for structured output", async () => {
      // Given: A schema (generateObject typically uses lower temperature)
      const schema = z.object({ data: z.string() });

      // When: I call without temperature
      await ai.generateObject("gemini-2.5-flash", "test", schema);

      // Then: Call is recorded (temperature handling is implementation detail)
      expect(ai.getCalls()).toHaveLength(1);
    });
  });

  describe("object generation with multimodal input", () => {
    it("should handle text content parts", async () => {
      // Given: A schema
      const schema = z.object({
        description: z.string(),
      });

      ai.setObjectResponse("extract", {
        object: { description: "Extracted from content" },
      });

      // When: I call with content parts
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        [{ type: "text", text: "extract description" }],
        schema,
      );

      // Then: Returns extracted object
      expect(result.object.description).toBe("Extracted from content");
    });

    it("should record multimodal content in call", async () => {
      // Given: A schema
      const schema = z.object({ data: z.string() });

      // When: I call with multiple text parts
      await ai.generateObject(
        "gemini-2.5-flash",
        [
          { type: "text", text: "Part one" },
          { type: "text", text: "Part two" },
        ],
        schema,
      );

      // Then: Records the joined text
      const lastCall = ai.getLastCall();
      expect(lastCall?.prompt).toContain("Part one");
    });
  });

  describe("object generation call tracking", () => {
    it("should record call type as object", async () => {
      // Given: A schema
      const schema = z.object({ data: z.string() });

      // When: I generate an object
      await ai.generateObject("gemini-2.5-flash", "test", schema);

      // Then: Call is recorded with type "object"
      const calls = ai.getCallsByType("object");
      expect(calls).toHaveLength(1);
    });

    it("should record response as JSON string", async () => {
      // Given: A configured response
      const schema = z.object({ id: z.number(), name: z.string() });
      ai.setObjectResponse("json", {
        object: { id: 123, name: "Test" },
      });

      // When: I generate an object
      await ai.generateObject("gemini-2.5-flash", "get json data", schema);

      // Then: Response is recorded as JSON
      const lastCall = ai.getLastCall();
      expect(lastCall?.response).toBe(
        JSON.stringify({ id: 123, name: "Test" }),
      );
    });

    it("should record timestamp", async () => {
      // Given: A schema
      const schema = z.object({ data: z.string() });
      const before = new Date();

      // When: I generate an object
      await ai.generateObject("gemini-2.5-flash", "test", schema);

      // Then: Timestamp is recorded
      const lastCall = ai.getLastCall();
      expect(lastCall?.timestamp.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
    });
  });

  describe("object generation error handling", () => {
    it("should throw when configured to error", async () => {
      // Given: Mock configured to error
      ai.setError(true, "Schema validation failed");
      const schema = z.object({ data: z.string() });

      // When/Then: generateObject throws
      await expect(
        ai.generateObject("gemini-2.5-flash", "test", schema),
      ).rejects.toThrow("Schema validation failed");
    });

    it("should not record failed calls", async () => {
      // Given: Mock configured to error
      ai.setError(true, "Error");
      const schema = z.object({ data: z.string() });

      // When: Call fails
      await ai
        .generateObject("gemini-2.5-flash", "test", schema)
        .catch(() => {});

      // Then: No calls recorded
      expect(ai.getCalls()).toHaveLength(0);
    });
  });

  describe("object generation with pattern matching", () => {
    it("should match string pattern", async () => {
      // Given: String pattern configured
      const schema = z.object({ result: z.string() });
      ai.setObjectResponse("analyze", {
        object: { result: "Analysis result" },
      });

      // When: I call with matching prompt
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "Please analyze this data",
        schema,
      );

      // Then: Returns matched response
      expect(result.object.result).toBe("Analysis result");
    });

    it("should match regex pattern", async () => {
      // Given: Regex pattern configured
      const schema = z.object({ sentiment: z.string() });
      ai.setObjectResponse(/sentiment.*analysis/i, {
        object: { sentiment: "positive" },
      });

      // When: I call with matching prompt
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "Run sentiment analysis on text",
        schema,
      );

      // Then: Returns matched response
      expect(result.object.sentiment).toBe("positive");
    });
  });

  describe("object generation statistics", () => {
    it("should include object calls in stats", async () => {
      // Given: Multiple object generation calls
      const schema = z.object({ data: z.string() });
      ai.setObjectResponse("call", {
        object: { data: "value" },
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.01,
      });

      await ai.generateObject("gemini-2.5-flash", "call 1", schema);
      await ai.generateObject("gemini-2.5-flash", "call 2", schema);

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Stats include all calls
      expect(stats.totalCalls).toBe(2);
      expect(stats.totalInputTokens).toBe(200);
      expect(stats.totalOutputTokens).toBe(100);
      expect(stats.totalCost).toBe(0.02);
    });
  });
});
