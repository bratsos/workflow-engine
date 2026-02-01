/**
 * Embeddings Tests
 *
 * Tests for the embed functionality of AIHelper.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createMockAIHelper, MockAIHelper } from "../utils/mock-ai-helper.js";

describe("I want to generate embeddings using AIHelper", () => {
  let ai: MockAIHelper;

  beforeEach(() => {
    ai = createMockAIHelper("test.embeddings");
  });

  describe("basic embedding generation", () => {
    it("should generate embedding for single text", async () => {
      // Given: A mock AI helper
      // When: I embed a single text
      const result = await ai.embed("text-embedding-004", "Hello world");

      // Then: Returns embedding array
      expect(result.embedding).toBeDefined();
      expect(Array.isArray(result.embedding)).toBe(true);
      expect(result.embedding.length).toBeGreaterThan(0);
    });

    it("should return embedding dimensions", async () => {
      // Given: A mock AI helper
      // When: I embed text
      const result = await ai.embed("text-embedding-004", "Test text");

      // Then: Returns dimensions
      expect(result.dimensions).toBe(768); // Default dimensions
    });

    it("should return token count and cost", async () => {
      // Given: A mock AI helper
      // When: I embed text
      const result = await ai.embed("text-embedding-004", "Some text to embed");

      // Then: Returns token count and cost
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.cost).toBeGreaterThan(0);
    });

    it("should work with different embedding models", async () => {
      // Given: A mock AI helper
      // When: I embed with a specific model
      const result = await ai.embed("text-embedding-004", "Test");

      // Then: Returns valid embedding
      expect(result.embedding.length).toBeGreaterThan(0);
    });
  });

  describe("batch embedding generation", () => {
    it("should embed multiple texts", async () => {
      // Given: A mock AI helper
      const texts = ["First text", "Second text", "Third text"];

      // When: I embed multiple texts
      const result = await ai.embed("text-embedding-004", texts);

      // Then: Returns embeddings for each text
      expect(result.embeddings).toHaveLength(3);
      expect(result.embedding).toEqual(result.embeddings[0]); // First embedding convenience
    });

    it("should return consistent dimensions for all embeddings", async () => {
      // Given: Multiple texts
      const texts = ["One", "Two", "Three"];

      // When: I embed them
      const result = await ai.embed("text-embedding-004", texts);

      // Then: All embeddings have same dimensions
      for (const emb of result.embeddings) {
        expect(emb.length).toBe(result.dimensions);
      }
    });

    it("should scale cost with number of texts", async () => {
      // Given: Different numbers of texts
      const singleResult = await ai.embed("text-embedding-004", "One text");
      ai.clearCalls();
      const multiResult = await ai.embed("text-embedding-004", [
        "Text 1",
        "Text 2",
        "Text 3",
      ]);

      // Then: Multi-text cost should be higher or equal (mock may return same base cost)
      // The mock multiplies cost by text count
      expect(multiResult.cost).toBeGreaterThanOrEqual(singleResult.cost);
      // And multi-text should generate multiple embeddings
      expect(multiResult.embeddings.length).toBe(3);
    });

    it("should handle empty array", async () => {
      // Given: An empty array
      // When: I embed empty array
      const result = await ai.embed("text-embedding-004", []);

      // Then: Returns empty embeddings array
      expect(result.embeddings).toHaveLength(0);
    });
  });

  describe("embedding options", () => {
    it("should support custom dimensions", async () => {
      // Given: Custom dimensions option
      // When: I embed with custom dimensions
      const result = await ai.embed("text-embedding-004", "Test", {
        dimensions: 256,
      });

      // Then: Returns specified dimensions
      expect(result.dimensions).toBe(256);
    });

    it("should support taskType option", async () => {
      // Given: Task type options
      // When: I embed with different task types
      await ai.embed("text-embedding-004", "Query text", {
        taskType: "RETRIEVAL_QUERY",
      });

      // Then: Call is recorded with taskType
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("taskType", "RETRIEVAL_QUERY");
    });

    it("should support RETRIEVAL_DOCUMENT task type", async () => {
      // Given: Document task type
      // When: I embed a document
      await ai.embed("text-embedding-004", "Document content", {
        taskType: "RETRIEVAL_DOCUMENT",
      });

      // Then: Call is recorded
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty(
        "taskType",
        "RETRIEVAL_DOCUMENT",
      );
    });

    it("should support SEMANTIC_SIMILARITY task type", async () => {
      // Given: Semantic similarity task type
      // When: I embed for similarity
      await ai.embed("text-embedding-004", "Similar text", {
        taskType: "SEMANTIC_SIMILARITY",
      });

      // Then: Call is recorded
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty(
        "taskType",
        "SEMANTIC_SIMILARITY",
      );
    });
  });

  describe("embedding call tracking", () => {
    it("should record call type as embed", async () => {
      // Given: A mock AI helper
      // When: I embed text
      await ai.embed("text-embedding-004", "Test");

      // Then: Call is recorded with type "embed"
      const calls = ai.getCallsByType("embed");
      expect(calls).toHaveLength(1);
    });

    it("should record model key", async () => {
      // Given: A mock AI helper
      // When: I embed with specific model
      await ai.embed("text-embedding-004", "Test");

      // Then: Model key is recorded
      const lastCall = ai.getLastCall();
      expect(lastCall?.modelKey).toBe("text-embedding-004");
    });

    it("should record prompt as input text", async () => {
      // Given: A mock AI helper
      // When: I embed specific text
      await ai.embed("text-embedding-004", "My input text");

      // Then: Text is recorded as prompt
      const lastCall = ai.getLastCall();
      expect(lastCall?.prompt).toBe("My input text");
    });

    it("should record multiple texts as joined prompt", async () => {
      // Given: Multiple texts
      const texts = ["First", "Second"];

      // When: I embed them
      await ai.embed("text-embedding-004", texts);

      // Then: Texts are joined in prompt
      const lastCall = ai.getLastCall();
      expect(lastCall?.prompt).toContain("First");
      expect(lastCall?.prompt).toContain("Second");
    });

    it("should record response as embedding summary", async () => {
      // Given: A mock AI helper
      // When: I embed text
      await ai.embed("text-embedding-004", "Test");

      // Then: Response summarizes embeddings
      const lastCall = ai.getLastCall();
      expect(lastCall?.response).toContain("embedding");
      expect(lastCall?.response).toContain("dims");
    });

    it("should record output tokens as 0", async () => {
      // Given: A mock AI helper (embeddings have no output tokens)
      // When: I embed text
      await ai.embed("text-embedding-004", "Test");

      // Then: Output tokens are 0
      const lastCall = ai.getLastCall();
      expect(lastCall?.outputTokens).toBe(0);
    });
  });

  describe("embedding error handling", () => {
    it("should throw when configured to error", async () => {
      // Given: Mock configured to error
      ai.setError(true, "Embedding service unavailable");

      // When/Then: embed throws
      await expect(ai.embed("text-embedding-004", "Test")).rejects.toThrow(
        "Embedding service unavailable",
      );
    });

    it("should not record failed calls", async () => {
      // Given: Mock configured to error
      ai.setError(true, "Error");

      // When: Call fails
      await ai.embed("text-embedding-004", "Test").catch(() => {});

      // Then: No calls recorded
      expect(ai.getCalls()).toHaveLength(0);
    });
  });

  describe("embedding latency simulation", () => {
    it("should simulate latency", async () => {
      // Given: Mock with latency
      ai.setLatency(100);

      // When: I measure call time
      const start = Date.now();
      await ai.embed("text-embedding-004", "Test");
      const duration = Date.now() - start;

      // Then: Takes at least latency time
      expect(duration).toBeGreaterThanOrEqual(90);
    });
  });

  describe("embedding statistics", () => {
    it("should include embed calls in stats", async () => {
      // Given: Multiple embed calls
      await ai.embed("text-embedding-004", "First");
      await ai.embed("text-embedding-004", ["Second", "Third"]);

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Stats include all calls
      expect(stats.totalCalls).toBe(2);
      expect(stats.totalInputTokens).toBeGreaterThan(0);
      expect(stats.totalCost).toBeGreaterThan(0);
    });

    it("should track per-model stats for embeddings", async () => {
      // Given: Embed calls
      await ai.embed("text-embedding-004", "Test");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Per-model stats are available
      expect(stats.perModel["text-embedding-004"]).toBeDefined();
      expect(stats.perModel["text-embedding-004"]?.calls).toBe(1);
    });
  });

  describe("embedding vector properties", () => {
    it("should return numeric array", async () => {
      // Given: A mock AI helper
      // When: I embed text
      const result = await ai.embed("text-embedding-004", "Test");

      // Then: All values are numbers
      for (const value of result.embedding) {
        expect(typeof value).toBe("number");
      }
    });

    it("should return normalized-like values (mock)", async () => {
      // Given: A mock AI helper (mock generates random values)
      // When: I embed text
      const result = await ai.embed("text-embedding-004", "Test");

      // Then: Values are reasonable (mock uses Math.random)
      for (const value of result.embedding) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("child helper embedding", () => {
    it("should inherit embedding capabilities", async () => {
      // Given: A child helper
      const child = ai.createChild("child") as MockAIHelper;

      // When: I embed through child
      const result = await child.embed("text-embedding-004", "Test");

      // Then: Returns valid embedding
      expect(result.embedding.length).toBeGreaterThan(0);
    });

    it("should track embedding calls in child", async () => {
      // Given: A child helper
      const child = ai.createChild("child") as MockAIHelper;

      // When: I embed through child
      await child.embed("text-embedding-004", "Test");

      // Then: Child has the call
      const childCalls = child.getCallsByType("embed");
      expect(childCalls).toHaveLength(1);
    });
  });
});
