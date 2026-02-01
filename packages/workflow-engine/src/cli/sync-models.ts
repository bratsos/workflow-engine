#!/usr/bin/env node
/**
 * workflow-engine-sync - CLI to sync models from OpenRouter API
 *
 * Usage:
 *   npx workflow-engine-sync
 *
 * Reads optional workflow-engine.models.ts config from cwd for:
 * - include: patterns to include models
 * - exclude: patterns to filter out models
 * - customModels: additional models to include
 */

/// <reference types="node" />

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { pathToFileURL } from "url";
import { type ModelConfig, type ModelSyncConfig } from "../ai/model-helper";

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  supported_parameters: string[];
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
}

interface OpenRouterResponse {
  data: OpenRouterModel[];
}

// Main
async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("❌ OPENROUTER_API_KEY environment variable is required");
    process.exit(1);
  }

  const cwd = process.cwd();
  console.log(`📁 Working directory: ${cwd}`);

  // Load config if exists
  let config: ModelSyncConfig = {};
  const configPath = join(cwd, "workflow-engine.models.ts");
  if (existsSync(configPath)) {
    try {
      const configModule = await import(pathToFileURL(configPath).href);
      config = configModule.default || configModule;
      console.log("📋 Loaded config from workflow-engine.models.ts");
    } catch (err) {
      console.warn(`⚠️  Could not load config: ${err}`);
    }
  }

  const outputPath = resolve(
    cwd,
    config.outputPath || "src/generated/models.ts",
  );
  const includePatterns = config.include || [];
  const excludePatterns = config.exclude || [];
  const customModels = config.customModels || {};

  // Fetch models from OpenRouter
  console.log("🔄 Fetching models from OpenRouter API...");
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    console.error(
      `❌ OpenRouter API error: ${response.status} ${response.statusText}`,
    );
    process.exit(1);
  }

  const data = (await response.json()) as OpenRouterResponse;
  console.log(`✅ Fetched ${data.data.length} models from OpenRouter`);

  // Fetch embedding models from OpenRouter
  console.log("🔄 Fetching embedding models from OpenRouter API...");
  const embeddingResponse = await fetch(
    "https://openrouter.ai/api/v1/embeddings/models",
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    },
  );

  let embeddingModelIds = new Set<string>();
  if (embeddingResponse.ok) {
    const embeddingData =
      (await embeddingResponse.json()) as OpenRouterResponse;
    console.log(
      `✅ Fetched ${embeddingData.data.length} embedding models from OpenRouter`,
    );
    // Track embedding model IDs for later marking
    embeddingModelIds = new Set(embeddingData.data.map((m) => m.id));
    // Add embedding models that might not be in the main list
    for (const model of embeddingData.data) {
      if (!data.data.find((m) => m.id === model.id)) {
        data.data.push(model);
      }
    }
  } else {
    console.warn(
      `⚠️  Could not fetch embedding models: ${embeddingResponse.status}`,
    );
  }

  // Filter models - include patterns first, then exclude
  const filteredModels = data.data.filter((model) => {
    // If include patterns are specified, model must match at least one
    if (includePatterns.length > 0) {
      let matchesInclude = false;
      for (const pattern of includePatterns) {
        if (typeof pattern === "string") {
          if (model.id.includes(pattern)) {
            matchesInclude = true;
            break;
          }
        } else if (pattern instanceof RegExp) {
          if (pattern.test(model.id)) {
            matchesInclude = true;
            break;
          }
        }
      }
      if (!matchesInclude) return false;
    }

    // Check exclude patterns
    for (const pattern of excludePatterns) {
      if (typeof pattern === "string") {
        if (model.id === pattern) return false;
      } else if (pattern instanceof RegExp) {
        if (pattern.test(model.id)) return false;
      }
    }
    return true;
  });

  console.log(
    `📊 After filtering: ${filteredModels.length} models (excluded ${data.data.length - filteredModels.length})`,
  );

  // Transform to ModelConfig
  const models: Record<string, ModelConfig> = {};

  for (const model of filteredModels) {
    // Convert per-token pricing to per-million
    const promptPrice = parseFloat(model.pricing?.prompt || "0");
    const completionPrice = parseFloat(model.pricing?.completion || "0");

    // Check if model supports async batch (Anthropic, OpenAI, or Google Gemini)
    const supportsBatch =
      model.id.startsWith("anthropic/") ||
      (model.id.startsWith("openai/") && !model.id.includes("gpt-oss")) ||
      (model.id.startsWith("google/") && model.id.includes("gemini"));

    // Check if this is an embedding model
    const isEmbedding = embeddingModelIds.has(model.id);

    // Check for tool and structured output support from supported_parameters
    const supportsTools =
      model.supported_parameters?.includes("tools") || false;
    const supportsStructuredOutputs =
      model.supported_parameters?.includes("structured_outputs") || false;

    models[model.id] = {
      id: model.id,
      name: model.name,
      inputCostPerMillion: Math.round(promptPrice * 1_000_000 * 10000) / 10000,
      outputCostPerMillion:
        Math.round(completionPrice * 1_000_000 * 10000) / 10000,
      provider: "openrouter",
      description: model.description,
      contextLength: model.top_provider?.context_length || model.context_length,
      maxCompletionTokens: model.top_provider?.max_completion_tokens,
      ...(isEmbedding && { isEmbeddingModel: true }),
      ...(supportsTools && { supportsTools: true }),
      ...(supportsStructuredOutputs && { supportsStructuredOutputs: true }),
      ...(supportsBatch &&
        !isEmbedding && {
          supportsAsyncBatch: true,
          batchDiscountPercent: 50,
        }),
    };
  }

  // Merge custom models
  for (const [key, modelConfig] of Object.entries(customModels)) {
    models[key] = modelConfig;
  }

  const allModelIds = Object.keys(models);
  console.log(`📦 Total models to generate: ${allModelIds.length}`);

  // Generate TypeScript file
  const generatedContent = generateTypeScript(models);

  // Ensure directory exists
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(outputPath, generatedContent, "utf-8");
  console.log(`✅ Generated ${outputPath}`);
  console.log(
    "\n💡 Import this file in your app entry to enable autocomplete:",
  );
  console.log(`   import "${outputPath.replace(cwd, ".")}";`);
}

