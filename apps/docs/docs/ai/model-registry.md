---
sidebar_position: 3
title: Model Registry
---

# Model Registry

To calculate execution costs and select correct routing paths, **workflow-engine** maintains a central directory of model pricing, context sizes, and provider keys called the **Model Registry**.

---

## Global Custom Registrations

The engine includes a list of predefined models (like `gemini-2.5-flash`), but you can register any model (including private or newly-released models) using `registerModels()`:

```typescript
import { registerModels } from "@bratsos/workflow-engine";

registerModels({
  "custom-llama-3": {
    id: "meta-llama/llama-3-8b-instruct", // Provider ID (OpenRouter / Gemini)
    name: "Llama 3 8B",
    provider: "openrouter", // "openrouter" or "google"
    inputCostPerMillion: 0.2, // USD per 1M input tokens
    outputCostPerMillion: 0.4, // USD per 1M output tokens
    contextLength: 8192,
    maxCompletionTokens: 2048,
    capabilities: ["text"],
  },
  "custom-voyage-embed": {
    id: "voyage-large-2-instruct",
    name: "Voyage Large 2",
    provider: "voyage", // Custom provider resolver
    inputCostPerMillion: 0.12,
    outputCostPerMillion: 0,
    isEmbeddingModel: true,
  }
});
```

---

## Cached Input & Reasoning Token Pricing (v0.12+)

`ModelConfig` accepts two optional per-model rates for providers that bill cache reads or reasoning output separately from the base input/output rate:

```typescript
registerModels({
  "my-caching-model": {
    id: "provider/my-model",
    provider: "openrouter",
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    cachedInputCostPerMillion: 0.3, // optional - price for cached-read input tokens
    reasoningCostPerMillion: 60,    // optional - price for reasoning output tokens
  },
});
```

When an AI call reports `cachedInputTokens`/`reasoningTokens` (see [Usage Detail & Cost Refinement](./overview.md#usage-detail--cost-refinement-v012) in the AI Overview) **and** the model config sets the matching rate, that token slice is billed at the refined rate instead of the flat `inputCostPerMillion`/`outputCostPerMillion`. Leave both fields unset to keep byte-identical pre-0.12 cost behavior — the default for every built-in model today. The `sync-models` CLI does not populate these two fields yet; set them via `registerModels()` if you need refined pricing.

---

## TypeScript Autocomplete via Module Augmentation

By default, model key parameters in `AIHelper` methods (like `generateText`) accept any string. To enable autocomplete and compile-time verification, you can augment the `ModelRegistry` interface:

```typescript
// model-registry-env.d.ts
import "@bratsos/workflow-engine/client";

declare module "@bratsos/workflow-engine/client" {
  interface ModelRegistry {
    "custom-llama-3": true;
    "custom-voyage-embed": true;
  }
}
```

Once augmented, calling `ai.generateText("custom-llama-3", ...)` is verified by the compiler, and typos will throw TypeScript build errors.

---

## The Model Sync CLI

Manually compiling model prices and capacities is tedious, especially with OpenRouter's frequent updates. **workflow-engine** ships with a sync CLI to automate this.

The CLI fetches all active models from OpenRouter (including pricing details and parameter capabilities), filters them, and exports an auto-generated model registry file with full TypeScript module augmentations.

### 1. Configuration
Create a configuration file in your project root named `workflow-engine.models.ts`:

```typescript
// workflow-engine.models.ts
import { type ModelSyncConfig } from "@bratsos/workflow-engine/client";

const config: ModelSyncConfig = {
  outputPath: "src/generated/models.ts",
  include: [
    /^google\/gemini-2.5/,
    /^anthropic\/claude-3.5/,
    /^openai\/gpt-4o/
  ],
  exclude: [
    /-preview$/,
    /gpt-oss/
  ],
  customModels: {
    "my-internal-llm": {
      id: "custom/my-internal-llm",
      name: "Internal Llama",
      inputCostPerMillion: 0.1,
      outputCostPerMillion: 0.2,
      provider: "openrouter"
    }
  }
};

export default config;
```

### 2. Execution
Run the sync command. It requires an OpenRouter API key in the environment:

```bash
export OPENROUTER_API_KEY="your-openrouter-key"
npx workflow-engine-sync
```

This generates `src/generated/models.ts`. Import this file once in your application entrypoint (e.g. `index.ts`) to register the models and load autocomplete keys globally:

```typescript
import "./generated/models";
```

---

## OpenRouter `max_price` Guardrails

When routing requests through OpenRouter (which aggregates dozens of independent host providers for the same model), prices can fluctuate or spike if cheaper hosts experience downtime.

To protect against unexpected charges, **workflow-engine** enforces strict **`max_price` guardrails** at the API payload layer:

* When dispatching a request to an `"openrouter"` provider, the engine automatically extracts the `inputCostPerMillion` and `outputCostPerMillion` values declared in the model config.
* It injects these values directly into the OpenRouter provider body:
  ```json
  {
    "provider": {
      "sort": "throughput",
      "require_parameters": true,
      "max_price": {
        "prompt": modelConfig.inputCostPerMillion,
        "completion": modelConfig.outputCostPerMillion
      }
    }
  }
  ```
* If OpenRouter tries to route your call to a host provider that charges more than your model configuration defines, the call is rejected. This prevents silent billing increases and guarantees predictable AI spending.
