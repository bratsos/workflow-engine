/**
 * Stage Factory - Simplified stage definition with auto-metrics
 *
 * Provides a `defineStage()` function that reduces boilerplate by:
 * - Inferring types from schemas
 * - Auto-calculating metrics (timing handled by executor)
 * - Adding fluent context helpers (require/optional)
 * - Supporting both sync and async-batch modes
 *
 * @example
 * ```typescript
 * export const myStage = defineStage({
 *   id: "my-stage",
 *   name: "My Stage",
 *   description: "Does something useful",
 *   dependencies: ["previous-stage"],
 *
 *   schemas: {
 *     input: InputSchema,      // or "none" for NoInputSchema
 *     output: OutputSchema,
 *     config: ConfigSchema,
 *   },
 *
 *   async execute(ctx) {
 *     const prevData = ctx.require("previous-stage");
 *     // ... stage logic
 *     return { output: { ... } };
 *   },
 * });
 * ```
 */

import type { z } from "zod";
import { NoInputSchema } from "./schema-helpers";
import type { CheckCompletionContext, Stage, StageContext } from "./stage";
import type {
  CompletionCheckResult,
  StageResult,
  SuspendedResult,
  SuspendedStateSchema,
} from "./types";

// ============================================================================
// Type Helper for TInput
// ============================================================================

/**
 * Helper type to safely infer input type, handling the "none" special case
 */
export type InferInput<TInput extends z.ZodTypeAny | "none"> =
  TInput extends "none"
    ? z.infer<typeof NoInputSchema>
    : TInput extends z.ZodTypeAny
      ? z.infer<TInput>
      : never;

// ============================================================================
// Enhanced Context Type
// ============================================================================

/**
 * Enhanced stage context with fluent helpers
 */
export interface EnhancedStageContext<
  TInput,
  TConfig,
  TContext extends Record<string, unknown>,
> extends StageContext<TInput, TConfig, TContext> {
  /**
   * Require output from a previous stage (throws if not found)
   *
   * @example
   * const { extractedData } = ctx.require("data-extraction");
   */
  require: <K extends keyof TContext>(stageId: K) => TContext[K];

  /**
   * Optionally get output from a previous stage (returns undefined if not found)
   *
   * @example
   * const optionalData = ctx.optional("optional-stage");
   * if (optionalData) { ... }
   */
  optional: <K extends keyof TContext>(stageId: K) => TContext[K] | undefined;
}

// ============================================================================
// Stage Definition Types
// ============================================================================

/**
 * Simplified execute result - just output and optional custom metrics
 */
export interface SimpleStageResult<TOutput> {
  output: TOutput;
  /**
   * Custom metrics specific to this stage (e.g., itemsProcessed, sectionsFound)
   * Timing metrics (startTime, endTime, duration) are auto-calculated by executor
   * AI metrics should be added here by stages that create their own AIHelper
   */
  customMetrics?: Record<string, number>;
  /**
   * Optional artifacts to store
   */
  artifacts?: Record<string, unknown>;
}

/**
 * Simplified suspended result - metrics are auto-filled by the factory
 */
export interface SimpleSuspendedResult {
  suspended: true;
  state: {
    batchId: string;
    submittedAt: string;
    pollInterval: number;
    maxWaitTime: number;
    metadata?: Record<string, unknown>;
    apiKey?: string;
  };
  pollConfig: {
    pollInterval: number;
    maxWaitTime: number;
    nextPollAt: Date;
  };
  /**
   * Optional custom metrics (timing & AI metrics are auto-filled)
   */
  customMetrics?: Record<string, number>;
}

/**
 * Sync stage definition
 */
export interface SyncStageDefinition<
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Unique stage identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Stage IDs this stage depends on (validated at workflow build time) */
  dependencies?: string[];

  /** Zod schemas for validation */
  schemas: {
    /** Input schema, or "none" for stages that use workflowContext */
    input: TInput;
    /** Output schema */
    output: TOutput;
    /** Configuration schema */
    config: TConfig;
  };

  /**
   * Execute the stage logic
   * Return just { output } - metrics are auto-calculated
   */
  execute: (
    ctx: EnhancedStageContext<InferInput<TInput>, z.infer<TConfig>, TContext>,
  ) => Promise<SimpleStageResult<z.infer<TOutput>>>;

  /**
   * Optional: Estimate cost before execution
   */
  estimateCost?: (
    input: InferInput<TInput>,
    config: z.infer<TConfig>,
  ) => number;
}

/**
 * Async-batch stage definition (for long-running batch jobs)
 */
export interface AsyncBatchStageDefinition<
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = Record<string, unknown>,
> extends Omit<
    SyncStageDefinition<TInput, TOutput, TConfig, TContext>,
    "execute"
  > {
  /** Mark as async-batch mode */
  mode: "async-batch";

  /**
   * Execute the stage - either return result or suspend for batch processing
   *
   * When resuming from suspension, ctx.resumeState contains the suspended state.
   * Check this to determine whether to submit a new batch or fetch results.
   *
   * Return SimpleSuspendedResult when suspending - metrics will be auto-filled.
   */
  execute: (
    ctx: EnhancedStageContext<InferInput<TInput>, z.infer<TConfig>, TContext>,
  ) => Promise<SimpleStageResult<z.infer<TOutput>> | SimpleSuspendedResult>;

  /**
   * Check if the batch job is complete
   * Called by the orchestrator when polling suspended stages
   *
   * Context includes workflowRunId, stageId, config, log, and storage
   * so you don't need to store these in metadata.
   */
  checkCompletion: (
    suspendedState: z.infer<typeof SuspendedStateSchema>,
    context: CheckCompletionContext<z.infer<TConfig>>,
  ) => Promise<CompletionCheckResult<z.infer<TOutput>>>;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Define a sync stage with simplified API
 */
export function defineStage<
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: SyncStageDefinition<TInput, TOutput, TConfig, TContext>,
): Stage<
  TInput extends "none" ? typeof NoInputSchema : TInput,
  TOutput,
  TConfig,
  TContext
