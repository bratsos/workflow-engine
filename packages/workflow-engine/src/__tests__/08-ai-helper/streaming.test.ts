/**
 * Streaming Tests
 *
 * Tests for the streamText functionality of AIHelper.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createMockAIHelper, MockAIHelper } from "../utils/mock-ai-helper.js";

describe("I want to stream text using AIHelper", () => {
  let ai: MockAIHelper;

  beforeEach(() => {
    ai = createMockAIHelper("test.streaming");
  });

  describe("basic streaming", () => {
    it("should stream text chunks", async () => {
      // Given: A mock with configured response
      ai.setTextResponse("stream", {
        text: "Hello world from streaming",
        inputTokens: 10,
        outputTokens: 5,
      });

      // When: I stream text
      const result = ai.streamText("gemini-2.5-flash", {
        prompt: "stream test",
      });

      // Then: Can iterate over stream
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join("")).toBe("Hello world from streaming");
    });

    it("should return stream immediately (non-blocking)", () => {
      // Given: A mock AI helper
      // When: I call streamText
      const result = ai.streamText("gemini-2.5-flash", { prompt: "test" });

      // Then: Returns immediately without awaiting
      expect(result.stream).toBeDefined();
      expect(result.getUsage).toBeDefined();
      expect(typeof result.getUsage).toBe("function");
    });

    it("should support prompt-based input", async () => {
      // Given: A mock AI helper
      ai.setTextResponse("prompt", { text: "Response to prompt" });

      // When: I stream with prompt input
      const result = ai.streamText("gemini-2.5-flash", {
        prompt: "prompt input",
      });

      // Then: Stream contains expected text
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      expect(chunks.join("")).toBe("Response to prompt");
    });

    it("should support messages-based input", async () => {
      // Given: A mock AI helper
      // When: I stream with messages input
      const result = ai.streamText("gemini-2.5-flash", {
        messages: [{ role: "user", content: "Hello" }],
      });

      // Then: Stream is available
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      expect(chunks.join("").length).toBeGreaterThan(0);
    });
  });

  describe("stream consumption", () => {
    it("should split text into word chunks", async () => {
      // Given: Response with multiple words
      ai.setTextResponse("words", { text: "One Two Three Four" });

      // When: I stream
      const result = ai.streamText("gemini-2.5-flash", { prompt: "words" });
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }

      // Then: Text is split into chunks (by space)
      expect(chunks.length).toBe(4); // "One ", "Two ", "Three ", "Four"
    });

    it("should preserve chunk order", async () => {
      // Given: Ordered text
      ai.setTextResponse("order", { text: "First Second Third" });

      // When: I stream
      const result = ai.streamText("gemini-2.5-flash", { prompt: "order" });
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }

      // Then: Order is preserved
      const fullText = chunks.join("");
      expect(fullText.indexOf("First")).toBeLessThan(
        fullText.indexOf("Second"),
      );
      expect(fullText.indexOf("Second")).toBeLessThan(
        fullText.indexOf("Third"),
      );
    });

    it("should handle single word response", async () => {
      // Given: Single word
      ai.setTextResponse("single", { text: "Word" });

      // When: I stream
      const result = ai.streamText("gemini-2.5-flash", { prompt: "single" });
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }

      // Then: Returns single chunk
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("Word");
    });

    it("should handle empty response", async () => {
      // Given: Empty response
      ai.setTextResponse("empty", { text: "" });

      // When: I stream
      const result = ai.streamText("gemini-2.5-flash", { prompt: "empty" });
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }

      // Then: Empty result
      expect(chunks.join("")).toBe("");
    });
  });

  describe("onChunk callback", () => {
    it("should call onChunk for each chunk", async () => {
      // Given: Response and callback
      ai.setTextResponse("callback", { text: "A B C" });
      const receivedChunks: string[] = [];

      // When: I stream with onChunk
      const result = ai.streamText(
        "gemini-2.5-flash",
        { prompt: "callback" },
        { onChunk: (chunk) => receivedChunks.push(chunk) },
      );

      // Consume stream
      for await (const _ of result.stream) {
        // Just consume
      }

      // Then: Callback received all chunks
      expect(receivedChunks.length).toBeGreaterThan(0);
      expect(receivedChunks.join("")).toBe("A B C");
    });

    it("should call onChunk in order", async () => {
      // Given: Ordered text
      ai.setTextResponse("ordered", { text: "1 2 3" });
      const receivedChunks: string[] = [];

      // When: I stream with onChunk
      const result = ai.streamText(
        "gemini-2.5-flash",
        { prompt: "ordered" },
        { onChunk: (chunk) => receivedChunks.push(chunk) },
      );

      for await (const _ of result.stream) {
        // Consume
      }

      // Then: Order is preserved
      expect(receivedChunks[0]).toContain("1");
      expect(receivedChunks[1]).toContain("2");
      expect(receivedChunks[2]).toContain("3");
    });

    it("should work without onChunk callback", async () => {
      // Given: No callback
      ai.setTextResponse("nocallback", { text: "No callback" });

      // When: I stream without onChunk
      const result = ai.streamText("gemini-2.5-flash", {
        prompt: "nocallback",
      });

      // Then: Still works
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      expect(chunks.join("")).toBe("No callback");
    });
  });

  describe("stream usage", () => {
    it("should provide usage after stream completes", async () => {
      // Given: Stream with token counts
      ai.setTextResponse("usage", {
        text: "Response text",
        inputTokens: 25,
        outputTokens: 15,
        cost: 0.002,
      });

      const result = ai.streamText("gemini-2.5-flash", {
        prompt: "usage test",
      });

      // Consume stream first
      for await (const _ of result.stream) {
        // Consume
      }

      // When: I get usage
      const usage = await result.getUsage();

      // Then: Returns token counts and cost
      expect(usage.inputTokens).toBe(25);
      expect(usage.outputTokens).toBe(15);
      expect(usage.cost).toBe(0.002);
    });

    it("should wait for stream if getUsage called early", async () => {
      // Given: A stream
      ai.setTextResponse("early", {
        text: "Some text",
        inputTokens: 10,
        outputTokens: 5,
      });

      const result = ai.streamText("gemini-2.5-flash", { prompt: "early" });

      // When: I call getUsage without consuming stream
      const usage = await result.getUsage();

      // Then: Still returns valid usage (after auto-consuming)
      expect(usage.inputTokens).toBe(10);
      expect(usage.outputTokens).toBe(5);
    });

    it("should return same usage on repeated calls", async () => {
      // Given: A consumed stream
      ai.setTextResponse("repeat", {
        text: "Text",
        inputTokens: 20,
        outputTokens: 10,
        cost: 0.001,
      });

      const result = ai.streamText("gemini-2.5-flash", { prompt: "repeat" });
      for await (const _ of result.stream) {
        // Consume
      }

      // When: I call getUsage multiple times
      const usage1 = await result.getUsage();
      const usage2 = await result.getUsage();

      // Then: Same values
      expect(usage1).toEqual(usage2);
    });
  });

  describe("streaming options", () => {
    it("should pass temperature option", async () => {
      // Given: Temperature option
      const result = ai.streamText(
        "gemini-2.5-flash",
        { prompt: "test" },
        { temperature: 0.9 },
      );

      // Consume stream to trigger recording
      for await (const _ of result.stream) {
        // Consume
      }

      // Then: Temperature is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("temperature", 0.9);
    });

    it("should pass maxTokens option", async () => {
      // Given: maxTokens option
      const result = ai.streamText(
        "gemini-2.5-flash",
        { prompt: "test" },
        { maxTokens: 500 },
      );

      for await (const _ of result.stream) {
        // Consume
      }

      // Then: maxTokens is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("maxTokens", 500);
    });

    it("should support system message in input", async () => {
      // Given: Input with system message
      const result = ai.streamText("gemini-2.5-flash", {
        prompt: "Hello",
        system: "You are a helpful assistant",
      });

      // Then: Stream is available
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe("streaming call tracking", () => {
    it("should record call type as stream", async () => {
      // Given: A stream
      const result = ai.streamText("gemini-2.5-flash", { prompt: "test" });
      for await (const _ of result.stream) {
        // Consume
      }

      // Then: Recorded as stream type
      const calls = ai.getCallsByType("stream");
      expect(calls).toHaveLength(1);
    });

    it("should record model key", async () => {
      // Given: Specific model
      const result = ai.streamText("gemini-2.5-flash", { prompt: "test" });
      for await (const _ of result.stream) {
        // Consume
      }

      // Then: Model is recorded
      const lastCall = ai.getLastCall();
      expect(lastCall?.modelKey).toBe("gemini-2.5-flash");
    });

    it("should record prompt", async () => {
      // Given: Specific prompt
      const result = ai.streamText("gemini-2.5-flash", {
        prompt: "My specific prompt",
      });
      for await (const _ of result.stream) {
        // Consume
      }

      // Then: Prompt is recorded
      const lastCall = ai.getLastCall();
      expect(lastCall?.prompt).toBe("My specific prompt");
    });

    it("should record full response text", async () => {
      // Given: Known response
      ai.setTextResponse("full", { text: "Complete response text" });

      const result = ai.streamText("gemini-2.5-flash", { prompt: "full" });
      for await (const _ of result.stream) {
        // Consume
      }

      // Then: Full response is recorded
      const lastCall = ai.getLastCall();
      expect(lastCall?.response).toBe("Complete response text");
    });
  });

  describe("streaming error handling", () => {
    it("should throw during iteration when configured to error", async () => {
      // Given: Mock configured to error
      ai.setError(true, "Stream interrupted");

      const result = ai.streamText("gemini-2.5-flash", { prompt: "test" });

      // When/Then: Iteration throws
      await expect(async () => {
        for await (const _ of result.stream) {
          // Should throw
        }
      }).rejects.toThrow("Stream interrupted");
    });

    it("should reset error state", async () => {
      // Given: Error that gets cleared
      ai.setError(true, "Error");
      ai.setError(false);

      // When: I stream
      const result = ai.streamText("gemini-2.5-flash", { prompt: "test" });

      // Then: No error
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe("streaming with latency", () => {
    it("should simulate latency between chunks", async () => {
      // Given: Latency and multi-word response
      ai.setLatency(100);
      ai.setTextResponse("latency", { text: "One Two Three" });

      // When: I measure streaming time
      const start = Date.now();
      const result = ai.streamText("gemini-2.5-flash", { prompt: "latency" });
      for await (const _ of result.stream) {
        // Consume
      }
      const duration = Date.now() - start;

      // Then: Takes time (latency distributed across chunks)
      expect(duration).toBeGreaterThanOrEqual(50);
    });
  });

  describe("rawResult property", () => {
    it("should expose rawResult for advanced usage", () => {
      // Given: A stream
      const result = ai.streamText("gemini-2.5-flash", { prompt: "test" });

      // Then: rawResult is available
      expect(result.rawResult).toBeDefined();
    });
  });

  describe("streaming statistics", () => {
    it("should include stream calls in stats", async () => {
      // Given: Multiple stream calls
      ai.setTextResponse("stream1", {
        text: "First",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.001,
      });
      ai.setTextResponse("stream2", {
        text: "Second",
        inputTokens: 20,
        outputTokens: 10,
        cost: 0.002,
      });

      const r1 = ai.streamText("gemini-2.5-flash", { prompt: "stream1" });
      for await (const _ of r1.stream) {
        // Consume
      }

      const r2 = ai.streamText("gemini-2.5-flash", { prompt: "stream2" });
      for await (const _ of r2.stream) {
        // Consume
      }

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Stats include all calls
      expect(stats.totalCalls).toBe(2);
      expect(stats.totalInputTokens).toBe(30);
      expect(stats.totalOutputTokens).toBe(15);
      expect(stats.totalCost).toBe(0.003);
    });
  });

  describe("child helper streaming", () => {
    it("should stream through child helper", async () => {
      // Given: A child helper
      const child = ai.createChild("child") as MockAIHelper;
      child.setTextResponse("child", { text: "Child response" });

      // When: I stream through child
      const result = child.streamText("gemini-2.5-flash", { prompt: "child" });
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }

      // Then: Returns expected response
      expect(chunks.join("")).toBe("Child response");
    });

    it("should track stream calls in child", async () => {
      // Given: A child helper
      const child = ai.createChild("child") as MockAIHelper;

      // When: I stream through child
      const result = child.streamText("gemini-2.5-flash", { prompt: "test" });
      for await (const _ of result.stream) {
        // Consume
      }

      // Then: Child has the call
      const childCalls = child.getCallsByType("stream");
      expect(childCalls).toHaveLength(1);
    });
  });
});
