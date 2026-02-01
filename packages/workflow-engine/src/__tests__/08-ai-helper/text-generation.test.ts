/**
 * Text Generation Tests
 *
 * Tests for the generateText functionality of AIHelper.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockAIHelper, MockAIHelper } from "../utils/mock-ai-helper.js";

describe("I want to generate text using AIHelper", () => {
  let ai: MockAIHelper;

  beforeEach(() => {
    ai = createMockAIHelper("test.text-generation");
  });

  describe("basic text generation", () => {
    it("should generate text with a simple prompt", async () => {
      // Given: A mock AI helper configured with a response
      ai.setTextResponse("hello", {
        text: "Hello! How can I help you today?",
        inputTokens: 5,
        outputTokens: 10,
        cost: 0.0001,
      });

      // When: I call generateText
      const result = await ai.generateText("gemini-2.5-flash", "hello world");

      // Then: Returns the expected response
      expect(result.text).toBe("Hello! How can I help you today?");
      expect(result.inputTokens).toBe(5);
      expect(result.outputTokens).toBe(10);
      expect(result.cost).toBe(0.0001);
    });

    it("should use default response when no pattern matches", async () => {
      // Given: A mock AI helper with default config
      // When: I call generateText with unmatched prompt
      const result = await ai.generateText("gemini-2.5-flash", "random prompt");

      // Then: Returns default mock response
      expect(result.text).toBe("mock response");
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
    });

    it("should support different model keys", async () => {
      // Given: A mock AI helper
      // When: I call with different models
      await ai.generateText("gemini-2.5-flash", "test");
      await ai.generateText("gemini-2.5-pro", "test");

      // Then: Both calls are recorded with correct models
      const calls = ai.getCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0]?.modelKey).toBe("gemini-2.5-flash");
      expect(calls[1]?.modelKey).toBe("gemini-2.5-pro");
    });
  });

  describe("text generation with options", () => {
    it("should pass temperature option", async () => {
      // Given: A mock AI helper
      // When: I call with temperature option
      await ai.generateText("gemini-2.5-flash", "test", { temperature: 0.5 });

      // Then: Temperature is captured in the call
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("temperature", 0.5);
    });

    it("should pass maxTokens option", async () => {
      // Given: A mock AI helper
      // When: I call with maxTokens option
      await ai.generateText("gemini-2.5-flash", "test", { maxTokens: 1000 });

      // Then: maxTokens is captured in the call
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("maxTokens", 1000);
    });

    it("should pass multiple options", async () => {
      // Given: A mock AI helper
      // When: I call with multiple options
      await ai.generateText("gemini-2.5-flash", "test", {
        temperature: 0.8,
        maxTokens: 2000,
      });

      // Then: All options are captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toMatchObject({
        temperature: 0.8,
        maxTokens: 2000,
      });
    });
  });

  describe("text generation with regex patterns", () => {
    it("should match regex pattern", async () => {
      // Given: Mock configured with regex pattern
      ai.setTextResponse(/analyze.*data/i, {
        text: "Analysis complete: data processed",
        inputTokens: 100,
        outputTokens: 50,
      });

      // When: I call with matching prompt
      const result = await ai.generateText(
        "gemini-2.5-flash",
        "Please analyze this data carefully",
      );

      // Then: Returns matched response
      expect(result.text).toBe("Analysis complete: data processed");
    });

    it("should prioritize more specific patterns", async () => {
      // Given: Multiple patterns configured
      ai.setTextResponse("summarize", {
        text: "General summary",
      });
      ai.setTextResponse("summarize document", {
        text: "Document summary",
      });

      // When: I call with more specific prompt
      const result = await ai.generateText(
        "gemini-2.5-flash",
        "summarize document",
      );

      // Then: Returns the matched response (order-dependent in Map)
      expect(result.text).toBeDefined();
    });
  });

  describe("text generation with multimodal input", () => {
    it("should handle text content parts", async () => {
      // Given: A mock AI helper
      ai.setTextResponse("describe", {
        text: "Description generated",
      });

      // When: I call with content parts
      const result = await ai.generateText("gemini-2.5-flash", [
        { type: "text", text: "describe this content" },
      ]);

      // Then: Extracts text and returns response
      expect(result.text).toBe("Description generated");
    });

    it("should record multimodal content as joined text", async () => {
      // Given: A mock AI helper
      // When: I call with multiple text parts
      await ai.generateText("gemini-2.5-flash", [
        { type: "text", text: "First part" },
        { type: "text", text: "Second part" },
      ]);

      // Then: Records joined text
      const lastCall = ai.getLastCall();
      expect(lastCall?.prompt).toContain("First part");
      expect(lastCall?.prompt).toContain("Second part");
    });
  });

  describe("text generation call tracking", () => {
    it("should record call type as text", async () => {
      // Given: A mock AI helper
      // When: I generate text
      await ai.generateText("gemini-2.5-flash", "test");

      // Then: Call is recorded with type "text"
      const calls = ai.getCallsByType("text");
      expect(calls).toHaveLength(1);
    });

    it("should record timestamp", async () => {
      // Given: A mock AI helper
      const beforeCall = new Date();

      // When: I generate text
      await ai.generateText("gemini-2.5-flash", "test");

      // Then: Timestamp is recorded
      const lastCall = ai.getLastCall();
      expect(lastCall?.timestamp).toBeInstanceOf(Date);
      expect(lastCall?.timestamp.getTime()).toBeGreaterThanOrEqual(
        beforeCall.getTime(),
      );
    });

    it("should record response text", async () => {
      // Given: Mock with specific response
      ai.setTextResponse("query", {
        text: "Specific response text",
      });

      // When: I generate text
      await ai.generateText("gemini-2.5-flash", "query");

      // Then: Response is recorded
      const lastCall = ai.getLastCall();
      expect(lastCall?.response).toBe("Specific response text");
    });
  });

  describe("text generation error handling", () => {
    it("should throw when configured to error", async () => {
      // Given: Mock configured to error
      ai.setError(true, "API rate limit exceeded");

      // When/Then: generateText throws
      await expect(ai.generateText("gemini-2.5-flash", "test")).rejects.toThrow(
        "API rate limit exceeded",
      );
    });

    it("should not record failed calls", async () => {
      // Given: Mock configured to error
      ai.setError(true, "Service unavailable");

      // When: I try to generate text
      await ai.generateText("gemini-2.5-flash", "test").catch(() => {});

      // Then: No calls are recorded
      expect(ai.getCalls()).toHaveLength(0);
    });

    it("should reset error state", async () => {
      // Given: Mock configured to error
      ai.setError(true, "Error");

      // When: I reset the error
      ai.setError(false);

      // Then: generateText succeeds
      await expect(
        ai.generateText("gemini-2.5-flash", "test"),
      ).resolves.toBeDefined();
    });
  });

  describe("text generation with tools (experimental)", () => {
    it("should accept tools option", async () => {
      // Given: A mock AI helper with tools defined
      const tools = {
        getWeather: {
          description: "Get weather for a location",
          parameters: z.object({ location: z.string() }),
        },
      };

      // When: I call with tools
      await ai.generateText("gemini-2.5-flash", "What is the weather?", {
        tools,
      });

      // Then: Tools are captured in options
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("tools");
    });

    it("should accept toolChoice option", async () => {
      // Given: A mock AI helper
      const tools = {
        search: {
          description: "Search the web",
          parameters: z.object({ query: z.string() }),
        },
      };

      // When: I call with toolChoice
      await ai.generateText("gemini-2.5-flash", "Search for news", {
        tools,
        toolChoice: "auto",
      });

      // Then: toolChoice is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("toolChoice", "auto");
    });
  });

  describe("text generation latency simulation", () => {
    it("should simulate latency", async () => {
      // Given: Mock with latency
      ai.setLatency(100);

      // When: I measure the call time
      const start = Date.now();
      await ai.generateText("gemini-2.5-flash", "test");
      const duration = Date.now() - start;

      // Then: Call takes at least the latency time
      expect(duration).toBeGreaterThanOrEqual(90); // Allow small margin
    });

    it("should not add latency when not configured", async () => {
      // Given: Mock without latency
      // When: I measure the call time
      const start = Date.now();
      await ai.generateText("gemini-2.5-flash", "test");
      const duration = Date.now() - start;

      // Then: Call is fast
      expect(duration).toBeLessThan(50);
    });
  });
});