>;

/**
 * Define an async-batch stage with simplified API
 */
export function defineStage<
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: AsyncBatchStageDefinition<TInput, TOutput, TConfig, TContext>,
): Stage<
  TInput extends "none" ? typeof NoInputSchema : TInput,
  TOutput,
  TConfig,
  TContext
>;

/**
 * Implementation
 */
export function defineStage<
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  definition:
    | SyncStageDefinition<TInput, TOutput, TConfig, TContext>
    | AsyncBatchStageDefinition<TInput, TOutput, TConfig, TContext>,
): Stage<
  TInput extends "none" ? typeof NoInputSchema : TInput,
  TOutput,
  TConfig,
  TContext
> {
  // Resolve input schema
  const inputSchema =
    definition.schemas.input === "none"
      ? NoInputSchema
      : (definition.schemas.input as z.ZodTypeAny);

  const isAsyncBatch =
    "mode" in definition && definition.mode === "async-batch";

  // Build the Stage object
  const stage: Stage<
    TInput extends "none" ? typeof NoInputSchema : TInput,
    TOutput,
    TConfig,
    TContext
  > = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    mode: isAsyncBatch ? "async-batch" : "sync",
    dependencies: definition.dependencies,

    inputSchema: inputSchema as any,
    outputSchema: definition.schemas.output,
    configSchema: definition.schemas.config,

    async execute(context) {
      // Create enhanced context with fluent helpers
      const enhancedContext = createEnhancedContext(
        context as any,
      ) as EnhancedStageContext<InferInput<TInput>, z.infer<TConfig>, TContext>;

      // Call the user's execute function
      const result = await definition.execute(enhancedContext);

      // If suspended, pass through with auto-filled metrics
      if ("suspended" in result && result.suspended === true) {
        const suspendedResult = result as SimpleSuspendedResult;
        return {
          suspended: true as const,
          state: suspendedResult.state,
          pollConfig: suspendedResult.pollConfig,
          metrics: {
            startTime: 0,
            endTime: 0,
            duration: 0,
            ...suspendedResult.customMetrics,
          },
        } satisfies SuspendedResult;
      }

      // Narrow type to SimpleStageResult
      const simpleResult = result as SimpleStageResult<z.infer<TOutput>>;

      // Build full StageResult - stages add their own AI metrics via customMetrics
      const stageResult: StageResult<z.infer<TOutput>> = {
        output: simpleResult.output,
        metrics: {
          // Timing is set by executor - we provide placeholders
          startTime: 0,
          endTime: 0,
          duration: 0,
          // Custom metrics from stage (including AI metrics if stage tracked them)
          ...simpleResult.customMetrics,
        },
        artifacts: simpleResult.artifacts,
      };

      return stageResult;
    },

    estimateCost: definition.estimateCost as any,
  };

  // Add checkCompletion for async-batch stages
  if (isAsyncBatch) {
    const asyncDef = definition as AsyncBatchStageDefinition<
      TInput,
      TOutput,
      TConfig,
      TContext
    >;
    stage.checkCompletion = asyncDef.checkCompletion;
  }

  return stage;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create enhanced context with require/optional helpers
 */
function createEnhancedContext<
  TInput,
  TConfig,
  TContext extends Record<string, unknown>,
>(
  context: StageContext<TInput, TConfig, TContext>,
): EnhancedStageContext<TInput, TConfig, TContext> {
  return {
    ...context,

    require<K extends keyof TContext>(stageId: K): TContext[K] {
      const output = context.workflowContext[stageId as string];
      if (output === undefined) {
        const availableStages = Object.keys(context.workflowContext);
        throw new Error(
          `Missing required stage output: "${String(stageId)}". ` +
            `Available stages: ${availableStages.length > 0 ? availableStages.join(", ") : "(none)"}`,
        );
      }
      return output as TContext[K];
    },

    optional<K extends keyof TContext>(stageId: K): TContext[K] | undefined {
      return context.workflowContext[stageId as string] as
        | TContext[K]
        | undefined;
    },
  };
}

// ============================================================================
// Type Utilities
// ============================================================================

/**
 * Extract the output type from a stage created with defineStage
 */
export type InferStageOutput<T> = T extends Stage<
  infer _I,
  infer O,
  infer _C,
  infer _Ctx
>
  ? z.infer<O>
  : never;

/**
 * Extract the input type from a stage created with defineStage
 */
export type InferStageInput<T> = T extends Stage<
  infer I,
  infer _O,
  infer _C,
  infer _Ctx
>
  ? z.infer<I>
  : never;

/**
 * Extract the config type from a stage created with defineStage
 */
export type InferStageConfig<T> = T extends Stage<
  infer _I,
  infer _O,
  infer C,
  infer _Ctx
>
  ? z.infer<C>
  : never;

// ============================================================================
// Async Batch Stage Factory
// ============================================================================

/**
 * Define an async-batch stage with proper type inference for checkCompletion
 *
 * This is a dedicated function (not an alias) to ensure TypeScript properly
 * infers callback parameter types without overload resolution ambiguity.
 */
export function defineAsyncBatchStage<
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: AsyncBatchStageDefinition<TInput, TOutput, TConfig, TContext>,
): Stage<
  TInput extends "none" ? typeof NoInputSchema : TInput,
  TOutput,
  TConfig,
  TContext
> {
  return defineStage(definition);
}
