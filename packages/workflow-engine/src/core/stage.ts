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
> {
  // Metadata
  id: string;
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

export type StageOutputType<S> = S extends Stage<any, infer TOutput, any, any>
  ? z.infer<TOutput>
  : never;

export type StageInputType<S> = S extends Stage<infer TInput, any, any, any>
  ? z.infer<TInput>
  : never;

export type StageConfigType<S> = S extends Stage<any, any, infer TConfig, any>
  ? z.infer<TConfig>
  : never;
