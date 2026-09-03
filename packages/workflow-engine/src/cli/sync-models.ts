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

import {
  type OpenRouterModel,
  type OpenRouterResponse,
  toModelConfig,
} from "./model-catalog";

// Main
async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log("ℹ️  Running unauthenticated (OPENROUTER_API_KEY not set)");
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

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  // Fetch models from OpenRouter
  console.log("🔄 Fetching models from OpenRouter API...");
  const allModels: OpenRouterModel[] = [];
  let nextUrl: string | null =
    "https://openrouter.ai/api/v1/models?output_modalities=all";

  while (nextUrl) {
    const url: string = nextUrl.startsWith("http")
      ? nextUrl
      : `https://openrouter.ai${nextUrl.startsWith("/") ? "" : "/"}${nextUrl}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      console.error(
        `❌ OpenRouter API error: ${response.status} ${response.statusText}`,
      );
      process.exit(1);
    }

    const pageData = (await response.json()) as OpenRouterResponse;
    if (Array.isArray(pageData.data)) {
      allModels.push(...pageData.data);
    }
    nextUrl = pageData.links?.next ?? null;
  }

  console.log(`✅ Fetched ${allModels.length} models from OpenRouter`);

  // Build a Map of all models in the catalog (including :batch and :free variants)
  const catalogMap = new Map<string, OpenRouterModel>(
    allModels.map((m) => [m.id, m]),
  );

  // Filter models - exclude :batch and :free variants, apply include patterns first, then exclude
  const filteredModels = allModels.filter((model) => {
    // Exclude variant suffixes from becoming top-level registry keys
    if (model.id.includes(":batch") || model.id.includes(":free")) {
      return false;
    }

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
    `📊 After filtering: ${filteredModels.length} models (excluded ${allModels.length - filteredModels.length})`,
  );

  // Transform to ModelConfig
  const models: Record<string, ModelConfig> = {};

  for (const model of filteredModels) {
    models[model.id] = toModelConfig(model, catalogMap);
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
        ...(config.description !== undefined
          ? [
              `    description: "${config.description.replace(/"/g, '\\"').replace(/\n/g, "\\n")}",`,
            ]
          : []),
        `    inputCostPerMillion: ${config.inputCostPerMillion},`,
        `    outputCostPerMillion: ${config.outputCostPerMillion},`,
        `    provider: "${config.provider}",`,
        `    isEmbeddingModel: ${config.isEmbeddingModel || false},`,
        `    supportsTools: ${config.supportsTools || false},`,
        `    supportsStructuredOutputs: ${config.supportsStructuredOutputs || false},`,
        `    supportsAsyncBatch: ${config.supportsAsyncBatch || false},`,
        ...(config.batchModelId !== undefined
          ? [`    batchModelId: "${config.batchModelId}",`]
          : []),
        ...(config.batchInputCostPerMillion !== undefined
          ? [
              `    batchInputCostPerMillion: ${config.batchInputCostPerMillion},`,
            ]
          : []),
        ...(config.batchOutputCostPerMillion !== undefined
          ? [
              `    batchOutputCostPerMillion: ${config.batchOutputCostPerMillion},`,
            ]
          : []),
        ...(config.batchProvider !== undefined
          ? [`    batchProvider: "${config.batchProvider}",`]
          : []),
        ...(config.longContextTier !== undefined
          ? [
              `    longContextTier: {`,
              `      minPromptTokens: ${config.longContextTier.minPromptTokens},`,
              `      inputCostPerMillion: ${config.longContextTier.inputCostPerMillion},`,
              `      outputCostPerMillion: ${config.longContextTier.outputCostPerMillion},`,
              `    },`,
            ]
          : []),
        `    contextLength: ${config.contextLength ?? 0},`,
        ...(config.maxCompletionTokens != null
          ? [`    maxCompletionTokens: ${config.maxCompletionTokens},`]
          : []),
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