function generateTypeScript(models: Record<string, ModelConfig>): string {
  const modelIds = Object.keys(models);

  // Generate model entries
  const modelEntries = Object.entries(models)
    .map(([key, config]) => {
      const lines = [
        `  "${key}": {`,
        `    id: "${config.id}",`,
        `    name: "${config.name.replace(/"/g, '\\"')}",`,
        `    description: "${config.description?.replace(/"/g, '\\"').replace(/\n/g, "\\n")}",`,
        `    inputCostPerMillion: ${config.inputCostPerMillion},`,
        `    outputCostPerMillion: ${config.outputCostPerMillion},`,
        `    provider: "${config.provider}",`,
        `    isEmbeddingModel: ${config.isEmbeddingModel || false},`,
        `    supportsTools: ${config.supportsTools || false},`,
        `    supportsStructuredOutputs: ${config.supportsStructuredOutputs || false},`,
        `    supportsAsyncBatch: ${config.supportsAsyncBatch || false},`,
        `    batchDiscountPercent: ${config.batchDiscountPercent || 0},`,
        `    contextLength: ${config.contextLength || 0},`,
        `    maxCompletionTokens: ${config.maxCompletionTokens},`,
        `  },`,
      ];

      return lines.join("\n");
    })
    .join("\n");

  // Generate registry interface entries
  const registryEntries = modelIds.map((id) => `    "${id}": true;`).join("\n");

  // Generate enum entries for GeneratedModelKey
  const enumEntries = modelIds.map((id) => `  "${id}",`).join("\n");

  return `// AUTO-GENERATED by workflow-engine-sync
// Run \`npx workflow-engine-sync\` to regenerate
// Generated at: ${new Date().toISOString()}

import { z } from "zod";
import { registerModels, type ModelConfig } from "@bratsos/workflow-engine/client";

// Register all models (OpenRouter + custom)
const MODELS: Record<string, ModelConfig> = {
${modelEntries}
};

registerModels(MODELS);

/**
 * Zod enum of all generated model IDs
 * Use GeneratedModelKey.enum["model-id"] for type-safe model selection
 */
export const GeneratedModelKey = z.enum([
${enumEntries}
]);

export type GeneratedModelKey = z.infer<typeof GeneratedModelKey>;

// TypeScript module augmentation for autocomplete
declare module "@bratsos/workflow-engine/client" {
  interface ModelRegistry {
${registryEntries}
  }
}

export { MODELS };
`;
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
