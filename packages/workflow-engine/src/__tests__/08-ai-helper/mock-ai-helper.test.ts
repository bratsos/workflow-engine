/**
 * MockAIHelper Tests
 *
 * Tests for the MockAIHelper utility used in testing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockAIHelper, MockAIHelper } from "../utils/mock-ai-helper.js";

describe("I want to use MockAIHelper in tests", () => {
  let ai: MockAIHelper;

  beforeEach(() => {
    ai = createMockAIHelper("test");
  });

  describe("generateText", () => {
    it("should return default mock response", async () => {
      // Given: A mock AI helper with default config
      // When: I call generateText
      const result = await ai.generateText("gemini-2.5-flash", "Hello");

      // Then: Returns default mock response
      expect(result.text).toBe("mock response");
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(result.cost).toBeGreaterThan(0);
    });

    it("should return configured response for matching prompt", async () => {
      // Given: A mock configured for specific prompt
      ai.setTextResponse("extract", {
        text: "extracted data from document",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.01,
      });

      // When: I call with matching prompt
      const result = await ai.generateText(
        "gemini-2.5-flash",
        "Please extract the data",
      );

      // Then: Returns configured response
      expect(result.text).toBe("extracted data from document");
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(50);
      expect(result.cost).toBe(0.01);
    });

    it("should support regex pattern matching", async () => {
      // Given: A mock configured with regex pattern
      ai.setTextResponse(/analyze.*document/i, {
        text: "analysis complete",
      });

      // When: I call with prompt matching regex
      const result = await ai.generateText(
        "gemini-2.5-flash",
        "Analyze this document please",
      );

      // Then: Returns configured response
      expect(result.text).toBe("analysis complete");
    });

    it("should record the call", async () => {
      // Given: A mock AI helper
      // When: I make a call
      await ai.generateText("gemini-2.5-flash", "Test prompt");

      // Then: Call is recorded
      const calls = ai.getCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.type).toBe("text");
      expect(calls[0]?.modelKey).toBe("gemini-2.5-flash");
      expect(calls[0]?.prompt).toBe("Test prompt");
    });
  });

  describe("generateObject", () => {
    it("should return default mock object response", async () => {
      // Given: A mock AI helper
      const schema = z.object({ name: z.string() });

      // When: I call generateObject
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "Get name",
        schema,
      );

      // Then: Returns default mock object
      expect(result.object).toBeDefined();
      expect(result.inputTokens).toBeGreaterThan(0);
    });

    it("should return configured object response", async () => {
      // Given: Mock configured with specific object
      ai.setObjectResponse("user", {
        object: { id: "user-123", name: "Test User" },
        inputTokens: 50,
        outputTokens: 30,
      });

      const schema = z.object({ id: z.string(), name: z.string() });

      // When: I call with matching prompt
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "Get user data",
        schema,
      );

      // Then: Returns configured object
      expect(result.object).toEqual({ id: "user-123", name: "Test User" });
    });

    it("should record the call", async () => {
      // Given: A mock AI helper
      const schema = z.object({ value: z.number() });

      // When: I make a call
      await ai.generateObject("gemini-2.5-flash", "Get value", schema);

      // Then: Call is recorded as type "object"
      const calls = ai.getCallsByType("object");
      expect(calls).toHaveLength(1);
    });
  });

  describe("embed", () => {
    it("should return mock embeddings", async () => {
      // Given: A mock AI helper
      // When: I call embed
      const result = await ai.embed("text-embedding-004", "Hello world");

      // Then: Returns embedding array
      expect(result.embedding).toBeDefined();
      expect(result.embedding.length).toBeGreaterThan(0);
      expect(result.dimensions).toBe(768);
    });

    it("should handle multiple texts", async () => {
      // Given: A mock AI helper
      // When: I call embed with array of texts
      const result = await ai.embed("text-embedding-004", ["Hello", "World"]);

      // Then: Returns multiple embeddings
      expect(result.embeddings).toHaveLength(2);
      expect(result.embedding).toEqual(result.embeddings[0]);
    });

    it("should record the call", async () => {
      // Given: A mock AI helper
      // When: I make an embed call
      await ai.embed("text-embedding-004", "Test");

      // Then: Call is recorded as type "embed"
      const calls = ai.getCallsByType("embed");
      expect(calls).toHaveLength(1);
    });
  });

  describe("streamText", () => {
    it("should stream text chunks", async () => {
      // Given: A mock configured with text
      ai.setTextResponse("stream", {
        text: "Hello world from stream",
      });

      // When: I call streamText
      const result = ai.streamText("gemini-2.5-flash", {
        prompt: "stream test",
      });

      // Then: Can iterate over stream
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }

      expect(chunks.join("")).toBe("Hello world from stream");
    });

    it("should call onChunk callback", async () => {
      // Given: A mock and onChunk callback
      ai.setTextResponse("callback", { text: "One Two Three" });

      const receivedChunks: string[] = [];

      // When: I stream with onChunk
      const result = ai.streamText(
        "gemini-2.5-flash",
        { prompt: "callback test" },
        { onChunk: (chunk) => receivedChunks.push(chunk) },
      );

      // Consume the stream
      for await (const _ of result.stream) {
        // Just consume
      }

      // Then: onChunk was called for each chunk
      expect(receivedChunks.length).toBeGreaterThan(0);
    });

    it("should provide usage after stream completes", async () => {
      // Given: A mock AI helper
      const result = ai.streamText("gemini-2.5-flash", {
        prompt: "usage test",
      });

      // Consume stream
      for await (const _ of result.stream) {
        // Consume
      }

      // When: I get usage
      const usage = await result.getUsage();

      // Then: Returns token counts and cost
      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBeGreaterThan(0);
      expect(usage.cost).toBeGreaterThan(0);
    });
  });

  describe("error simulation", () => {
    it("should throw error when configured", async () => {
      // Given: Mock configured to error
      ai.setError(true, "Simulated AI error");

      // When/Then: Calls throw the error
      await expect(ai.generateText("gemini-2.5-flash", "test")).rejects.toThrow(
        "Simulated AI error",
      );
    });

    it("should throw error for generateObject", async () => {
      // Given: Mock configured to error
      ai.setError(true, "Object generation failed");

      const schema = z.object({ data: z.string() });

      // When/Then: generateObject throws
      await expect(
        ai.generateObject("gemini-2.5-flash", "test", schema),
      ).rejects.toThrow("Object generation failed");
    });

    it("should throw error for embed", async () => {
      // Given: Mock configured to error
      ai.setError(true, "Embedding failed");

      // When/Then: embed throws
      await expect(ai.embed("text-embedding-004", "test")).rejects.toThrow(
        "Embedding failed",
      );
    });

    it("should throw error during stream iteration", async () => {
      // Given: Mock configured to error
      ai.setError(true, "Stream error");

      const result = ai.streamText("gemini-2.5-flash", { prompt: "test" });

      // When/Then: Iterating throws
      await expect(async () => {
        for await (const _ of result.stream) {
          // This should throw
        }
      }).rejects.toThrow("Stream error");
    });
  });

  describe("latency simulation", () => {
    it("should simulate latency for generateText", async () => {
      // Given: Mock configured with latency
      ai.setLatency(50);

      // When: I call generateText
      const start = Date.now();
      await ai.generateText("gemini-2.5-flash", "test");
      const duration = Date.now() - start;

      // Then: Call took at least the configured latency
      expect(duration).toBeGreaterThanOrEqual(40); // Allow some margin
    });
  });

  describe("call tracking", () => {
    it("should track multiple calls", async () => {
      // Given: A mock AI helper
      // When: I make multiple calls
      await ai.generateText("gemini-2.5-flash", "First");
      await ai.generateText("gemini-2.5-pro", "Second");
      await ai.embed("text-embedding-004", "Third");

      // Then: All calls are tracked
      expect(ai.getCalls()).toHaveLength(3);
    });

    it("should filter calls by type", async () => {
      // Given: Multiple calls of different types
      await ai.generateText("gemini-2.5-flash", "text");
      await ai.embed("text-embedding-004", "embed");
      await ai.generateText("gemini-2.5-flash", "text2");

      // When: I filter by type
      const textCalls = ai.getCallsByType("text");
      const embedCalls = ai.getCallsByType("embed");

      // Then: Returns filtered results
      expect(textCalls).toHaveLength(2);
      expect(embedCalls).toHaveLength(1);
    });

    it("should filter calls by model", async () => {
      // Given: Calls with different models
      await ai.generateText("gemini-2.5-flash", "flash");
      await ai.generateText("gemini-2.5-pro", "pro");
      await ai.generateText("gemini-2.5-flash", "flash2");

      // When: I filter by model
      const flashCalls = ai.getCallsByModel("gemini-2.5-flash");
      const proCalls = ai.getCallsByModel("gemini-2.5-pro");

      // Then: Returns filtered results
      expect(flashCalls).toHaveLength(2);
      expect(proCalls).toHaveLength(1);
    });

    it("should get last call", async () => {
      // Given: Multiple calls
      await ai.generateText("gemini-2.5-flash", "First");
      await ai.generateText("gemini-2.5-flash", "Second");
      await ai.generateText("gemini-2.5-flash", "Last");

      // When: I get last call
      const lastCall = ai.getLastCall();

      // Then: Returns the most recent call
      expect(lastCall?.prompt).toBe("Last");
    });

    it("should clear calls", async () => {
      // Given: Some calls recorded
      await ai.generateText("gemini-2.5-flash", "test1");
      await ai.generateText("gemini-2.5-flash", "test2");

      // When: I clear calls
      ai.clearCalls();

      // Then: No calls remain
      expect(ai.getCalls()).toHaveLength(0);
    });
  });

  describe("child helpers", () => {
    it("should create child with extended topic", () => {
      // Given: A parent helper
      const parent = createMockAIHelper("workflow.abc123");

      // When: I create a child
      const child = parent.createChild("stage", "extraction");

      // Then: Child has extended topic
      expect(child.topic).toBe("workflow.abc123.stage.extraction");
    });

    it("should create child without id", () => {
      // Given: A parent helper
      const parent = createMockAIHelper("workflow");

      // When: I create a child without id
      const child = parent.createChild("tools");

      // Then: Child topic has segment but no id
      expect(child.topic).toBe("workflow.tools");
    });

    it("should aggregate stats from children", async () => {
      // Given: Parent and child helpers
      const parent = createMockAIHelper("parent") as MockAIHelper;
      const child = parent.createChild("child") as MockAIHelper;

      // When: Calls are made on both
      await parent.generateText("gemini-2.5-flash", "parent call");
      await child.generateText("gemini-2.5-flash", "child call");

      // Then: Parent stats include child calls
      // Note: Child calls are both propagated to parent AND counted in getAllCallsRecursive
      // So total = 1 (parent) + 1 (child propagated to parent) + 1 (child's own) = 3
      const stats = await parent.getStats();
      expect(stats.totalCalls).toBe(3);

      // Child's own stats should just have 1 call
      const childStats = await child.getStats();
      expect(childStats.totalCalls).toBe(1);
    });

    it("should track children", () => {
      // Given: A parent helper
      const parent = createMockAIHelper("parent") as MockAIHelper;

      // When: I create multiple children
      parent.createChild("child1");
      parent.createChild("child2");

      // Then: Children are tracked
      expect(parent.getChildren()).toHaveLength(2);
    });
  });

  describe("stats aggregation", () => {
    it("should aggregate token counts and costs", async () => {
      // Given: Mock with specific token counts
      ai.setTextResponse("call1", {
        text: "one",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.01,
      });
      ai.setTextResponse("call2", {
        text: "two",
        inputTokens: 200,
        outputTokens: 100,
        cost: 0.02,
      });

      // When: I make calls and get stats
      await ai.generateText("gemini-2.5-flash", "call1");
      await ai.generateText("gemini-2.5-flash", "call2");
      const stats = await ai.getStats();

      // Then: Totals are aggregated
      expect(stats.totalCalls).toBe(2);
      expect(stats.totalInputTokens).toBe(300);
      expect(stats.totalOutputTokens).toBe(150);
      expect(stats.totalCost).toBe(0.03);
    });

    it("should track per-model stats", async () => {
      // Given: Calls with different models
      await ai.generateText("gemini-2.5-flash", "flash");
      await ai.generateText("gemini-2.5-pro", "pro");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Per-model stats are available
      expect(stats.perModel["gemini-2.5-flash"]).toBeDefined();
      expect(stats.perModel["gemini-2.5-pro"]).toBeDefined();
      expect(stats.perModel["gemini-2.5-flash"]?.calls).toBe(1);
      expect(stats.perModel["gemini-2.5-pro"]?.calls).toBe(1);
    });
  });

  describe("batch operations", () => {
    it("should submit batch requests", async () => {
      // Given: A mock AI helper
      const batch = ai.batch("gemini-2.5-flash");

      // When: I submit batch requests
      const handle = await batch.submit([
        { id: "req-1", prompt: "First prompt" },
        { id: "req-2", prompt: "Second prompt" },
      ]);

      // Then: Returns batch handle
      expect(handle.id).toBeDefined();
      expect(handle.status).toBe("pending");
    });

    it("should get batch results", async () => {
      // Given: A submitted batch
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([
        { id: "req-1", prompt: "First" },
        { id: "req-2", prompt: "Second" },
      ]);

      // Wait for mock processing
      await new Promise((resolve) => setTimeout(resolve, 150));

      // When: I get results
      const results = await batch.getResults(handle.id);

      // Then: Returns results for each request
      expect(results).toHaveLength(2);
      expect(results[0]?.id).toBe("req-1");
      expect(results[1]?.id).toBe("req-2");
    });

    it("should track batch calls", async () => {
      // Given: A mock AI helper
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      // Wait and get results to trigger recording
      await new Promise((resolve) => setTimeout(resolve, 150));
      await batch.getResults(handle.id);

      // Then: Batch calls are recorded
      const batchCalls = ai.getCallsByType("batch");
      expect(batchCalls.length).toBeGreaterThan(0);
    });
  });

  describe("reset", () => {
    it("should reset all state", async () => {
      // Given: Mock with calls and configuration
      ai.setTextResponse("test", { text: "custom" });
      ai.setError(true, "error");
      ai.setLatency(100);
      await ai.generateText("gemini-2.5-flash", "test").catch(() => {}); // Ignore error
      ai.createChild("child");

      // When: I reset
      ai.reset();

      // Then: All state is cleared
      expect(ai.getCalls()).toHaveLength(0);
      expect(ai.getChildren()).toHaveLength(0);

      // And: Error is cleared (should not throw)
      await expect(
        ai.generateText("gemini-2.5-flash", "test"),
      ).resolves.toBeDefined();
    });
  });
});
