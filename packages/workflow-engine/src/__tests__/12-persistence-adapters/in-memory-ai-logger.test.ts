/**
 * InMemoryAICallLogger Tests
 *
 * Tests for the in-memory AI call logger used in testing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { CreateAICallInput } from "../../persistence/interface.js";
import { InMemoryAICallLogger } from "../utils/in-memory-ai-logger.js";

describe("I want to use InMemoryAICallLogger in tests", () => {
  let logger: InMemoryAICallLogger;

  beforeEach(() => {
    logger = new InMemoryAICallLogger();
  });

  // Helper to create a call input
  function createCallInput(
    overrides: Partial<CreateAICallInput> = {},
  ): CreateAICallInput {
    return {
      topic: "workflow.abc123",
      callType: "text",
      modelKey: "gemini-2.5-flash",
      modelId: "gemini-2.5-flash-latest",
      prompt: "Test prompt",
      response: "Test response",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
      ...overrides,
    };
  }

  describe("logCall", () => {
    it("should log a single AI call", () => {
      // Given: A logger
      // When: I log a call
      logger.logCall(createCallInput());

      // Then: Call is recorded
      expect(logger.getCallCount()).toBe(1);
    });

    it("should assign unique IDs to each call", () => {
      // Given: A logger
      // When: I log multiple calls
      logger.logCall(createCallInput({ prompt: "First" }));
      logger.logCall(createCallInput({ prompt: "Second" }));

      // Then: Each call has a unique ID
      const calls = logger.getAllCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0]?.id).not.toBe(calls[1]?.id);
    });

    it("should record all call properties", () => {
      // Given: A call with all properties
      const input = createCallInput({
        topic: "workflow.test.stage",
        callType: "object",
        modelKey: "gemini-2.5-pro",
        modelId: "gemini-2.5-pro-latest",
        prompt: "Generate JSON",
        response: '{"key": "value"}',
        inputTokens: 200,
        outputTokens: 100,
        cost: 0.005,
        metadata: { schemaName: "TestSchema" },
      });

      // When: I log the call
      logger.logCall(input);

      // Then: All properties are recorded
      const call = logger.getLastCall();
      expect(call).toBeDefined();
      expect(call?.topic).toBe("workflow.test.stage");
      expect(call?.callType).toBe("object");
      expect(call?.modelKey).toBe("gemini-2.5-pro");
      expect(call?.modelId).toBe("gemini-2.5-pro-latest");
      expect(call?.prompt).toBe("Generate JSON");
      expect(call?.response).toBe('{"key": "value"}');
      expect(call?.inputTokens).toBe(200);
      expect(call?.outputTokens).toBe(100);
      expect(call?.cost).toBe(0.005);
      expect(call?.metadata).toEqual({ schemaName: "TestSchema" });
    });

    it("should set createdAt timestamp", () => {
      // Given: A logger
      const before = new Date();

      // When: I log a call
      logger.logCall(createCallInput());

      const after = new Date();

      // Then: createdAt is set between before and after
      const call = logger.getLastCall();
      expect(call?.createdAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(call?.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("should handle null metadata", () => {
      // Given: A call without metadata
      const input = createCallInput();
      delete (input as Record<string, unknown>).metadata;

      // When: I log the call
      logger.logCall(input);

      // Then: Metadata is null
      const call = logger.getLastCall();
      expect(call?.metadata).toBeNull();
    });
  });

  describe("logBatchResults", () => {
    it("should log multiple results for a batch", async () => {
      // Given: Batch results
      const results: CreateAICallInput[] = [
        createCallInput({ prompt: "Batch item 1" }),
        createCallInput({ prompt: "Batch item 2" }),
        createCallInput({ prompt: "Batch item 3" }),
      ];

      // When: I log batch results
      await logger.logBatchResults("batch-123", results);

      // Then: All results are recorded
      expect(logger.getCallCount()).toBe(3);
    });

    it("should add batchId to metadata", async () => {
      // Given: A batch result
      const results: CreateAICallInput[] = [
        createCallInput({ prompt: "Batch item" }),
      ];

      // When: I log batch results
      await logger.logBatchResults("batch-456", results);

      // Then: batchId is in metadata
      const call = logger.getLastCall();
      expect(call?.metadata).toEqual({ batchId: "batch-456" });
    });

    it("should merge batchId with existing metadata", async () => {
      // Given: A batch result with existing metadata
      const results: CreateAICallInput[] = [
        createCallInput({
          prompt: "Batch item",
          metadata: { existingKey: "existingValue" },
        }),
      ];

      // When: I log batch results
      await logger.logBatchResults("batch-789", results);

      // Then: Both batchId and existing metadata are present
      const call = logger.getLastCall();
      expect(call?.metadata).toEqual({
        existingKey: "existingValue",
        batchId: "batch-789",
      });
    });

    it("should mark batch as recorded", async () => {
      // Given: A batch
      // When: I log batch results
      await logger.logBatchResults("batch-recorded", [createCallInput()]);

      // Then: Batch is marked as recorded
      const isRecorded = await logger.isRecorded("batch-recorded");
      expect(isRecorded).toBe(true);
    });
  });

  describe("getStats", () => {
    it("should aggregate stats for topic prefix", async () => {
      // Given: Calls with different topics
      logger.logCall(
        createCallInput({
          topic: "workflow.abc.stage1",
          inputTokens: 100,
          outputTokens: 50,
          cost: 0.01,
        }),
      );
      logger.logCall(
        createCallInput({
          topic: "workflow.abc.stage2",
          inputTokens: 200,
          outputTokens: 100,
          cost: 0.02,
        }),
      );
      logger.logCall(
        createCallInput({
          topic: "workflow.xyz.stage1",
          inputTokens: 300,
          outputTokens: 150,
          cost: 0.03,
        }),
      );

      // When: I get stats for workflow.abc prefix
      const stats = await logger.getStats("workflow.abc");

      // Then: Only matching calls are included
      expect(stats.totalCalls).toBe(2);
      expect(stats.totalInputTokens).toBe(300);
      expect(stats.totalOutputTokens).toBe(150);
      expect(stats.totalCost).toBe(0.03);
    });

    it("should aggregate per-model stats", async () => {
      // Given: Calls with different models
      logger.logCall(
        createCallInput({
          topic: "workflow.test",
          modelKey: "gemini-2.5-flash",
          inputTokens: 100,
          outputTokens: 50,
          cost: 0.01,
        }),
      );
      logger.logCall(
        createCallInput({
          topic: "workflow.test",
          modelKey: "gemini-2.5-flash",
          inputTokens: 100,
          outputTokens: 50,
          cost: 0.01,
        }),
      );
      logger.logCall(
        createCallInput({
          topic: "workflow.test",
          modelKey: "gemini-2.5-pro",
          inputTokens: 200,
          outputTokens: 100,
          cost: 0.05,
        }),
      );

      // When: I get stats
      const stats = await logger.getStats("workflow.test");

      // Then: Per-model stats are correct
      expect(stats.perModel["gemini-2.5-flash"]).toEqual({
        calls: 2,
        inputTokens: 200,
        outputTokens: 100,
        cost: 0.02,
      });
      expect(stats.perModel["gemini-2.5-pro"]).toEqual({
        calls: 1,
        inputTokens: 200,
        outputTokens: 100,
        cost: 0.05,
      });
    });

    it("should return empty stats for non-matching prefix", async () => {
      // Given: Calls with specific topics
      logger.logCall(createCallInput({ topic: "workflow.abc" }));

      // When: I get stats for non-matching prefix
      const stats = await logger.getStats("workflow.xyz");

      // Then: Stats are empty
      expect(stats.totalCalls).toBe(0);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.totalCost).toBe(0);
      expect(stats.perModel).toEqual({});
    });
  });

  describe("isRecorded", () => {
    it("should return false for unrecorded batch", async () => {
      // Given: An empty logger
      // When: I check if batch is recorded
      const isRecorded = await logger.isRecorded("unknown-batch");

      // Then: Returns false
      expect(isRecorded).toBe(false);
    });

    it("should return true after batch is logged", async () => {
      // Given: A logged batch
      await logger.logBatchResults("my-batch", [createCallInput()]);

      // When: I check if batch is recorded
      const isRecorded = await logger.isRecorded("my-batch");

      // Then: Returns true
      expect(isRecorded).toBe(true);
    });
  });

  describe("test helpers", () => {
    describe("clear", () => {
      it("should clear all calls", () => {
        // Given: Some logged calls
        logger.logCall(createCallInput());
        logger.logCall(createCallInput());

        // When: I clear
        logger.clear();

        // Then: No calls remain
        expect(logger.getCallCount()).toBe(0);
        expect(logger.getAllCalls()).toHaveLength(0);
      });

      it("should clear recorded batch IDs", async () => {
        // Given: A recorded batch
        await logger.logBatchResults("batch-to-clear", [createCallInput()]);
        expect(await logger.isRecorded("batch-to-clear")).toBe(true);

        // When: I clear
        logger.clear();

        // Then: Batch is no longer recorded
        expect(await logger.isRecorded("batch-to-clear")).toBe(false);
      });
    });

    describe("getAllCalls", () => {
      it("should return all logged calls", () => {
        // Given: Multiple calls
        logger.logCall(createCallInput({ prompt: "First" }));
        logger.logCall(createCallInput({ prompt: "Second" }));
        logger.logCall(createCallInput({ prompt: "Third" }));

        // When: I get all calls
        const calls = logger.getAllCalls();

        // Then: All calls returned
        expect(calls).toHaveLength(3);
      });

      it("should return copies of calls", () => {
        // Given: A logged call
        logger.logCall(createCallInput());
        const calls1 = logger.getAllCalls();

        // When: I modify the returned call
        calls1[0]!.prompt = "Modified";

        // Then: Original is not affected
        const calls2 = logger.getAllCalls();
        expect(calls2[0]?.prompt).toBe("Test prompt");
      });
    });

    describe("getCallsByTopic", () => {
      it("should filter calls by exact topic", () => {
        // Given: Calls with different topics
        logger.logCall(createCallInput({ topic: "workflow.abc" }));
        logger.logCall(createCallInput({ topic: "workflow.abc.child" }));
        logger.logCall(createCallInput({ topic: "workflow.xyz" }));

        // When: I get calls by exact topic
        const calls = logger.getCallsByTopic("workflow.abc");

        // Then: Only exact match returned
        expect(calls).toHaveLength(1);
        expect(calls[0]?.topic).toBe("workflow.abc");
      });
    });

    describe("getCallsByTopicPrefix", () => {
      it("should filter calls by topic prefix", () => {
        // Given: Calls with different topics
        logger.logCall(createCallInput({ topic: "workflow.abc" }));
        logger.logCall(createCallInput({ topic: "workflow.abc.child" }));
        logger.logCall(createCallInput({ topic: "workflow.xyz" }));

        // When: I get calls by prefix
        const calls = logger.getCallsByTopicPrefix("workflow.abc");

        // Then: All matching prefix returned
        expect(calls).toHaveLength(2);
      });
    });

    describe("getCallsByModel", () => {
      it("should filter calls by model key", () => {
        // Given: Calls with different models
        logger.logCall(createCallInput({ modelKey: "gemini-2.5-flash" }));
        logger.logCall(createCallInput({ modelKey: "gemini-2.5-flash" }));
        logger.logCall(createCallInput({ modelKey: "gemini-2.5-pro" }));

        // When: I get calls by model
        const flashCalls = logger.getCallsByModel("gemini-2.5-flash");
        const proCalls = logger.getCallsByModel("gemini-2.5-pro");

        // Then: Filtered correctly
        expect(flashCalls).toHaveLength(2);
        expect(proCalls).toHaveLength(1);
      });
    });

    describe("getCallsByType", () => {
      it("should filter calls by call type", () => {
        // Given: Calls with different types
        logger.logCall(createCallInput({ callType: "text" }));
        logger.logCall(createCallInput({ callType: "text" }));
        logger.logCall(createCallInput({ callType: "object" }));
        logger.logCall(createCallInput({ callType: "embed" }));

        // When: I get calls by type
        const textCalls = logger.getCallsByType("text");
        const objectCalls = logger.getCallsByType("object");
        const embedCalls = logger.getCallsByType("embed");

        // Then: Filtered correctly
        expect(textCalls).toHaveLength(2);
        expect(objectCalls).toHaveLength(1);
        expect(embedCalls).toHaveLength(1);
      });
    });

    describe("getTotalCost", () => {
      it("should sum cost across all calls", () => {
        // Given: Calls with different costs
        logger.logCall(createCallInput({ cost: 0.01 }));
        logger.logCall(createCallInput({ cost: 0.02 }));
        logger.logCall(createCallInput({ cost: 0.03 }));

        // When: I get total cost
        const total = logger.getTotalCost();

        // Then: Sum is correct
        expect(total).toBeCloseTo(0.06);
      });
    });

    describe("getTotalTokens", () => {
      it("should sum tokens across all calls", () => {
        // Given: Calls with different token counts
        logger.logCall(createCallInput({ inputTokens: 100, outputTokens: 50 }));
        logger.logCall(
          createCallInput({ inputTokens: 200, outputTokens: 100 }),
        );
        logger.logCall(
          createCallInput({ inputTokens: 300, outputTokens: 150 }),
        );

        // When: I get total tokens
        const tokens = logger.getTotalTokens();

        // Then: Totals are correct
        expect(tokens.input).toBe(600);
        expect(tokens.output).toBe(300);
      });
    });

    describe("getRecordedBatchIds", () => {
      it("should return all recorded batch IDs", async () => {
        // Given: Multiple batches logged
        await logger.logBatchResults("batch-1", [createCallInput()]);
        await logger.logBatchResults("batch-2", [createCallInput()]);
        await logger.logBatchResults("batch-3", [createCallInput()]);

        // When: I get recorded batch IDs
        const batchIds = logger.getRecordedBatchIds();

        // Then: All batch IDs returned
        expect(batchIds).toHaveLength(3);
        expect(batchIds).toContain("batch-1");
        expect(batchIds).toContain("batch-2");
        expect(batchIds).toContain("batch-3");
      });
    });

    describe("getLastCall", () => {
      it("should return the most recent call", async () => {
        // Given: Multiple calls logged with small delays
        logger.logCall(createCallInput({ prompt: "First" }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        logger.logCall(createCallInput({ prompt: "Second" }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        logger.logCall(createCallInput({ prompt: "Last" }));

        // When: I get last call
        const lastCall = logger.getLastCall();

        // Then: Most recent call returned
        expect(lastCall?.prompt).toBe("Last");
      });

      it("should return null when no calls", () => {
        // Given: Empty logger
        // When: I get last call
        const lastCall = logger.getLastCall();

        // Then: Returns null
        expect(lastCall).toBeNull();
      });
    });

    describe("hasCallMatching", () => {
      it("should return true when matching call exists", () => {
        // Given: Some calls
        logger.logCall(
          createCallInput({ prompt: "Find me", callType: "text" }),
        );
        logger.logCall(
          createCallInput({ prompt: "Not this", callType: "object" }),
        );

        // When: I check for matching call
        const hasMatch = logger.hasCallMatching(
          (call) => call.prompt === "Find me" && call.callType === "text",
        );

        // Then: Returns true
        expect(hasMatch).toBe(true);
      });

      it("should return false when no matching call", () => {
        // Given: Some calls
        logger.logCall(createCallInput({ prompt: "Other" }));

        // When: I check for non-existent match
        const hasMatch = logger.hasCallMatching(
          (call) => call.prompt === "Does not exist",
        );

        // Then: Returns false
        expect(hasMatch).toBe(false);
      });
    });
  });
});
