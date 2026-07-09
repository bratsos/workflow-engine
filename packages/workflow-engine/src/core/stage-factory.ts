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
  ProgressUpdate,
  StageResult,
  SuspendedResult,
  SuspendedStateSchema,
} from "./types";

// ============================================================================
// Poll Config Defaults
// ============================================================================

/** Default poll interval used when a suspended stage's state doesn't specify one. */
const DEFAULT_POLL_INTERVAL_MS = 30_000;
/** Default max wait time used when a suspended stage's state doesn't specify one. */
const DEFAULT_MAX_WAIT_TIME_MS = 24 * 60 * 60 * 1000;

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
> extends Omit<StageContext<TInput, TConfig, TContext>, "onProgress"> {
  /**
   * Report progress for this stage.
   *
   * `stageId` and `stageName` are auto-filled from the current stage's
   * context, so you only need to pass `{ progress, message }`. You may
   * still pass explicit `stageId`/`stageName` to override the auto-filled
   * values.
   *
   * @example
   * ctx.onProgress({ progress: 50, message: "Halfway done" });
   */
  onProgress: (
    update: Omit<ProgressUpdate, "stageId" | "stageName"> &
      Partial<Pick<ProgressUpdate, "stageId" | "stageName">>,
  ) => void;

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
 *
 * `pollConfig` (and `state.submittedAt` / `pollInterval` / `maxWaitTime`) are
 * optional — when omitted, the factory derives `pollConfig` (including
 * `nextPollAt`) from whatever is present on `state`, falling back to
 * sensible defaults. Write the poll timing values once, either on `state`
 * or on `pollConfig` (or both, if you want to override the derived value).
 */
export interface SimpleSuspendedResult {
  suspended: true;
  state: {
    batchId: string;
    /** Defaults to the current time if omitted. */
    submittedAt?: string;
    /** Defaults to `pollConfig.pollInterval`, or 30s if neither is set. */
    pollInterval?: number;
    /** Defaults to `pollConfig.maxWaitTime`, or 24h if neither is set. */
    maxWaitTime?: number;
    metadata?: Record<string, unknown>;
    apiKey?: string;
  };
  /**
   * Optional — derived automatically from `state` when omitted.
   */
  pollConfig?: {
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
  TId extends string = string,
> {
  /** Unique stage identifier */
  id: TId;
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
  TId extends string = string,
> extends Omit<
    SyncStageDefinition<TInput, TOutput, TConfig, TContext, TId>,
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
 * Curried form — supply only `TContext` and let TypeScript infer `TId` (as
 * a string literal), `TInput`, `TOutput`, and `TConfig` from the definition
 * object passed to the returned function.
 *
 * Prefer this over the 5-positional-generic overloads below whenever you
 * need to fix `TContext` explicitly. Positional generics require spelling
 * out all five by hand (`defineStage<TId, TInput, TOutput, TConfig,
 * TContext>({...})`) since TypeScript can't infer a subset from the middle
 * of a generic list — that duplicates the types already on `schemas` and
 * silently loses `TId` literal inference if any of them are mistyped. The
 * curried form only ever requires the one generic TypeScript truly can't
 * infer on its own.
 *
 * @example
 * ```typescript
 * type MyContext = { "previous-stage": { value: string } };
 *
 * export const myStage = defineStage<MyContext>()({
 *   id: "my-stage",              // TId inferred as the literal "my-stage"
 *   name: "My Stage",
 *   schemas: {
 *     input: InputSchema,
 *     output: OutputSchema,
 *     config: ConfigSchema,
 *   },
 *   async execute(ctx) {
 *     const prev = ctx.require("previous-stage"); // typed via MyContext
 *     return { output: { ... } };
 *   },
 * });
 * ```
 */
export function defineStage<
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(): <
  TId extends string,
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
>(
  definition:
    | SyncStageDefinition<TInput, TOutput, TConfig, TContext, TId>
    | AsyncBatchStageDefinition<TInput, TOutput, TConfig, TContext, TId>,
) => Stage<
  TInput extends "none" ? typeof NoInputSchema : TInput,
  TOutput,
  TConfig,
  TContext,
  TId
>;

/**
 * Define a sync stage with simplified API
 *
 * @deprecated Spelling out all five generics positionally is verbose and
 * throws away `TId` literal inference if any of them are mistyped. Prefer
 * the curried form when you need to fix `TContext` explicitly:
 * `defineStage<TContext>()({ ... })`. (This overload isn't going anywhere
 * — the curried form calls into it — this note is about the positional
 * generics, not about calling `defineStage({ ... })` with inferred types.)
 */
export function defineStage<
  TId extends string,
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: SyncStageDefinition<TInput, TOutput, TConfig, TContext, TId>,
): Stage<
  TInput extends "none" ? typeof NoInputSchema : TInput,
  TOutput,
  TConfig,
  TContext,
  TId
>;

/**
 * Define an async-batch stage with simplified API
 *
 * @deprecated Spelling out all five generics positionally is verbose and
 * throws away `TId` literal inference if any of them are mistyped. Prefer
 * the curried form when you need to fix `TContext` explicitly:
 * `defineStage<TContext>()({ ... })`.
 */
export function defineStage<
  TId extends string,
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: AsyncBatchStageDefinition<
    TInput,
    TOutput,
    TConfig,
    TContext,
    TId
  >,
): Stage<
  TInput extends "none" ? typeof NoInputSchema : TInput,
  TOutput,
  TConfig,
  TContext,
  TId
>;

/**
 * Implementation — dispatches on arity to handle both call shapes:
 * - `defineStage(definition)` — the direct, non-curried overloads above.
 * - `defineStage<TContext>()` — called with zero arguments; returns a
 *   function that accepts `definition` (the curried overload above).
 */
export function defineStage(
  definition?:
    | SyncStageDefinition<any, any, any, any, any>
    | AsyncBatchStageDefinition<any, any, any, any, any>,
): any {
  if (definition === undefined) {
    // Curried form: `defineStage<TContext>()` was called with no args —
    // return a function that builds the stage from the next call.
    return (
      curriedDefinition:
        | SyncStageDefinition<any, any, any, any, any>
        | AsyncBatchStageDefinition<any, any, any, any, any>,
    ) => buildStage(curriedDefinition);
  }

  return buildStage(definition);
}

/**
 * Shared implementation for both call shapes of `defineStage()`. Resolves
 * `"none"` input, wraps `execute()` with the enhanced context
 * (require/optional/onProgress) and auto-filled metrics/poll-config
 * derivation, and attaches `checkCompletion` for async-batch stages.
 */
function buildStage<
  TId extends string,
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  definition:
    | SyncStageDefinition<TInput, TOutput, TConfig, TContext, TId>
    | AsyncBatchStageDefinition<TInput, TOutput, TConfig, TContext, TId>,
): Stage<
  TInput extends "none" ? typeof NoInputSchema : TInput,
  TOutput,
  TConfig,
  TContext,
  TId
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
    TContext,
    TId
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

      // If suspended, pass through with auto-filled metrics and derived poll config
      if ("suspended" in result && result.suspended === true) {
        const suspendedResult = result as SimpleSuspendedResult;

        const pollInterval =
          suspendedResult.pollConfig?.pollInterval ??
          suspendedResult.state.pollInterval ??
          DEFAULT_POLL_INTERVAL_MS;
        const maxWaitTime =
          suspendedResult.pollConfig?.maxWaitTime ??
          suspendedResult.state.maxWaitTime ??
          DEFAULT_MAX_WAIT_TIME_MS;
        const submittedAt =
          suspendedResult.state.submittedAt ?? new Date().toISOString();
        const nextPollAt =
          suspendedResult.pollConfig?.nextPollAt ??
          new Date(new Date(submittedAt).getTime() + pollInterval);

        return {
          suspended: true as const,
          state: {
            ...suspendedResult.state,
            submittedAt,
            pollInterval,
            maxWaitTime,
          },
          pollConfig: {
            pollInterval,
            maxWaitTime,
            nextPollAt,
          },
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

    onProgress(update) {
      context.onProgress({
        stageId: context.stageId,
        stageName: context.stageName,
        ...update,
      });
    },

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
export type InferStageOutput<T> =
  T extends Stage<infer _I, infer O, infer _C, infer _Ctx> ? z.infer<O> : never;

/**
 * Extract the input type from a stage created with defineStage
 */
export type InferStageInput<T> =
  T extends Stage<infer I, infer _O, infer _C, infer _Ctx> ? z.infer<I> : never;

/**
 * Extract the config type from a stage created with defineStage
 */
export type InferStageConfig<T> =
  T extends Stage<infer _I, infer _O, infer C, infer _Ctx> ? z.infer<C> : never;

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
  TId extends string,
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: AsyncBatchStageDefinition<
    TInput,
    TOutput,
    TConfig,
    TContext,
    TId
  >,
): Stage<
  TInput extends "none" ? typeof NoInputSchema : TInput,
  TOutput,
  TConfig,
  TContext,
  TId
> {
  return defineStage(definition);
}
