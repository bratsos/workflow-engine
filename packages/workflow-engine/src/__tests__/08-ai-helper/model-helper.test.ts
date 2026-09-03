/**
 * Model Helper Tests
 *
 * Tests for the model helper utilities: getModel, calculateCost, ModelStatsTracker, etc.
 */

import { describe, expect, it } from "vitest";
import {
  AVAILABLE_MODELS,
  calculateCost,
  DEFAULT_MODEL_KEY,
  getDefaultModel,
  getModel,
  getRegisteredModel,
  listModels,
  listRegisteredModels,
  type ModelConfig,
  ModelStatsTracker,
  modelSupportsBatch,
  registerModels,
} from "../../ai/model-helper.js";
import {
  calculateBatchCost,
  calculateCostWithDiscount,
  getModelProvider,
} from "../../ai/shared.js";

describe("I want to use model helper utilities", () => {
  describe("getModel", () => {
    it("should return model config for valid model key", () => {
      // When: I get a model by key
      const model = getModel("gemini-2.5-flash");

      // Then: Returns the model config
      expect(model).toBeDefined();
      expect(model.id).toBe("google/gemini-2.5-flash-preview-09-2025");
      expect(model.name).toBe("Gemini 2.5 Flash Preview");
    });

    it("should throw for invalid model key", () => {
      // When/Then: Getting invalid model throws
      expect(() => getModel("invalid-model")).toThrow(/not found/);
    });
  });

  describe("getDefaultModel", () => {
    it("should return the default model config", () => {
      // When: I get the default model
      const model = getDefaultModel();

      // Then: Returns the default model
      expect(model).toBeDefined();
      expect(model.id).toContain("gemini");
    });
  });

  describe("calculateCost", () => {
    it("should calculate cost based on token usage", () => {
      // Given: Token counts
      const inputTokens = 1_000_000; // 1M tokens
      const outputTokens = 500_000; // 0.5M tokens

      // When: I calculate cost
      const cost = calculateCost("gemini-2.5-flash", inputTokens, outputTokens);

      // Then: Cost is calculated correctly
      // gemini-2.5-flash: $0.3/1M in, $2.5/1M out
      expect(cost.inputCost).toBeCloseTo(0.3, 2); // $0.30 for 1M input
      expect(cost.outputCost).toBeCloseTo(1.25, 2); // $1.25 for 0.5M output
      expect(cost.totalCost).toBeCloseTo(1.55, 2);
    });

    it("should return zero for zero tokens", () => {
      // When: I calculate cost with zero tokens
      const cost = calculateCost("gemini-2.5-flash", 0, 0);

      // Then: Cost is zero
      expect(cost.inputCost).toBe(0);
      expect(cost.outputCost).toBe(0);
      expect(cost.totalCost).toBe(0);
    });

    it("should handle small token counts", () => {
      // When: I calculate cost for small usage
      const cost = calculateCost("gemini-2.5-flash", 1000, 500);

      // Then: Cost is proportionally small
      expect(cost.totalCost).toBeLessThan(0.01);
      expect(cost.totalCost).toBeGreaterThan(0);
    });
  });

  describe("ModelStatsTracker", () => {
    describe("single model tracking", () => {
      it("should track API calls", () => {
        // Given: A tracker
        const tracker = new ModelStatsTracker("gemini-2.5-flash");

        // When: I record calls
        tracker.recordCall(100, 50);
        tracker.recordCall(200, 100);

        // Then: Stats are aggregated
        const stats = tracker.getStats();
        expect(stats?.apiCalls).toBe(2);
        expect(stats?.inputTokens).toBe(300);
        expect(stats?.outputTokens).toBe(150);
      });

      it("should calculate costs from recorded calls", () => {
        // Given: A tracker with calls
        const tracker = new ModelStatsTracker("gemini-2.5-flash");
        tracker.recordCall(1_000_000, 500_000);

        // When: I get stats
        const stats = tracker.getStats();

        // Then: Cost is calculated
        expect(stats?.totalCost).toBeGreaterThan(0);
        expect(stats?.inputCost).toBeCloseTo(0.3, 2);
      });

      it("should return model info", () => {
        // Given: A tracker
        const tracker = new ModelStatsTracker("gemini-2.5-flash");

        // When: I get stats
        const stats = tracker.getStats();

        // Then: Model info is included
        expect(stats?.modelId).toContain("gemini");
        expect(stats?.modelName).toContain("Gemini");
      });

      it("should reset stats", () => {
        // Given: A tracker with calls
        const tracker = new ModelStatsTracker("gemini-2.5-flash");
        tracker.recordCall(100, 50);
        expect(tracker.getStats()?.apiCalls).toBe(1);

        // When: I reset
        tracker.reset();

        // Then: Stats are cleared
        expect(tracker.getStats()?.apiCalls).toBe(0);
        expect(tracker.getStats()?.inputTokens).toBe(0);
      });
    });

    describe("aggregating tracker", () => {
      it("should create aggregating tracker", () => {
        // When: I create an aggregating tracker
        const tracker = ModelStatsTracker.createAggregating();

        // Then: getStats returns null (use getAggregatedStats instead)
        expect(tracker.getStats()).toBeNull();
      });

      it("should track calls with model override", () => {
        // Given: An aggregating tracker
        const tracker = ModelStatsTracker.createAggregating();

        // When: I record calls with model override
        tracker.recordCall(100, 50, "gemini-2.5-flash");
        tracker.recordCall(200, 100, "gemini-2.5-flash");

        // Then: Stats are aggregated
        const { totals } = tracker.getAggregatedStats();
        expect(totals.totalApiCalls).toBe(2);
        expect(totals.totalInputTokens).toBe(300);
        expect(totals.totalOutputTokens).toBe(150);
      });

      it("should track per-model stats", () => {
        // Given: An aggregating tracker with multiple model calls
        const tracker = ModelStatsTracker.createAggregating();
        tracker.recordCall(100, 50, "gemini-2.5-flash");
        tracker.recordCall(100, 50, "gemini-2.5-flash");

        // When: I get aggregated stats
        const { perModel } = tracker.getAggregatedStats();

        // Then: Per-model breakdown is available
        expect(perModel).toHaveLength(1);
        expect(perModel[0]?.apiCalls).toBe(2);
      });

      it("should reset aggregated stats", () => {
        // Given: An aggregating tracker with calls
        const tracker = ModelStatsTracker.createAggregating();
        tracker.recordCall(100, 50, "gemini-2.5-flash");

        // When: I reset
        tracker.reset();

        // Then: Stats are cleared
        const { totals } = tracker.getAggregatedStats();
        expect(totals.totalApiCalls).toBe(0);
      });
    });

    describe("getModelById", () => {
      it("should return model helper with bound recordCall", () => {
        // Given: A tracker
        const tracker = new ModelStatsTracker("gemini-2.5-flash");

        // When: I get model by ID
        const model = tracker.getModelById("gemini-2.5-flash");

        // Then: Returns helper with id and name
        expect(model.id).toContain("gemini");
        expect(model.name).toContain("Gemini");
        expect(typeof model.recordCall).toBe("function");
      });

      it("should record calls through bound function", () => {
        // Given: A tracker with model helper
        const tracker = new ModelStatsTracker("gemini-2.5-flash");
        const model = tracker.getModelById("gemini-2.5-flash");

        // When: I record via bound function
        model.recordCall(100, 50);

        // Then: Stats are updated
        const stats = tracker.getStats();
        expect(stats?.apiCalls).toBe(1);
        expect(stats?.inputTokens).toBe(100);
      });
    });
  });

  describe("listModels", () => {
    it("should list all models", () => {
      // When: I list models without filter
      const models = listModels();

      // Then: Returns array of models
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it("should filter by supportsAsyncBatch", () => {
      // When: I list models that support batching
      const models = listModels({ supportsAsyncBatch: true });

      // Then: All returned models support batching
      for (const { config } of models) {
        expect(config.supportsAsyncBatch).toBe(true);
      }
    });

    it("should filter by isEmbeddingModel", () => {
      // When: I list non-embedding models
      const models = listModels({ isEmbeddingModel: false });

      // Then: No embedding models returned
      for (const { config } of models) {
        expect(config.isEmbeddingModel).toBeFalsy();
      }
    });

    it("should return models sorted by key", () => {
      // When: I list models
      const models = listModels();

      // Then: Models are sorted
      const keys = models.map((m) => m.key);
      const sorted = [...keys].sort((a, b) => a.localeCompare(b));
      expect(keys).toEqual(sorted);
    });
  });

  describe("modelSupportsBatch", () => {
    it("should return true for batch-compatible model", () => {
      // When: I check a batch-compatible model
      const supports = modelSupportsBatch("gemini-2.5-flash");

      // Then: Returns true
      expect(supports).toBe(true);
    });
  });

  describe("model registration", () => {
    // Note: registerModels modifies global state, so these tests verify the API
    // rather than isolation

    it("should register custom models", () => {
      // Given: A custom model config
      const customModels: Record<string, ModelConfig> = {
        "test-custom-model": {
          id: "test/custom-model",
          name: "Test Custom Model",
          inputCostPerMillion: 1.0,
          outputCostPerMillion: 2.0,
          provider: "other",
        },
      };

      // When: I register the model
      registerModels(customModels);

      // Then: Model is retrievable
      const model = getRegisteredModel("test-custom-model");
      expect(model?.name).toBe("Test Custom Model");
    });

    it("should list registered models", () => {
      // Given: Some registered models (from previous test or setup)
      // When: I list registered models
      const models = listRegisteredModels();

      // Then: Returns array
      expect(Array.isArray(models)).toBe(true);
    });
  });

  describe("AVAILABLE_MODELS", () => {
    it("should include gemini-2.5-flash", () => {
      // Then: Default model is available
      expect(AVAILABLE_MODELS["gemini-2.5-flash"]).toBeDefined();
    });
  });

  describe("DEFAULT_MODEL_KEY", () => {
    it("should be gemini-2.5-flash", () => {
      // Then: Default is correct
      expect(DEFAULT_MODEL_KEY).toBe("gemini-2.5-flash");
    });
  });

  describe("calculateBatchCost and calculateCostWithDiscount", () => {
    it("should calculate batch cost using absolute batch prices when available", () => {
      const modelWithBatchPrices: ModelConfig = {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        inputCostPerMillion: 3,
        outputCostPerMillion: 15,
        provider: "openrouter",
        supportsAsyncBatch: true,
        batchModelId: "anthropic/claude-sonnet-4.5:batch",
        batchInputCostPerMillion: 1.5,
        batchOutputCostPerMillion: 7.5,
      };

      // 1M input, 1M output with batch prices: 1.5 + 7.5 = 9.0
      const cost = calculateBatchCost(
        modelWithBatchPrices,
        1_000_000,
        1_000_000,
      );
      expect(cost).toBeCloseTo(9.0, 4);
    });

    it("should not apply batchDiscountPercent when absolute batch prices are present (avoid double discount)", () => {
      const modelWithBoth: ModelConfig = {
        id: "test/model",
        name: "Test Model",
        inputCostPerMillion: 10,
        outputCostPerMillion: 20,
        provider: "openrouter",
        supportsAsyncBatch: true,
        batchDiscountPercent: 50,
        batchInputCostPerMillion: 2.5, // non-standard discount
        batchOutputCostPerMillion: 5.0,
      };

      // 1M input, 1M output: 2.5 + 5.0 = 7.5 (NOT halved again to 3.75)
      const cost = calculateBatchCost(modelWithBoth, 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(7.5, 4);
    });

    it("should fall back to batchDiscountPercent when absolute batch prices are not set", () => {
      const modelWithPercentOnly: ModelConfig = {
        id: "google/gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        inputCostPerMillion: 0.3,
        outputCostPerMillion: 2.5,
        provider: "openrouter",
        supportsAsyncBatch: true,
        batchDiscountPercent: 50,
      };

      // 1M input ($0.30) + 1M output ($2.50) = $2.80 base; 50% off = $1.40
      const cost = calculateBatchCost(
        modelWithPercentOnly,
        1_000_000,
        1_000_000,
      );
      expect(cost).toBeCloseTo(1.4, 4);
    });

    it("should return undiscounted base cost when neither batch prices nor discount percent is set", () => {
      const regularModel: ModelConfig = {
        id: "some/model",
        name: "Some Model",
        inputCostPerMillion: 1.0,
        outputCostPerMillion: 2.0,
        provider: "openrouter",
      };

      const cost = calculateBatchCost(regularModel, 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(3.0, 4);
    });

    it("calculateCostWithDiscount should respect isBatch flag", () => {
      registerModels({
        "batch-pricing-test-model": {
          id: "test/batch-pricing",
          name: "Test Batch Pricing",
          inputCostPerMillion: 4,
          outputCostPerMillion: 10,
          provider: "openrouter",
          batchInputCostPerMillion: 1,
          batchOutputCostPerMillion: 2,
        },
      });

      // Non-batch call
      const regularCost = calculateCostWithDiscount(
        "batch-pricing-test-model",
        1_000_000,
        1_000_000,
        false,
      );
      expect(regularCost).toBeCloseTo(14, 4);

      // Batch call
      const batchCost = calculateCostWithDiscount(
        "batch-pricing-test-model",
        1_000_000,
        1_000_000,
        true,
      );
      expect(batchCost).toBeCloseTo(3, 4);
    });
  });

  describe("getModelProvider OpenRouter routing options", () => {
    it("should create provider with default routing options", () => {
      const model: ModelConfig = {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        inputCostPerMillion: 3,
        outputCostPerMillion: 15,
        provider: "openrouter",
      };

      const provider = getModelProvider(model);
      expect(provider).toBeDefined();
    });

    it("should support custom routing options", () => {
      const model: ModelConfig = {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        inputCostPerMillion: 3,
        outputCostPerMillion: 15,
        provider: "openrouter",
      };

      const providerWithZeroHeadroom = getModelProvider(model, {
        priceHeadroom: 0,
        sort: "price",
        requireParameters: false,
      });
      expect(providerWithZeroHeadroom).toBeDefined();
    });
  });
});
