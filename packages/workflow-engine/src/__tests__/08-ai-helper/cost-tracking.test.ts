/**
 * Cost Tracking Tests
 *
 * Tests for the cost tracking and statistics functionality of AIHelper.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockAIHelper, MockAIHelper } from "../utils/mock-ai-helper.js";

describe("I want to track AI costs using AIHelper", () => {
  let ai: MockAIHelper;

  beforeEach(() => {
    ai = createMockAIHelper("test.cost-tracking");
  });

  describe("basic cost tracking", () => {
    it("should return cost with generateText result", async () => {
      // Given: A mock with cost
      ai.setTextResponse("cost", {
        text: "Response",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.005,
      });

      // When: I generate text
      const result = await ai.generateText("gemini-2.5-flash", "cost test");

      // Then: Cost is included
      expect(result.cost).toBe(0.005);
    });

    it("should return cost with generateObject result", async () => {
      // Given: A mock with cost
      const schema = z.object({ data: z.string() });
      ai.setObjectResponse("cost", {
        object: { data: "value" },
        inputTokens: 80,
        outputTokens: 40,
        cost: 0.003,
      });

      // When: I generate object
      const result = await ai.generateObject(
        "gemini-2.5-flash",
        "cost test",
        schema,
      );

      // Then: Cost is included
      expect(result.cost).toBe(0.003);
    });

    it("should return cost with embed result", async () => {
      // Given: A mock AI helper (default embed has cost)
      // When: I embed
      const result = await ai.embed("text-embedding-004", "Test text");

      // Then: Cost is included
      expect(result.cost).toBeGreaterThan(0);
    });

    it("should return cost with stream usage", async () => {
      // Given: A mock with cost
      ai.setTextResponse("stream", {
        text: "Streamed",
        inputTokens: 50,
        outputTokens: 25,
        cost: 0.002,
      });

      // When: I stream and get usage
      const result = ai.streamText("gemini-2.5-flash", {
        prompt: "stream cost",
      });
      for await (const _ of result.stream) {
        // Consume
      }
      const usage = await result.getUsage();

      // Then: Cost is included
      expect(usage.cost).toBe(0.002);
    });
  });

  describe("token tracking", () => {
    it("should track input tokens", async () => {
      // Given: Known input tokens
      ai.setTextResponse("tokens", {
        text: "Response",
        inputTokens: 150,
        outputTokens: 75,
      });

      // When: I generate text
      const result = await ai.generateText("gemini-2.5-flash", "tokens test");

      // Then: Input tokens are tracked
      expect(result.inputTokens).toBe(150);
    });

    it("should track output tokens", async () => {
      // Given: Known output tokens
      ai.setTextResponse("tokens", {
        text: "Response",
        inputTokens: 100,
        outputTokens: 200,
      });

      // When: I generate text
      const result = await ai.generateText("gemini-2.5-flash", "tokens test");

      // Then: Output tokens are tracked
      expect(result.outputTokens).toBe(200);
    });

    it("should track embedding tokens (input only)", async () => {
      // Given: A mock AI helper
      // When: I embed
      const result = await ai.embed("text-embedding-004", "Some text");

      // Then: Only input tokens (no output for embeddings)
      expect(result.inputTokens).toBeGreaterThan(0);
    });
  });

  describe("getStats aggregation", () => {
    it("should aggregate total calls", async () => {
      // Given: Multiple calls
      await ai.generateText("gemini-2.5-flash", "Call 1");
      await ai.generateText("gemini-2.5-flash", "Call 2");
      await ai.generateText("gemini-2.5-flash", "Call 3");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Total calls is 3
      expect(stats.totalCalls).toBe(3);
    });

    it("should aggregate total input tokens", async () => {
      // Given: Calls with known tokens
      ai.setTextResponse("call1", {
        text: "R1",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.01,
      });
      ai.setTextResponse("call2", {
        text: "R2",
        inputTokens: 200,
        outputTokens: 100,
        cost: 0.02,
      });
      ai.setTextResponse("call3", {
        text: "R3",
        inputTokens: 300,
        outputTokens: 150,
        cost: 0.03,
      });

      await ai.generateText("gemini-2.5-flash", "call1");
      await ai.generateText("gemini-2.5-flash", "call2");
      await ai.generateText("gemini-2.5-flash", "call3");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Input tokens are summed
      expect(stats.totalInputTokens).toBe(600);
    });

    it("should aggregate total output tokens", async () => {
      // Given: Calls with known tokens
      ai.setTextResponse("call1", {
        text: "R1",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.01,
      });
      ai.setTextResponse("call2", {
        text: "R2",
        inputTokens: 200,
        outputTokens: 100,
        cost: 0.02,
      });

      await ai.generateText("gemini-2.5-flash", "call1");
      await ai.generateText("gemini-2.5-flash", "call2");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Output tokens are summed
      expect(stats.totalOutputTokens).toBe(150);
    });

    it("should aggregate total cost", async () => {
      // Given: Calls with known costs
      ai.setTextResponse("c1", {
        text: "R",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.01,
      });
      ai.setTextResponse("c2", {
        text: "R",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.02,
      });
      ai.setTextResponse("c3", {
        text: "R",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.03,
      });

      await ai.generateText("gemini-2.5-flash", "c1");
      await ai.generateText("gemini-2.5-flash", "c2");
      await ai.generateText("gemini-2.5-flash", "c3");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Costs are summed
      expect(stats.totalCost).toBe(0.06);
    });
  });

  describe("per-model stats", () => {
    it("should track stats per model", async () => {
      // Given: Calls with different models
      await ai.generateText("gemini-2.5-flash", "Flash call");
      await ai.generateText("gemini-2.5-pro", "Pro call");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Per-model breakdown exists
      expect(stats.perModel["gemini-2.5-flash"]).toBeDefined();
      expect(stats.perModel["gemini-2.5-pro"]).toBeDefined();
    });

    it("should count calls per model", async () => {
      // Given: Multiple calls per model
      await ai.generateText("gemini-2.5-flash", "Flash 1");
      await ai.generateText("gemini-2.5-flash", "Flash 2");
      await ai.generateText("gemini-2.5-pro", "Pro 1");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Counts are correct per model
      expect(stats.perModel["gemini-2.5-flash"]?.calls).toBe(2);
      expect(stats.perModel["gemini-2.5-pro"]?.calls).toBe(1);
    });

    it("should track tokens per model", async () => {
      // Given: Calls with different token counts
      ai.setTextResponse("flash", {
        text: "R",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.01,
      });
      ai.setTextResponse("pro", {
        text: "R",
        inputTokens: 200,
        outputTokens: 100,
        cost: 0.02,
      });

      await ai.generateText("gemini-2.5-flash", "flash");
      await ai.generateText("gemini-2.5-pro", "pro");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Tokens are tracked per model
      expect(stats.perModel["gemini-2.5-flash"]?.inputTokens).toBe(100);
      expect(stats.perModel["gemini-2.5-flash"]?.outputTokens).toBe(50);
      expect(stats.perModel["gemini-2.5-pro"]?.inputTokens).toBe(200);
      expect(stats.perModel["gemini-2.5-pro"]?.outputTokens).toBe(100);
    });

    it("should track cost per model", async () => {
      // Given: Calls with different costs
      ai.setTextResponse("flash", {
        text: "R",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.001,
      });
      ai.setTextResponse("pro", {
        text: "R",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.005,
      });

      await ai.generateText("gemini-2.5-flash", "flash");
      await ai.generateText("gemini-2.5-pro", "pro");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Cost is tracked per model
      expect(stats.perModel["gemini-2.5-flash"]?.cost).toBe(0.001);
      expect(stats.perModel["gemini-2.5-pro"]?.cost).toBe(0.005);
    });
  });

  describe("stats across call types", () => {
    it("should aggregate text and object calls", async () => {
      // Given: Different call types
      const schema = z.object({ data: z.string() });

      await ai.generateText("gemini-2.5-flash", "Text call");
      await ai.generateObject("gemini-2.5-flash", "Object call", schema);

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Both are counted
      expect(stats.totalCalls).toBe(2);
    });

    it("should aggregate all call types", async () => {
      // Given: All call types
      const schema = z.object({ data: z.string() });

      await ai.generateText("gemini-2.5-flash", "Text");
      await ai.generateObject("gemini-2.5-flash", "Object", schema);
      await ai.embed("text-embedding-004", "Embed");

      const stream = ai.streamText("gemini-2.5-flash", { prompt: "Stream" });
      for await (const _ of stream.stream) {
        // Consume
      }

      // When: I get stats
      const stats = await ai.getStats();

      // Then: All are counted
      expect(stats.totalCalls).toBe(4);
    });

    it("should aggregate tokens across call types", async () => {
      // Given: Calls with tokens
      ai.setTextResponse("text", {
        text: "R",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.01,
      });
      ai.setObjectResponse("object", {
        object: { d: "v" },
        inputTokens: 80,
        outputTokens: 40,
        cost: 0.01,
      });

      const schema = z.object({ d: z.string() });
      await ai.generateText("gemini-2.5-flash", "text");
      await ai.generateObject("gemini-2.5-flash", "object", schema);

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Tokens are aggregated
      expect(stats.totalInputTokens).toBe(180);
      expect(stats.totalOutputTokens).toBe(90);
    });
  });

  describe("recordCall manual tracking", () => {
    it("should record call with object params", () => {
      // Given: Call params
      ai.recordCall({
        modelKey: "gemini-2.5-flash",
        callType: "text",
        prompt: "Manual prompt",
        response: "Manual response",
        inputTokens: 50,
        outputTokens: 25,
      });

      // Then: Call is recorded
      const calls = ai.getCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.prompt).toBe("Manual prompt");
    });

    it("should record call with legacy params", () => {
      // Given: Legacy params
      ai.recordCall("gemini-2.5-flash", "Legacy prompt", "Legacy response", {
        input: 30,
        output: 15,
      });

      // Then: Call is recorded
      const calls = ai.getCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.prompt).toBe("Legacy prompt");
    });

    it("should include recorded calls in stats", async () => {
      // Given: Manual recording
      ai.recordCall({
        modelKey: "gemini-2.5-flash",
        callType: "text",
        prompt: "P",
        response: "R",
        inputTokens: 100,
        outputTokens: 50,
      });

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Manual call is counted
      expect(stats.totalCalls).toBe(1);
      expect(stats.totalInputTokens).toBe(100);
    });

    it("should record batch calls", () => {
      // Given: Batch recording
      ai.recordCall({
        modelKey: "gemini-2.5-flash",
        callType: "batch",
        prompt: "Batch prompt",
        response: "Batch response",
        inputTokens: 200,
        outputTokens: 100,
        metadata: { batchId: "batch-123" },
      });

      // Then: Batch call is recorded
      const batchCalls = ai.getCallsByType("batch");
      expect(batchCalls).toHaveLength(1);
    });
  });

  describe("child helper stats", () => {
    it("should track stats in child helper", async () => {
      // Given: A child helper
      const child = ai.createChild("child") as MockAIHelper;
      child.setTextResponse("child", {
        text: "R",
        inputTokens: 50,
        outputTokens: 25,
        cost: 0.005,
      });

      await child.generateText("gemini-2.5-flash", "child call");

      // When: I get child stats
      const childStats = await child.getStats();

      // Then: Child has its own stats
      expect(childStats.totalCalls).toBe(1);
      expect(childStats.totalInputTokens).toBe(50);
    });

    it("should propagate calls to parent", async () => {
      // Given: Parent and child
      const parent = createMockAIHelper("parent") as MockAIHelper;
      const child = parent.createChild("child") as MockAIHelper;

      await parent.generateText("gemini-2.5-flash", "Parent call");
      await child.generateText("gemini-2.5-flash", "Child call");

      // When: I get parent stats
      const parentStats = await parent.getStats();

      // Then: Parent includes propagated calls
      expect(parentStats.totalCalls).toBeGreaterThanOrEqual(2);
    });
  });

  describe("clearing stats", () => {
    it("should clear calls", async () => {
      // Given: Some calls
      await ai.generateText("gemini-2.5-flash", "Call 1");
      await ai.generateText("gemini-2.5-flash", "Call 2");

      // When: I clear calls
      ai.clearCalls();

      // Then: No calls remain
      expect(ai.getCalls()).toHaveLength(0);
    });

    it("should clear stats after clearCalls", async () => {
      // Given: Calls with stats
      ai.setTextResponse("call", {
        text: "R",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.01,
      });
      await ai.generateText("gemini-2.5-flash", "call");

      // When: I clear and get stats
      ai.clearCalls();
      const stats = await ai.getStats();

      // Then: Stats are zeroed
      expect(stats.totalCalls).toBe(0);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalCost).toBe(0);
    });

    it("should clear child calls on parent reset", () => {
      // Given: Parent and child with calls
      const parent = createMockAIHelper("parent") as MockAIHelper;
      const child = parent.createChild("child") as MockAIHelper;
      child.recordCall({
        modelKey: "gemini-2.5-flash",
        callType: "text",
        prompt: "P",
        response: "R",
        inputTokens: 10,
        outputTokens: 5,
      });

      // When: I reset parent
      parent.reset();

      // Then: Parent has no calls (children are cleared)
      expect(parent.getCalls()).toHaveLength(0);
    });
  });

  describe("cost precision", () => {
    it("should handle small costs", async () => {
      // Given: Very small cost
      ai.setTextResponse("small", {
        text: "R",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.000001,
      });

      await ai.generateText("gemini-2.5-flash", "small");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Small cost is tracked
      expect(stats.totalCost).toBe(0.000001);
    });

    it("should handle zero cost", async () => {
      // Given: Zero cost
      ai.setTextResponse("free", {
        text: "R",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0,
      });

      await ai.generateText("gemini-2.5-flash", "free");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Zero cost is tracked
      expect(stats.totalCost).toBe(0);
    });

    it("should sum costs accurately", async () => {
      // Given: Multiple costs that need precision
      ai.setTextResponse("c1", {
        text: "R",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.001,
      });
      ai.setTextResponse("c2", {
        text: "R",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.002,
      });
      ai.setTextResponse("c3", {
        text: "R",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.003,
      });

      await ai.generateText("gemini-2.5-flash", "c1");
      await ai.generateText("gemini-2.5-flash", "c2");
      await ai.generateText("gemini-2.5-flash", "c3");

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Sum is accurate
      expect(stats.totalCost).toBeCloseTo(0.006, 6);
    });
  });

  describe("empty stats", () => {
    it("should return zero stats when no calls", async () => {
      // Given: No calls made
      // When: I get stats
      const stats = await ai.getStats();

      // Then: All zeros
      expect(stats.totalCalls).toBe(0);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.totalCost).toBe(0);
    });

    it("should return empty perModel when no calls", async () => {
      // Given: No calls made
      // When: I get stats
      const stats = await ai.getStats();

      // Then: perModel is empty
      expect(Object.keys(stats.perModel)).toHaveLength(0);
    });
  });
});
