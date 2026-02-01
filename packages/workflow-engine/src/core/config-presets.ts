/**
 * Config Presets - Common configuration patterns for workflow stages
 *
 * These presets provide standardized schemas for common stage configurations,
 * reducing boilerplate and ensuring consistency across stages.
 *
 * @example
 * ```typescript
 * import { defineStage } from "./stage-factory";
 * import { withAIConfig, withStandardConfig } from "./config-presets";
 *
 * // Use AI-focused config preset
 * const myStage = defineStage({
 *   id: "my-stage",
 *   name: "My Stage",
 *   schemas: {
 *     input: z.object({ data: z.string() }),
 *     output: z.object({ result: z.string() }),
 *     config: withAIConfig(z.object({
 *       customField: z.string(),
 *     })),
 *   },
 *   async execute(ctx) {
 *     // ctx.config.model, ctx.config.temperature available
 *     // plus ctx.config.customField
 *   },
 * });
 *
 * // Use standard config preset (includes AI + concurrency + feature flags)
 * const fullStage = defineStage({
 *   id: "full-stage",
 *   name: "Full Stage",
 *   schemas: {
 *     input: "none",
 *     output: z.object({ result: z.string() }),
 *     config: withStandardConfig(z.object({
 *       specificOption: z.boolean().default(true),
 *     })),
 *   },
 *   async execute(ctx) {
 *     // All standard config + custom fields available
 *   },
 * });
 * ```
 */

import { z } from "zod";
import { ModelKey } from "../ai/model-helper";

// ============================================================================
// Base Config Schemas
// ============================================================================

/**
 * AI/LLM configuration options
 */
export const AIConfigSchema = z.object({
  /** The model to use for AI operations */
  model: ModelKey.default("gemini-2.5-flash"),
  /** Temperature for AI generations (0-2) */
  temperature: z.number().min(0).max(2).default(0.7),
  /** Maximum tokens to generate (undefined = model default) */
  maxTokens: z.number().positive().optional(),
});

export type AIConfig = z.infer<typeof AIConfigSchema>;

/**
 * Concurrency and rate limiting configuration
 */
export const ConcurrencyConfigSchema = z.object({
  /** Maximum concurrent operations (for parallel processing) */
  concurrency: z.number().positive().default(5),
  /** Delay between operations in milliseconds (rate limiting) */
  delayMs: z.number().nonnegative().default(0),
  /** Maximum retries on failure */
  maxRetries: z.number().nonnegative().default(3),
});

export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

/**
 * Feature flag configuration for conditional behavior
 */
export const FeatureFlagsConfigSchema = z.object({
  /** Feature flags for conditional stage behavior */
  featureFlags: z.record(z.string(), z.boolean()).default({}),
});

export type FeatureFlagsConfig = z.infer<typeof FeatureFlagsConfigSchema>;

/**
 * Logging and debugging configuration
 */
export const DebugConfigSchema = z.object({
  /** Enable verbose logging */
  verbose: z.boolean().default(false),
  /** Dry run mode (no side effects) */
  dryRun: z.boolean().default(false),
});

export type DebugConfig = z.infer<typeof DebugConfigSchema>;

// ============================================================================
// Preset Combinators
// ============================================================================

/**
 * Add AI configuration to any schema
 *
 * @example
 * ```typescript
 * const myConfig = withAIConfig(z.object({
 *   customField: z.string(),
 * }));
 * // Result has: model, temperature, maxTokens, customField
 * ```
 */
export function withAIConfig<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.merge(AIConfigSchema);
}

/**
 * Add concurrency configuration to any schema
 *
 * @example
 * ```typescript
 * const myConfig = withConcurrency(z.object({
 *   items: z.array(z.string()),
 * }));
 * // Result has: concurrency, delayMs, maxRetries, items
 * ```
 */
export function withConcurrency<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
) {
  return schema.merge(ConcurrencyConfigSchema);
}

/**
 * Add feature flags configuration to any schema
 *
 * @example
 * ```typescript
 * const myConfig = withFeatureFlags(z.object({
 *   setting: z.boolean(),
 * }));
 * // Result has: featureFlags, setting
 * ```
 */
export function withFeatureFlags<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
) {
  return schema.merge(FeatureFlagsConfigSchema);
}

/**
 * Add debug configuration to any schema
 *
 * @example
 * ```typescript
 * const myConfig = withDebug(z.object({
 *   processType: z.string(),
 * }));
 * // Result has: verbose, dryRun, processType
 * ```
 */
export function withDebug<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.merge(DebugConfigSchema);
}

/**
 * Standard config preset combining AI + Concurrency + Feature Flags
 *
 * This is the recommended preset for most stages that need:
 * - AI/LLM operations
 * - Parallel processing
 * - Feature flagging
 *
 * @example
 * ```typescript
 * const myConfig = withStandardConfig(z.object({
 *   customOption: z.boolean().default(true),
 * }));
 * // Result has all standard fields plus customOption
 * ```
 */
export function withStandardConfig<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
) {
  return schema
    .merge(AIConfigSchema)
    .merge(ConcurrencyConfigSchema)
    .merge(FeatureFlagsConfigSchema);
}

/**
 * Full config preset with all available options including debug
 *
 * @example
 * ```typescript
 * const myConfig = withFullConfig(z.object({
 *   specificField: z.number(),
 * }));
 * // Result has AI + Concurrency + FeatureFlags + Debug + specificField
 * ```
 */
export function withFullConfig<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
) {
  return schema
    .merge(AIConfigSchema)
    .merge(ConcurrencyConfigSchema)
    .merge(FeatureFlagsConfigSchema)
    .merge(DebugConfigSchema);
}

// ============================================================================
// Preset Type Helpers
// ============================================================================

/**
 * Extract the inferred type from a config created with presets
 */
export type InferConfig<T extends z.ZodTypeAny> = z.infer<T>;

/**
 * Standard config type (AI + Concurrency + FeatureFlags)
 */
export type StandardConfig = AIConfig & ConcurrencyConfig & FeatureFlagsConfig;

/**
 * Full config type (Standard + Debug)
 */
export type FullConfig = StandardConfig & DebugConfig;

// ============================================================================
// Utility Schemas
// ============================================================================

/**
 * Empty config schema - for stages that don't need configuration
 */
export const EmptyConfigSchema = z.object({});

/**
 * Minimal AI config - just model and temperature
 */
export const MinimalAIConfigSchema = z.object({
  model: ModelKey.default("gemini-2.5-flash"),
  temperature: z.number().min(0).max(2).default(0.7),
});

export type MinimalAIConfig = z.infer<typeof MinimalAIConfigSchema>;
