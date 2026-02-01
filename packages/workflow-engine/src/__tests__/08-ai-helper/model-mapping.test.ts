/**
 * Batch Model Mapping Tests
 *
 * Tests for the batch model mapping utilities.
 */

import { describe, expect, it } from "vitest";
import {
  BatchProviderName,
  getBatchCompatibleModels,
  getBestProviderForModel,
  getProviderModelId,
  getSupportedModels,
  isModelSupported,
} from "../../utils/batch/model-mapping.js";

describe("I want to use batch model mapping utilities", () => {
  describe("BatchProviderName", () => {
    it("should validate valid provider names", () => {
      // When: I parse valid providers
      expect(BatchProviderName.parse("google")).toBe("google");
      expect(BatchProviderName.parse("anthropic")).toBe("anthropic");
      expect(BatchProviderName.parse("openai")).toBe("openai");
    });

    it("should reject invalid provider names", () => {
      // When/Then: Invalid provider throws
      expect(() => BatchProviderName.parse("invalid")).toThrow();
    });
  });

  describe("getProviderModelId", () => {
    it("should return model ID for compatible google model", () => {
      // Given: gemini-2.5-flash is a Google model that supports batching
      // When: I get the provider model ID
      const modelId = getProviderModelId("gemini-2.5-flash", "google");

      // Then: Returns the native model ID (without google/ prefix)
      expect(modelId).toBeDefined();
      expect(modelId).not.toContain("google/");
    });

    it("should return undefined for incompatible provider", () => {
      // Given: gemini-2.5-flash is NOT an Anthropic or OpenAI model
      // When: I check with wrong provider
      const anthropicId = getProviderModelId("gemini-2.5-flash", "anthropic");
      const openaiId = getProviderModelId("gemini-2.5-flash", "openai");

      // Then: Returns undefined
      expect(anthropicId).toBeUndefined();
      expect(openaiId).toBeUndefined();
    });
  });

  describe("getSupportedModels", () => {
    it("should return array of supported model IDs for google", () => {
      // When: I get supported models for Google
      const models = getSupportedModels("google");

      // Then: Returns array
      expect(Array.isArray(models)).toBe(true);
    });

    it("should include gemini models for google", () => {
      // When: I get supported models for Google
      const models = getSupportedModels("google");

      // Then: Includes gemini models
      const hasGemini = models.some((id) => id.includes("gemini"));
      expect(hasGemini).toBe(true);
    });

    it("should return empty array for providers without models", () => {
      // Given: Only gemini-2.5-flash is in AVAILABLE_MODELS by default
      // When: I get supported models for Anthropic (no Claude models in default)
      const models = getSupportedModels("anthropic");

      // Then: Returns empty array (no Anthropic models in default registry)
      expect(models).toEqual([]);
    });
  });

  describe("isModelSupported", () => {
    it("should return true for supported model/provider combo", () => {
      // When: I check gemini with google
      const supported = isModelSupported("gemini-2.5-flash", "google");

      // Then: Returns true
      expect(supported).toBe(true);
    });

    it("should return false for unsupported model/provider combo", () => {
      // When: I check gemini with anthropic
      const supported = isModelSupported("gemini-2.5-flash", "anthropic");

      // Then: Returns false
      expect(supported).toBe(false);
    });
  });

  describe("getBestProviderForModel", () => {
    it("should return google for gemini model", () => {
      // When: I get best provider for gemini
      const provider = getBestProviderForModel("gemini-2.5-flash");

      // Then: Returns google
      expect(provider).toBe("google");
    });
  });

  describe("getBatchCompatibleModels", () => {
    it("should return array of batch-compatible models", () => {
      // When: I get batch-compatible models
      const models = getBatchCompatibleModels();

      // Then: Returns array
      expect(Array.isArray(models)).toBe(true);
    });

    it("should include models that support async batch", () => {
      // When: I get batch-compatible models
      const models = getBatchCompatibleModels();

      // Then: All have supportsAsyncBatch
      for (const { config } of models) {
        expect(config.supportsAsyncBatch).toBe(true);
      }
    });

    it("should not include embedding models", () => {
      // When: I get batch-compatible models
      const models = getBatchCompatibleModels();

      // Then: None are embedding models
      for (const { config } of models) {
        expect(config.isEmbeddingModel).toBeFalsy();
      }
    });

    it("should include gemini-2.5-flash", () => {
      // When: I get batch-compatible models
      const models = getBatchCompatibleModels();

      // Then: Includes the default model
      const hasGemini = models.some(({ key }) => key === "gemini-2.5-flash");
      expect(hasGemini).toBe(true);
    });
  });
});
