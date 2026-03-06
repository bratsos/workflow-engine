/**
 * Custom Embedding Provider Registry Tests
 *
 * Tests for registerEmbeddingProvider() and the custom provider routing
 * in getEmbeddingModelProvider().
 */

import type { EmbeddingModelV3 } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock optional peer dependencies that ai-helper.ts transitively imports
vi.mock("@anthropic-ai/sdk", () => ({ Anthropic: class {} }));
vi.mock("@google/genai", () => ({ GoogleGenAI: class {} }));
vi.mock("openai", () => ({ default: class {} }));

import {
  getEmbeddingModelProvider,
  registerEmbeddingProvider,
} from "../../ai/ai-helper.js";
import type { ModelConfig } from "../../ai/model-helper.js";

/**
 * Create a minimal ModelConfig for testing embedding provider routing.
 */
function makeModelConfig(provider: string, id: string): ModelConfig {
  return {
    id,
    name: `Test ${id}`,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    provider,
  };
}

/**
 * Create a stub EmbeddingModelV3 for testing.
 */
function createStubEmbeddingModel(modelId: string): EmbeddingModelV3 {
  return {
    specificationVersion: "v3",
    modelId,
    provider: "test-provider",
    maxEmbeddingsPerCall: 1,
    supportsParallelCalls: false,
    doEmbed: vi.fn(),
  };
}

describe("Custom Embedding Provider Registry", () => {
  describe("custom provider routing", () => {
    it("should route to a registered custom provider factory", () => {
      // Given: A custom provider is registered
      const mockFactory = vi.fn((modelId: string) =>
        createStubEmbeddingModel(modelId),
      );
      registerEmbeddingProvider("voyage", mockFactory);

      // When: getEmbeddingModelProvider is called with that provider
      const config = makeModelConfig("voyage", "voyage-4-large");
      const result = getEmbeddingModelProvider(config);

      // Then: The factory is called with the model ID
      expect(mockFactory).toHaveBeenCalledWith("voyage-4-large");
      expect(result.modelId).toBe("voyage-4-large");
    });

    it("should support multiple custom providers", () => {
      // Given: Multiple custom providers registered
      const voyageFactory = vi.fn((id: string) => createStubEmbeddingModel(id));
      const cohereFactory = vi.fn((id: string) => createStubEmbeddingModel(id));
      registerEmbeddingProvider("voyage-multi", voyageFactory);
      registerEmbeddingProvider("cohere-multi", cohereFactory);

      // When: Each provider is used
      getEmbeddingModelProvider(makeModelConfig("voyage-multi", "voyage-4-large"));
      getEmbeddingModelProvider(
        makeModelConfig("cohere-multi", "embed-english-v3.0"),
      );

      // Then: Correct factory was called for each
      expect(voyageFactory).toHaveBeenCalledWith("voyage-4-large");
      expect(cohereFactory).toHaveBeenCalledWith("embed-english-v3.0");
    });

    it("should allow overwriting a registered provider", () => {
      // Given: A provider is registered
      const firstFactory = vi.fn((id: string) => createStubEmbeddingModel(id));
      registerEmbeddingProvider("overwrite-test", firstFactory);

      // When: The same provider name is re-registered
      const secondFactory = vi.fn((id: string) =>
        createStubEmbeddingModel(`v2-${id}`),
      );
      registerEmbeddingProvider("overwrite-test", secondFactory);

      // Then: The new factory is used
      const result = getEmbeddingModelProvider(
        makeModelConfig("overwrite-test", "my-model"),
      );
      expect(secondFactory).toHaveBeenCalledWith("my-model");
      expect(firstFactory).not.toHaveBeenCalled();
      expect(result.modelId).toBe("v2-my-model");
    });
  });

  describe("unregistered provider error", () => {
    it("should throw for an unknown provider with helpful error message", () => {
      const config = makeModelConfig("unknown-provider", "some-model");

      expect(() => getEmbeddingModelProvider(config)).toThrow(
        /Unsupported embedding provider "unknown-provider"/,
      );
      expect(() => getEmbeddingModelProvider(config)).toThrow(
        /registerEmbeddingProvider\(\)/,
      );
    });
  });

  describe("built-in providers still work", () => {
    it("should route openrouter to the built-in handler", () => {
      const config = makeModelConfig(
        "openrouter",
        "openai/text-embedding-3-small",
      );
      const result = getEmbeddingModelProvider(config);

      expect(result).toBeDefined();
      expect(result.modelId).toBe("openai/text-embedding-3-small");
    });

    it("should route google to the built-in handler", () => {
      const config = makeModelConfig("google", "text-embedding-004");
      const result = getEmbeddingModelProvider(config);

      expect(result).toBeDefined();
    });

    it("should prefer custom provider over built-in if same name is registered", () => {
      // Given: A custom "openrouter" provider is registered (overriding built-in)
      const customFactory = vi.fn((id: string) => createStubEmbeddingModel(id));
      registerEmbeddingProvider("openrouter", customFactory);

      // When: openrouter provider is used
      const config = makeModelConfig("openrouter", "custom-model");
      const result = getEmbeddingModelProvider(config);

      // Then: Custom factory takes precedence
      expect(customFactory).toHaveBeenCalledWith("custom-model");
      expect(result.modelId).toBe("custom-model");
    });
  });
});
