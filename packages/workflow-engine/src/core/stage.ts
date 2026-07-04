/**
 * Stage interface and context definitions
 *
 * Stages are the building blocks of workflows. Each stage:
 * - Has strongly-typed input, output, and config schemas (Zod)
 * - Can be sync or async-batch
 * - Has access to AI helper, storage, and logging via context
 * - Can suspend workflow for long-running batch operations
 */

import type { z } from "zod";
import type { AnnotationActor } from "../persistence/interface";
import type {
  CompletionCheckResult,
  LogLevel,
  ProgressUpdate,
  StageMode,
  StageResult,
  SuspendedResult,
  SuspendedStateSchema,
} from "./types";

// ============================================================================
// Annotate API — shared between StageContext and CheckCompletionContext
// ============================================================================

/**
 * Single-attribute form options.
 *
 * The `actor` field accepts an `AnnotationActor` ({ kind?, id?, version? }).
 * `payload` is a separate blob slot for non-queryable rich data.
 * `idempotencyKey` opts the annotation into the unique constraint on
 * `(workflowRunId, key, idempotencyKey)` so retries are deduped.
 */
export interface AnnotateOpts {
  actor?: AnnotationActor;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  /**
   * If true, the engine writes an `annotation:created` outbox event in
   * the same transaction as the annotation row. Useful for plugins or
   * external systems (audit pipelines, SIEM, live dashboards) that
   * want push notifications on provenance writes. Off by default.
   */
  emitEvent?: boolean;
}

/**
 * Batch form — multiple attributes share one envelope (actor / payload /
 * idempotencyKey / emitEvent). Each attribute becomes one row in
 * WorkflowAnnotation; if `emitEvent` is set, each row also emits its
 * own `annotation:created` outbox event.
 */
export interface AnnotateBatch {
  attributes: Record<string, unknown>;
  actor?: AnnotationActor;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  emitEvent?: boolean;
}

/**
 * Stability level for a well-known annotation key, attached at definition
 * time and surfaced to IDEs through the conventions module.
 *
 * Policy: once a key is `stable`, it is immutable. Renames and value-type
 * changes must ship as new keys; the old key gets a `@deprecated` JSDoc
 * tag. No env-var stability opt-in (we deliberately do not copy
 * OpenTelemetry's `OTEL_SEMCONV_STABILITY_OPT_IN`).
 */
export type Stability = "stable" | "experimental" | "deprecated";

/**
 * Typed annotation key. The phantom `_valueType` parameter lets
 * `ctx.annotate(key, value)` enforce that `value` matches `T` at compile
 * time when the key was defined with `typedKey<T>(...)`. The marker is
 * never set at runtime — only the `key` string is.
 */
export interface TypedKey<T = unknown> {
  readonly key: string;
  readonly stability: Stability;
  readonly description?: string;
  /** Phantom — never populated. Used only for `T` inference. */
  readonly _valueType?: T;
}

/**
 * Overloaded callable supporting three forms:
 *
 *   - **Typed key**: `ctx.annotate(Decision.outcome, "low")` — value type
 *     is inferred from the TypedKey, giving compile-time linkage between
 *     well-known keys and their expected value shapes.
 *   - **String key**: `ctx.annotate("custom.namespace.key", value)` —
 *     escape hatch for org-defined conventions.
 *   - **Batch**: `ctx.annotate({ attributes: {...}, actor?, ... })` —
 *     emit several related attributes sharing one envelope.
 *
 * All three return `void` from the caller's perspective; writes are
 * buffered on the context and flushed inside the stage-completion
 * transaction. `undefined` values are dropped (OTel pattern: callers can
 * write `ctx.annotate("x.id", maybeId)` without guarding).
 */
export interface AnnotateFn {
  <T>(key: TypedKey<T>, value: T, opts?: AnnotateOpts): void;
  (key: string, value: unknown, opts?: AnnotateOpts): void;
  (args: AnnotateBatch): void;
}

// ============================================================================
// Stage Context - Available to execute() method
// ============================================================================

