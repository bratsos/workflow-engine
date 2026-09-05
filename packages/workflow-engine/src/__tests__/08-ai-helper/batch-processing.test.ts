/**
 * Batch Processing Tests
 *
 * Tests for the batch functionality of AIHelper.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAIHelper } from "../../ai/ai-helper.js";
import { AIBatchImpl } from "../../ai/batch-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import {
  createMockAIHelper,
  MockAIBatch,
  MockAIHelper,
} from "../utils/mock-ai-helper.js";

describe("I want to process AI requests in batches", () => {
  let ai: MockAIHelper;

  beforeEach(() => {
    ai = createMockAIHelper("test.batch-processing");
  });

  describe("batch creation", () => {
    it("should create a batch for a model", () => {
      // Given: A mock AI helper
      // When: I create a batch
      const batch = ai.batch("gemini-2.5-flash");

      // Then: Batch object is returned
      expect(batch).toBeDefined();
      expect(typeof batch.submit).toBe("function");
      expect(typeof batch.getStatus).toBe("function");
      expect(typeof batch.getResults).toBe("function");
    });

    it("should create batch with provider", () => {
      // Given: A mock AI helper
      // When: I create a batch with specific provider
      const batch = ai.batch("gemini-2.5-flash", "google");

      // Then: Batch object is returned
      expect(batch).toBeDefined();
    });

    it("should support different providers", () => {
      // Given: Different providers
      // When: I create batches
      const googleBatch = ai.batch("gemini-2.5-flash", "google");
      const anthropicBatch = ai.batch("claude-3-5-sonnet", "anthropic");
      const openaiBatch = ai.batch("gpt-4o", "openai");
      const openrouterBatch = ai.batch("gemini-2.5-flash", "openrouter");

      // Then: All batches are created
      expect(googleBatch).toBeDefined();
      expect(anthropicBatch).toBeDefined();
      expect(openaiBatch).toBeDefined();
      expect(openrouterBatch).toBeDefined();
    });
  });

  describe("batch submission", () => {
    it("should submit batch requests", async () => {
      // Given: A batch
      const batch = ai.batch("gemini-2.5-flash");

      // When: I submit requests
      const handle = await batch.submit([
        { id: "req-1", prompt: "First prompt" },
        { id: "req-2", prompt: "Second prompt" },
      ]);

      // Then: Returns batch handle
      expect(handle.id).toBeDefined();
      expect(handle.status).toBe("pending");
    });

    it("should generate unique batch IDs", async () => {
      // Given: A batch
      const batch = ai.batch("gemini-2.5-flash");

      // When: I submit multiple batches
      const handle1 = await batch.submit([{ id: "req-1", prompt: "Prompt 1" }]);
      const handle2 = await batch.submit([{ id: "req-2", prompt: "Prompt 2" }]);

      // Then: Each has unique ID
      expect(handle1.id).not.toBe(handle2.id);
    });

    it("should accept requests with schema", async () => {
      // Given: A batch and schema
      const batch = ai.batch("gemini-2.5-flash");
      const schema = z.object({ name: z.string(), value: z.number() });

      // When: I submit with schema
      const handle = await batch.submit([
        { id: "req-1", prompt: "Extract data", schema },
      ]);

      // Then: Batch is submitted
      expect(handle.id).toBeDefined();
    });

    it("should handle empty request array", async () => {
      // Given: A batch
      const batch = ai.batch("gemini-2.5-flash");

      // When: I submit empty array
      const handle = await batch.submit([]);

      // Then: Handle is returned (implementation may vary)
      expect(handle.id).toBeDefined();
    });

    it("should handle single request", async () => {
      // Given: A batch
      const batch = ai.batch("gemini-2.5-flash");

      // When: I submit single request
      const handle = await batch.submit([{ id: "single", prompt: "Single" }]);

      // Then: Batch is created
      expect(handle.id).toBeDefined();
    });

    it("should handle many requests", async () => {
      // Given: A batch with many requests
      const batch = ai.batch("gemini-2.5-flash");
      const requests = Array.from({ length: 100 }, (_, i) => ({
        id: `req-${i}`,
        prompt: `Prompt ${i}`,
      }));

      // When: I submit
      const handle = await batch.submit(requests);

      // Then: Batch is created
      expect(handle.id).toBeDefined();
    });
  });

  describe("batch status", () => {
    it("should return pending status initially", async () => {
      // Given: A submitted batch
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      // When: I check status immediately
      const status = await batch.getStatus(handle.id);

      // Then: Status is pending
      expect(status.status).toBe("pending");
    });

    it("should return completed status after processing", async () => {
      // Given: A submitted batch
      const batch = ai.batch("gemini-2.5-flash") as MockAIBatch;
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      // Mark processing complete (synchronous test hook, no real timer)
      batch.setStatus(handle.id, "completed");

      // When: I check status
      const status = await batch.getStatus(handle.id);

      // Then: Status is completed
      expect(status.status).toBe("completed");
    });

    it("should include batch ID in status", async () => {
      // Given: A submitted batch
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      // When: I check status
      const status = await batch.getStatus(handle.id);

      // Then: ID matches
      expect(status.id).toBe(handle.id);
    });

    it("should include provider in status", async () => {
      // Given: A submitted batch
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      // When: I check status
      const status = await batch.getStatus(handle.id);

      // Then: Provider is included
      expect(status.provider).toBe("google");
    });
  });

  describe("batch results", () => {
    it("should return results for each request", async () => {
      // Given: A submitted batch
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([
        { id: "req-1", prompt: "First" },
        { id: "req-2", prompt: "Second" },
        { id: "req-3", prompt: "Third" },
      ]);

      // When: I get results
      const results = await batch.getResults(handle.id);

      // Then: Result for each request
      expect(results).toHaveLength(3);
    });

    it("should include request IDs in results", async () => {
      // Given: A submitted batch
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([
        { id: "custom-id-1", prompt: "Test 1" },
        { id: "custom-id-2", prompt: "Test 2" },
      ]);

      // When: I get results
      const results = await batch.getResults(handle.id);

      // Then: IDs match
      expect(results[0]?.id).toBe("custom-id-1");
      expect(results[1]?.id).toBe("custom-id-2");
    });

    it("should include token counts in results", async () => {
      // Given: A submitted batch
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      // When: I get results
      const results = await batch.getResults(handle.id);

      // Then: Token counts included
      expect(results[0]?.inputTokens).toBeDefined();
      expect(results[0]?.outputTokens).toBeDefined();
    });

    it("should include status in results", async () => {
      // Given: A submitted batch
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      // When: I get results
      const results = await batch.getResults(handle.id);

      // Then: Status is succeeded
      expect(results[0]?.status).toBe("succeeded");
    });

    it("should throw for unknown batch ID", async () => {
      // Given: A batch
      const batch = ai.batch("gemini-2.5-flash");

      // When/Then: Getting results for unknown ID throws
      await expect(batch.getResults("unknown-batch-id")).rejects.toThrow();
    });
  });

  describe("batch recording", () => {
    it("should record batch calls", async () => {
      // Given: A submitted batch
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      await batch.getResults(handle.id);

      // Then: Batch calls are recorded
      const batchCalls = ai.getCallsByType("batch");
      expect(batchCalls.length).toBeGreaterThan(0);
    });

    it("should track batch recording status", async () => {
      // Given: A batch
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      // Initially not recorded
      expect(await batch.isRecorded(handle.id)).toBe(false);

      await batch.getResults(handle.id);

      // Then: Is recorded
      expect(await batch.isRecorded(handle.id)).toBe(true);
    });

    it("should not duplicate recording on repeated getResults", async () => {
      // Given: A batch with recorded results
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      // When: I call getResults multiple times
      await batch.getResults(handle.id);
      const callsAfterFirst = ai.getCallsByType("batch").length;

      await batch.getResults(handle.id);
      const callsAfterSecond = ai.getCallsByType("batch").length;

      // Then: No duplicate recordings
      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });

  describe("batch recordResults", () => {
    it("should manually record results", async () => {
      // Given: A batch and manual results
      const batch = ai.batch("gemini-2.5-flash");
      const batchId = "manual-batch-123";

      // When: I manually record results
      await batch.recordResults(batchId, [
        {
          id: "req-1",
          prompt: "Test prompt",
          result: "Test result",
          inputTokens: 50,
          outputTokens: 25,
          status: "succeeded",
        },
      ]);

      // Then: Results are recorded
      const batchCalls = ai.getCallsByType("batch");
      expect(batchCalls.length).toBeGreaterThan(0);
    });

    it("should record multiple results", async () => {
      // Given: Multiple results
      const batch = ai.batch("gemini-2.5-flash");
      const batchId = "multi-batch-123";

      // When: I record multiple results
      await batch.recordResults(batchId, [
        {
          id: "req-1",
          prompt: "P1",
          result: "R1",
          inputTokens: 10,
          outputTokens: 5,
          status: "succeeded",
        },
        {
          id: "req-2",
          prompt: "P2",
          result: "R2",
          inputTokens: 20,
          outputTokens: 10,
          status: "succeeded",
        },
        {
          id: "req-3",
          prompt: "P3",
          result: "R3",
          inputTokens: 30,
          outputTokens: 15,
          status: "succeeded",
        },
      ]);

      // Then: All recorded
      const batchCalls = ai.getCallsByType("batch");
      expect(batchCalls.length).toBe(3);
    });

    it("should not re-record already recorded batch", async () => {
      // Given: Already recorded batch
      const batch = ai.batch("gemini-2.5-flash");
      const batchId = "recorded-batch-123";

      await batch.recordResults(batchId, [
        {
          id: "req-1",
          prompt: "P",
          result: "R",
          inputTokens: 10,
          outputTokens: 5,
          status: "succeeded",
        },
      ]);

      const countAfterFirst = ai.getCallsByType("batch").length;

      // When: I try to record again
      await batch.recordResults(batchId, [
        {
          id: "req-1",
          prompt: "P",
          result: "R",
          inputTokens: 10,
          outputTokens: 5,
          status: "succeeded",
        },
      ]);

      // Then: No duplicate
      expect(ai.getCallsByType("batch").length).toBe(countAfterFirst);
    });
  });

  describe("batch with typed results", () => {
    it("should return typed results", async () => {
      // Given: A typed batch
      interface MyResult {
        name: string;
        score: number;
      }
      const batch = ai.batch<MyResult>("gemini-2.5-flash");
      const handle = await batch.submit([
        { id: "req-1", prompt: "Get result" },
      ]);

      // When: I get results
      const results = await batch.getResults(handle.id);

      // Then: Results have result field
      expect(results[0]?.result).toBeDefined();
    });

    it("should handle string results", async () => {
      // Given: A string batch (default)
      const batch = ai.batch<string>("gemini-2.5-flash");
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      // When: I get results
      const results = await batch.getResults(handle.id);

      // Then: Result is string
      expect(typeof results[0]?.result).toBe("string");
    });
  });

  describe("batch statistics", () => {
    it("should include batch calls in stats", async () => {
      // Given: A batch with results
      const batch = ai.batch("gemini-2.5-flash");
      const handle = await batch.submit([
        { id: "req-1", prompt: "Test 1" },
        { id: "req-2", prompt: "Test 2" },
      ]);

      await batch.getResults(handle.id);

      // When: I get stats
      const stats = await ai.getStats();

      // Then: Batch calls are counted
      expect(stats.totalCalls).toBeGreaterThan(0);
    });
  });

  describe("child helper batch", () => {
    it("should create batch from child helper", async () => {
      // Given: A child helper
      const child = ai.createChild("child") as MockAIHelper;

      // When: I create a batch from child
      const batch = child.batch("gemini-2.5-flash");

      // Then: Batch is created
      expect(batch).toBeDefined();
    });

    it("should track batch calls in child", async () => {
      // Given: A child helper batch
      const child = ai.createChild("child") as MockAIHelper;
      const batch = child.batch("gemini-2.5-flash");
      const handle = await batch.submit([{ id: "req-1", prompt: "Test" }]);

      await batch.getResults(handle.id);

      // Then: Child has batch calls
      const childBatchCalls = child.getCallsByType("batch");
      expect(childBatchCalls.length).toBeGreaterThan(0);
    });
  });

  describe("batch error scenarios", () => {
    it("should handle failed results", async () => {
      // Given: A batch with mock failure
      const batch = ai.batch("gemini-2.5-flash");
      const batchId = "failed-batch-123";

      // When: I record a failed result
      await batch.recordResults(batchId, [
        {
          id: "req-1",
          prompt: "Failed prompt",
          inputTokens: 0,
          outputTokens: 0,
          status: "failed",
          error: "Rate limit exceeded",
        },
      ]);

      // Then: Failed result is recorded
      const batchCalls = ai.getCallsByType("batch");
      expect(batchCalls.length).toBeGreaterThan(0);
    });

    it("should include error in failed result", async () => {
      // Given: A batch with error handling
      const batch = ai.batch("gemini-2.5-flash");
      const batchId = "error-batch-123";

      // When: I record with error
      await batch.recordResults(batchId, [
        {
          id: "req-1",
          prompt: "Test",
          inputTokens: 0,
          outputTokens: 0,
          status: "failed",
          error: "Service unavailable",
        },
      ]);

      // Then: Error would be in metadata (implementation specific)
      expect(await batch.isRecorded(batchId)).toBe(true);
    });
  });
});

describe("AIBatchImpl and AIHelper batch wiring", () => {
  function makeFakeAICallLogger() {
    const loggedBatchResults: Array<{ batchId: string; records: any[] }> = [];
    return {
      logger: {
        logCall: vi.fn(),
        getStats: vi.fn().mockResolvedValue({
          totalCalls: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCost: 0,
          perModel: {},
        }),
        isRecorded: vi.fn().mockResolvedValue(false),
        logBatchResults: vi.fn(async (batchId: string, records: any[]) => {
          loggedBatchResults.push({ batchId, records });
        }),
        getCalls: vi.fn().mockResolvedValue([]),
      },
      loggedBatchResults,
    };
  }

  it("P6a: throws an actionable error when model has no batch-capable provider", () => {
    registerModels({
      "test-no-batch-model": {
        id: "custom/no-batch-model",
        name: "No Batch Model",
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        supportsAsyncBatch: false,
        provider: "custom",
      },
    });

    const { logger } = makeFakeAICallLogger();
    const ai = createAIHelper("test", logger as any);

    expect(() => ai.batch("test-no-batch-model")).toThrowError(
      /No known batch-capable provider found for model "test-no-batch-model"/,
    );
  });

  it("P8 & P9: partitions by schema and respects maxRequestsPerBatch", async () => {
    const startCalls: any[] = [];
    const mockBatchModel = {
      provider: "mock-openrouter",
      modelId: "openai/gpt-4o",
      start: vi.fn(async (requests: any[]) => {
        startCalls.push(requests);
        return {
          version: 1 as const,
          type: "text" as const,
          id: `batch-${startCalls.length}`,
          provider: "mock-openrouter",
          modelId: "openai/gpt-4o",
          status: "pending" as const,
        };
      }),
      status: vi.fn(async () => ({ status: "completed" as const })),
      results: vi.fn(async function* () {}),
    };

    const { logger } = makeFakeAICallLogger();
    const ctx = {
      topic: "test",
      aiCallLogger: logger as any,
    };

    const schemaA = z.object({ a: z.string() });
    const schemaB = z.object({ b: z.number() });

    const batch = new AIBatchImpl(
      ctx,
      "gemini-2.5-flash",
      "openrouter",
      undefined,
      {
        apiKey: "test-key",
        maxRequestsPerBatch: 2,
      },
    );

    (batch as any).providerPromise = Promise.resolve(mockBatchModel);

    // 3 requests with schemaA, 1 with schemaB, 1 without schema
    const handle = await batch.submit([
      { id: "a1", prompt: "p1", schema: schemaA },
      { id: "a2", prompt: "p2", schema: schemaA },
      { id: "a3", prompt: "p3", schema: schemaA },
      { id: "b1", prompt: "p4", schema: schemaB },
      { id: "c1", prompt: "p5" },
    ]);

    // schemaA has 3 requests -> chunked into [2, 1] due to maxRequestsPerBatch = 2
    // schemaB has 1 request -> [1]
    // none has 1 request -> [1]
    // Total partitions: 4
    expect(startCalls.length).toBe(4);
    expect(handle.batchIds).toEqual([
      "batch-1",
      "batch-2",
      "batch-3",
      "batch-4",
    ]);
    expect(handle.id).toBe("batch-1");
    expect(handle.refs?.length).toBe(4);
  });

  it("P9: throws when number of partitions exceeds maxPartitions", async () => {
    const mockBatchModel = {
      provider: "mock",
      modelId: "m",
      start: vi.fn(),
      status: vi.fn(),
      results: vi.fn(),
    };

    const { logger } = makeFakeAICallLogger();
    const ctx = { topic: "test", aiCallLogger: logger as any };

    const batch = new AIBatchImpl(
      ctx,
      "gemini-2.5-flash",
      "openrouter",
      undefined,
      {
        apiKey: "test-key",
        maxRequestsPerBatch: 1,
        maxPartitions: 2,
      },
    );
    (batch as any).providerPromise = Promise.resolve(mockBatchModel);

    await expect(
      batch.submit([
        { id: "r1", prompt: "p1" },
        { id: "r2", prompt: "p2" },
        { id: "r3", prompt: "p3" },
      ]),
    ).rejects.toThrowError(
      /Batch submission produced 3 partitions, exceeding the maximum allowed limit of 2/,
    );
  });

  it("P6e: rejects missing custom ID with failed result", async () => {
    const mockBatchModel = {
      provider: "mock",
      modelId: "m",
      start: vi.fn(),
      status: vi.fn(),
      results: vi.fn(async function* () {
        yield {
          id: "",
          status: "succeeded" as const,
          text: "output",
          inputTokens: 5,
          outputTokens: 5,
        };
      }),
    };

    const { logger } = makeFakeAICallLogger();
    const ctx = { topic: "test", aiCallLogger: logger as any };
    const batch = new AIBatchImpl(ctx, "gemini-2.5-flash", "openrouter");
    (batch as any).providerPromise = Promise.resolve(mockBatchModel);

    const results = await batch.getResults("batch-test");
    expect(results.length).toBe(1);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toContain("Missing or empty custom ID");
    expect(results[0]?.validated).toBe(false);
  });

  it("Fan-in: getStatus aggregates status across multiple batch refs", async () => {
    const mockBatchModel = {
      provider: "mock",
      modelId: "m",
      start: vi.fn(),
      status: vi.fn(async (ref: { id: string }) => {
        if (ref.id === "b1") {
          return {
            status: "completed" as const,
            requestCounts: { total: 2, completed: 2, failed: 0, pending: 0 },
          };
        }
        return {
          status: "processing" as const,
          requestCounts: { total: 2, completed: 1, failed: 0, pending: 1 },
        };
      }),
      results: vi.fn(),
    };

    const { logger } = makeFakeAICallLogger();
    const ctx = { topic: "test", aiCallLogger: logger as any };
    const batch = new AIBatchImpl(ctx, "gemini-2.5-flash", "openrouter");
    (batch as any).providerPromise = Promise.resolve(mockBatchModel);

    (batch as any).refsByBatch.set("b1", [
      { version: 1, type: "text", id: "b1", provider: "mock", modelId: "m" },
      { version: 1, type: "text", id: "b2", provider: "mock", modelId: "m" },
    ]);

    const status = await batch.getStatus("b1");
    expect(status.status).toBe("processing");
    expect(status.requestCounts).toEqual({
      total: 4,
      completed: 3,
      failed: 0,
    });
  });

  it("isRecorded and recordResults work without provider credentials", async () => {
    const { logger, loggedBatchResults } = makeFakeAICallLogger();
    const ctx = { topic: "test-topic", aiCallLogger: logger as any };

    // No API key provided!
    const batch = new AIBatchImpl(ctx, "gemini-2.5-flash", "openrouter");

    expect(await batch.isRecorded("b123")).toBe(false);

    await batch.recordResults("b123", [
      {
        id: "r1",
        prompt: "hello",
        result: "world",
        inputTokens: 100,
        outputTokens: 200,
        status: "succeeded",
        validated: true,
      },
    ]);

    expect(loggedBatchResults.length).toBe(1);
    expect(loggedBatchResults[0]?.batchId).toBe("b123");
    expect(loggedBatchResults[0]?.records[0]?.cost).toBeGreaterThan(0);
  });
});
