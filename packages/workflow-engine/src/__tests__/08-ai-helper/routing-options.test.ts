import { describe, expect, expectTypeOf, it, vi } from "vitest";

const { mockOpenrouter, mockTextEmbeddingModel } = vi.hoisted(() => {
  const mockTextEmbeddingModel = vi.fn();
  const mockOpenrouter = Object.assign(vi.fn(), {
    textEmbeddingModel: mockTextEmbeddingModel,
  });
  return { mockOpenrouter, mockTextEmbeddingModel };
});

vi.mock("@openrouter/ai-sdk-provider", () => ({
  openrouter: mockOpenrouter,
}));

import {
  createAIHelper,
  getEmbeddingModelProvider,
} from "../../ai/ai-helper.js";
import type { ModelConfig } from "../../ai/model-helper.js";
import { getModelProvider } from "../../ai/shared.js";
import type {
  AIHelperOptions,
  EngineBatchItemResult,
  EngineBatchModel,
  EngineBatchRef,
  EngineBatchRequest,
  EngineBatchStatus,
  OpenRouterRoutingOptions,
} from "../../index.js";
import * as indexExports from "../../index.js";

function makeLogger() {
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
      logBatchResults: vi.fn().mockResolvedValue(undefined),
      getCalls: vi.fn().mockResolvedValue([]),
    },
  };
}

describe("OpenRouter routing options", () => {
  describe("createAIHelper routing options propagation", () => {
    it("exposes routing on the internal context and createChild() keeps it", () => {
      const { logger } = makeLogger();
      const routing = {
        priceHeadroom: 2,
        sort: "price" as const,
        requireParameters: false,
      };

      const ai = createAIHelper("test.topic", logger, undefined, undefined, {
        routing,
      });

      const internalContext = (
        ai as unknown as { context: () => { routing?: typeof routing } }
      ).context();
      expect(internalContext.routing).toEqual(routing);

      const child = ai.createChild("stage", "extraction");
      const childContext = (
        child as unknown as { context: () => { routing?: typeof routing } }
      ).context();
      expect(childContext.routing).toEqual(routing);
    });
  });

  describe("getModelProvider routing options headroom", () => {
    const modelConfig: ModelConfig = {
      id: "openai/gpt-4o",
      name: "GPT-4o",
      inputCostPerMillion: 2.5,
      outputCostPerMillion: 10,
      provider: "openrouter",
    };

    it("omits max_price when priceHeadroom is 0", () => {
      mockOpenrouter.mockClear();
      getModelProvider(modelConfig, { priceHeadroom: 0 });

      expect(mockOpenrouter).toHaveBeenCalledTimes(1);
      const [modelId, options] = mockOpenrouter.mock.calls[0];
      expect(modelId).toBe("openai/gpt-4o");
      expect(options.extraBody?.provider?.max_price).toBeUndefined();
    });

    it("doubles max_price when priceHeadroom is 2", () => {
      mockOpenrouter.mockClear();
      getModelProvider(modelConfig, { priceHeadroom: 2 });

      expect(mockOpenrouter).toHaveBeenCalledTimes(1);
      const [modelId, options] = mockOpenrouter.mock.calls[0];
      expect(modelId).toBe("openai/gpt-4o");
      expect(options.extraBody?.provider?.max_price).toEqual({
        prompt: 2.5 * 2,
        completion: 10 * 2,
      });
    });

    it("applies default 1.25 multiplier when routing is not provided", () => {
      mockOpenrouter.mockClear();
      getModelProvider(modelConfig);

      expect(mockOpenrouter).toHaveBeenCalledTimes(1);
      const [, options] = mockOpenrouter.mock.calls[0];
      expect(options.extraBody?.provider?.max_price).toEqual({
        prompt: 2.5 * 1.25,
        completion: 10 * 1.25,
      });
    });
  });

  describe("getEmbeddingModelProvider routing options headroom", () => {
    const embedConfig: ModelConfig = {
      id: "openai/text-embedding-3-small",
      name: "Text Embedding 3 Small",
      inputCostPerMillion: 0.02,
      outputCostPerMillion: 0,
      provider: "openrouter",
      isEmbeddingModel: true,
    };

    it("omits max_price when priceHeadroom is 0", () => {
      mockTextEmbeddingModel.mockClear();
      getEmbeddingModelProvider(embedConfig, { priceHeadroom: 0 });

      expect(mockTextEmbeddingModel).toHaveBeenCalledTimes(1);
      const [modelId, options] = mockTextEmbeddingModel.mock.calls[0];
      expect(modelId).toBe("openai/text-embedding-3-small");
      expect(options.extraBody?.provider?.max_price).toBeUndefined();
      expect(options.extraBody?.usage).toEqual({ include: true });
    });

    it("doubles max_price when priceHeadroom is 2", () => {
      mockTextEmbeddingModel.mockClear();
      getEmbeddingModelProvider(embedConfig, { priceHeadroom: 2 });

      expect(mockTextEmbeddingModel).toHaveBeenCalledTimes(1);
      const [modelId, options] = mockTextEmbeddingModel.mock.calls[0];
      expect(modelId).toBe("openai/text-embedding-3-small");
      expect(options.extraBody?.provider?.max_price).toEqual({
        prompt: 0.02 * 2,
        completion: 0,
      });
      expect(options.extraBody?.usage).toEqual({ include: true });
    });
  });

  describe("public index.ts exports", () => {
    it("exports functions and types from index.ts", () => {
      expect(typeof indexExports.resolveAiSdkBatchModel).toBe("function");
      expect(typeof indexExports.fromAiSdk).toBe("function");
      expect(typeof indexExports.createOpenRouterBatchModel).toBe("function");
      expect(typeof indexExports.createAIHelper).toBe("function");

      // Compile-time typecheck assertions
      expectTypeOf<AIHelperOptions>().toBeObject();
      expectTypeOf<OpenRouterRoutingOptions>().toBeObject();
      expectTypeOf<EngineBatchModel>().toBeObject();
      expectTypeOf<EngineBatchStatus>().toBeObject();
      expectTypeOf<EngineBatchItemResult>().not.toBeAny();
      expectTypeOf<EngineBatchRequest>().toBeObject();
      expectTypeOf<EngineBatchRef>().toBeObject();
    });
  });
});
