/**
 * Tool Calling Tests
 *
 * Tests for the tool calling functionality of AIHelper.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockAIHelper, MockAIHelper } from "../utils/mock-ai-helper.js";

describe("I want to use tools with AIHelper", () => {
  let ai: MockAIHelper;

  beforeEach(() => {
    ai = createMockAIHelper("test.tool-calling");
  });

  describe("tool definition", () => {
    it("should accept tools in generateText", async () => {
      // Given: Tool definitions
      const tools = {
        getWeather: {
          description: "Get weather for a location",
          parameters: z.object({
            location: z.string().describe("City name"),
          }),
        },
      };

      // When: I call with tools
      await ai.generateText(
        "gemini-2.5-flash",
        "What is the weather in Tokyo?",
        {
          tools,
        },
      );

      // Then: Tools are captured in options
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("tools");
    });

    it("should accept multiple tools", async () => {
      // Given: Multiple tool definitions
      const tools = {
        getWeather: {
          description: "Get weather",
          parameters: z.object({ location: z.string() }),
        },
        getTime: {
          description: "Get current time",
          parameters: z.object({ timezone: z.string() }),
        },
        translate: {
          description: "Translate text",
          parameters: z.object({
            text: z.string(),
            targetLanguage: z.string(),
          }),
        },
      };

      // When: I call with tools
      await ai.generateText("gemini-2.5-flash", "Test", { tools });

      // Then: All tools are captured
      const lastCall = ai.getLastCall();
      const capturedTools = lastCall?.options?.tools as typeof tools;
      expect(capturedTools).toBeDefined();
    });

    it("should accept tools with complex parameters", async () => {
      // Given: Tool with complex schema
      const tools = {
        searchProducts: {
          description: "Search products",
          parameters: z.object({
            query: z.string(),
            filters: z
              .object({
                minPrice: z.number().optional(),
                maxPrice: z.number().optional(),
                category: z
                  .enum(["electronics", "clothing", "home"])
                  .optional(),
              })
              .optional(),
            sort: z.enum(["price", "rating", "relevance"]).default("relevance"),
            limit: z.number().min(1).max(100).default(10),
          }),
        },
      };

      // When: I call with complex tool
      await ai.generateText("gemini-2.5-flash", "Search for laptops", {
        tools,
      });

      // Then: Tool is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("tools");
    });
  });

  describe("toolChoice option", () => {
    it("should accept toolChoice auto", async () => {
      // Given: Tools with auto choice
      const tools = {
        search: {
          description: "Search the web",
          parameters: z.object({ query: z.string() }),
        },
      };

      // When: I call with toolChoice auto
      await ai.generateText("gemini-2.5-flash", "Search for news", {
        tools,
        toolChoice: "auto",
      });

      // Then: toolChoice is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("toolChoice", "auto");
    });

    it("should accept toolChoice required", async () => {
      // Given: Tools with required choice
      const tools = {
        calculate: {
          description: "Perform calculation",
          parameters: z.object({
            expression: z.string(),
          }),
        },
      };

      // When: I call with toolChoice required
      await ai.generateText("gemini-2.5-flash", "Calculate 2+2", {
        tools,
        toolChoice: "required",
      });

      // Then: toolChoice is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("toolChoice", "required");
    });

    it("should accept toolChoice none", async () => {
      // Given: Tools with none choice
      const tools = {
        unused: {
          description: "Unused tool",
          parameters: z.object({}),
        },
      };

      // When: I call with toolChoice none
      await ai.generateText("gemini-2.5-flash", "Just respond", {
        tools,
        toolChoice: "none",
      });

      // Then: toolChoice is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("toolChoice", "none");
    });

    it("should accept specific tool choice", async () => {
      // Given: Multiple tools
      const tools = {
        toolA: {
          description: "Tool A",
          parameters: z.object({ input: z.string() }),
        },
        toolB: {
          description: "Tool B",
          parameters: z.object({ data: z.number() }),
        },
      };

      // When: I call with specific tool choice
      await ai.generateText("gemini-2.5-flash", "Use tool A", {
        tools,
        toolChoice: { type: "tool", toolName: "toolA" },
      });

      // Then: toolChoice is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("toolChoice");
    });
  });

  describe("onStepFinish callback", () => {
    it("should accept onStepFinish callback", async () => {
      // Given: Tools with callback
      const tools = {
        step: {
          description: "Step tool",
          parameters: z.object({ value: z.string() }),
        },
      };

      const stepResults: unknown[] = [];

      // When: I call with onStepFinish
      await ai.generateText("gemini-2.5-flash", "Run steps", {
        tools,
        onStepFinish: (result) => {
          stepResults.push(result);
        },
      });

      // Then: onStepFinish is captured in options
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("onStepFinish");
    });

    it("should pass onStepFinish as function", async () => {
      // Given: Callback function
      const callback = () => {};
      const tools = {
        test: {
          description: "Test",
          parameters: z.object({}),
        },
      };

      // When: I call with callback
      await ai.generateText("gemini-2.5-flash", "Test", {
        tools,
        onStepFinish: callback,
      });

      // Then: Function is captured
      const lastCall = ai.getLastCall();
      expect(typeof lastCall?.options?.onStepFinish).toBe("function");
    });
  });

  describe("stopWhen option", () => {
    it("should accept stopWhen condition", async () => {
      // Given: Tools with stopWhen
      const tools = {
        iterate: {
          description: "Iterative tool",
          parameters: z.object({ count: z.number() }),
        },
      };

      // When: I call with stopWhen
      await ai.generateText("gemini-2.5-flash", "Iterate", {
        tools,
        stopWhen: { type: "stepCount", count: 3 } as any,
      });

      // Then: stopWhen is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("stopWhen");
    });
  });

  describe("tools in streamText", () => {
    it("should accept tools in streamText", async () => {
      // Given: Tools for streaming
      const tools = {
        stream: {
          description: "Stream tool",
          parameters: z.object({ input: z.string() }),
        },
      };

      // When: I stream with tools
      const result = ai.streamText(
        "gemini-2.5-flash",
        { prompt: "Test streaming with tools" },
        { tools },
      );

      // Consume stream
      for await (const _ of result.stream) {
        // Consume
      }

      // Then: Tools are captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("tools");
    });

    it("should accept stopWhen in streamText", async () => {
      // Given: Tools with stopWhen
      const tools = {
        test: {
          description: "Test",
          parameters: z.object({}),
        },
      };

      // When: I stream with stopWhen
      const result = ai.streamText(
        "gemini-2.5-flash",
        { prompt: "Test" },
        { tools, stopWhen: { type: "stepCount", count: 2 } as any },
      );

      for await (const _ of result.stream) {
        // Consume
      }

      // Then: stopWhen is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("stopWhen");
    });

    it("should accept onStepFinish in streamText", async () => {
      // Given: Callback
      const callback = () => {};
      const tools = {
        test: {
          description: "Test",
          parameters: z.object({}),
        },
      };

      // When: I stream with callback
      const result = ai.streamText(
        "gemini-2.5-flash",
        { prompt: "Test" },
        { tools, onStepFinish: callback },
      );

      for await (const _ of result.stream) {
        // Consume
      }

      // Then: Callback is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("onStepFinish");
    });
  });

  describe("tools in generateObject", () => {
    it("should accept tools in generateObject", async () => {
      // Given: Schema and tools
      const schema = z.object({ result: z.string() });
      const tools = {
        fetch: {
          description: "Fetch data",
          parameters: z.object({ url: z.string() }),
        },
      };

      // When: I generate object with tools
      await ai.generateObject("gemini-2.5-flash", "Get data", schema, {
        tools,
      });

      // Then: Tools are captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("tools");
    });

    it("should accept stopWhen in generateObject", async () => {
      // Given: Schema and tools with stopWhen
      const schema = z.object({ value: z.number() });
      const tools = {
        compute: {
          description: "Compute value",
          parameters: z.object({ input: z.number() }),
        },
      };

      // When: I generate with stopWhen
      await ai.generateObject("gemini-2.5-flash", "Compute", schema, {
        tools,
        stopWhen: { type: "stepCount", count: 5 } as any,
      });

      // Then: stopWhen is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("stopWhen");
    });

    it("should accept onStepFinish in generateObject", async () => {
      // Given: Schema, tools, and callback
      const schema = z.object({ data: z.string() });
      const tools = {
        process: {
          description: "Process data",
          parameters: z.object({ raw: z.string() }),
        },
      };
      const callback = () => {};

      // When: I generate with callback
      await ai.generateObject("gemini-2.5-flash", "Process", schema, {
        tools,
        onStepFinish: callback,
      });

      // Then: Callback is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("onStepFinish");
    });
  });

  describe("tool call tracking", () => {
    it("should record calls with tools", async () => {
      // Given: Tools
      const tools = {
        track: {
          description: "Track tool",
          parameters: z.object({ id: z.string() }),
        },
      };

      // When: I make a call with tools
      await ai.generateText("gemini-2.5-flash", "Track something", { tools });

      // Then: Call is recorded with type text
      const calls = ai.getCallsByType("text");
      expect(calls).toHaveLength(1);
    });

    it("should record model key for tool calls", async () => {
      // Given: Tools
      const tools = {
        model: {
          description: "Model tool",
          parameters: z.object({}),
        },
      };

      // When: I make a call
      await ai.generateText("gemini-2.5-pro", "Test model", { tools });

      // Then: Model is recorded
      const lastCall = ai.getLastCall();
      expect(lastCall?.modelKey).toBe("gemini-2.5-pro");
    });
  });

  describe("experimental_output option", () => {
    it("should accept experimental_output for structured output with tools", async () => {
      // Given: Tools and output schema
      const tools = {
        search: {
          description: "Search",
          parameters: z.object({ query: z.string() }),
        },
      };

      const outputSchema = z.object({
        summary: z.string(),
        sources: z.array(z.string()),
      });

      // When: I call with experimental_output
      await ai.generateText("gemini-2.5-flash", "Search and summarize", {
        tools,
        experimental_output: { schema: outputSchema } as any,
      });

      // Then: experimental_output is captured
      const lastCall = ai.getLastCall();
      expect(lastCall?.options).toHaveProperty("experimental_output");
    });
  });

  describe("tools without calling", () => {
    it("should work without tools", async () => {
      // Given: No tools
      // When: I call without tools
      const result = await ai.generateText("gemini-2.5-flash", "Simple text");

      // Then: Works normally
      expect(result.text).toBeDefined();
      const lastCall = ai.getLastCall();
      expect(lastCall?.options?.tools).toBeUndefined();
    });

    it("should distinguish between tool and non-tool calls", async () => {
      // Given: Both types of calls
      const tools = {
        test: {
          description: "Test",
          parameters: z.object({}),
        },
      };

      // When: I make both types
      await ai.generateText("gemini-2.5-flash", "Without tools");
      await ai.generateText("gemini-2.5-flash", "With tools", { tools });

      // Then: Both are recorded
      const calls = ai.getCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0]?.options?.tools).toBeUndefined();
      expect(calls[1]?.options?.tools).toBeDefined();
    });
  });

  describe("child helper with tools", () => {
    it("should use tools with child helper", async () => {
      // Given: Child helper
      const child = ai.createChild("child") as MockAIHelper;
      const tools = {
        childTool: {
          description: "Child tool",
          parameters: z.object({ value: z.string() }),
        },
      };

      // When: I call with tools through child
      await child.generateText("gemini-2.5-flash", "Child call", { tools });

      // Then: Call is tracked with tools
      const childCalls = child.getCalls();
      expect(childCalls).toHaveLength(1);
      expect(childCalls[0]?.options?.tools).toBeDefined();
    });
  });
});