export interface StageContext<
  TInput,
  TConfig,
  TWorkflowContext = Record<string, unknown>,
> {
  // Identification
  workflowRunId: string;
  stageId: string;
  stageNumber: number;
  stageName: string;
  /** Database record ID for this stage execution (for logging to persistence) */
  stageRecordId?: string;

  // Data
  input: TInput;
  config: TConfig;

  // Resume support - if this stage was suspended and is now resuming
  resumeState?: z.infer<typeof SuspendedStateSchema>;

  // Progress reporting
  onProgress: (update: ProgressUpdate) => void;

  // Logging
  onLog: (
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ) => void;
  log: (
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ) => void; // Convenience alias for onLog

  // Annotations — durable provenance attached to this stage.
  // Buffered and flushed inside the stage-completion transaction.
  annotate: AnnotateFn;

  // Storage for stage artifacts
  storage: StageStorage;

  // Shared workflow context (for passing data between stages) - Now fully typed!
  workflowContext: Partial<TWorkflowContext>;
}

// ============================================================================
// Stage Storage Interface
// ============================================================================

export interface StageStorage {
  save<T>(key: string, data: T): Promise<void>;
  load<T>(key: string): Promise<T>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  getStageKey(stageId: string, suffix?: string): string;
}

// ============================================================================
// Check Completion Context - Available to checkCompletion() method
// ============================================================================

/**
 * Context passed to checkCompletion for async-batch stages.
 * Includes identification info so stages don't need to store it in metadata.
 */
export interface CheckCompletionContext<TConfig> {
  // Identification
  workflowRunId: string;
  stageId: string;
  /** Database record ID for this stage execution (for logging to persistence) */
  stageRecordId?: string;

  // Config for this stage
  config: TConfig;

  // Logging
  onLog: (
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ) => void;
  log: (
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ) => void; // Convenience alias for onLog

  // Annotations — durable provenance attached to this stage during the
  // checkCompletion call. Buffered and flushed inside the Phase-2
  // transaction; if Phase 2 rolls back on StaleVersionError, the buffer
  // is discarded with it.
  annotate: AnnotateFn;

  // Storage for stage artifacts
  storage: StageStorage;
}

// ============================================================================
// Stage Interface - Main definition
// ============================================================================

export interface Stage<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TWorkflowContext = Record<string, unknown>,
  TId extends string = string,
> {
  // Metadata
  id: TId;
  name: string;
  description?: string;

  /**
   * Optional: List of stage IDs that this stage depends on.
   * The workflow builder will validate that all dependencies are present
   * in the workflow before this stage is executed.
   *
   * Example: dependencies: ["data-extraction", "guidelines"]
   */
  dependencies?: string[];

  // Schemas for validation and type inference
  inputSchema: TInput;
  outputSchema: TOutput;
  configSchema: TConfig;

  // Main execution method
  execute: (
    context: StageContext<z.infer<TInput>, z.infer<TConfig>, TWorkflowContext>,
  ) => Promise<StageResult<z.infer<TOutput>> | SuspendedResult>;

  // Optional: Completion checker for async-batch stages
  // Called by orchestrator to check if batch job is complete
  checkCompletion?: (
    suspendedState: z.infer<typeof SuspendedStateSchema>,
    context: CheckCompletionContext<z.infer<TConfig>>,
  ) => Promise<CompletionCheckResult<z.infer<TOutput>>>;

  // Execution mode
  mode?: StageMode;

  // Optional: Cost estimation
  estimateCost?: (input: z.infer<TInput>, config: z.infer<TConfig>) => number;
}

// ============================================================================
// Helper type to extract stage output type
// ============================================================================

export type StageOutputType<S> =
  S extends Stage<any, infer TOutput, any, any> ? z.infer<TOutput> : never;

export type StageInputType<S> =
  S extends Stage<infer TInput, any, any, any> ? z.infer<TInput> : never;

export type StageConfigType<S> =
  S extends Stage<any, any, infer TConfig, any> ? z.infer<TConfig> : never;
