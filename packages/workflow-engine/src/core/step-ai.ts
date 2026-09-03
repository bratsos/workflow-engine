/**
 * Durable AI step types.
 *
 * `ctx.step.ai.*` wraps the stage's `ctx.ai` helper in durable steps so a
 * stage with AI calls is replay-safe. The implementation lives in the kernel
 * layer (kernel/helpers/step-ai.ts); these types stay in core so stage
 * definitions do not depend on kernel internals.
 */

import type { z } from "zod";
import type { ModelKey } from "../ai/model-helper";
import type {
  AIBatchProvider,
  AIObjectResult,
  AITextResult,
  BatchOptions,
  ObjectOptions,
  TextInput,
  TextOptions,
} from "../ai/types";

export interface AiMapSpec<TIn, TOut> {
  model: ModelKey;
  prompt: (item: TIn, index: number) => TextInput;
  /** When set, each item is validated against this schema and repaired on failure. */
  schema?: z.ZodType<TOut>;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Stable per-item id used to key the durable step. Defaults to `${index}`; must be unique. */
  itemId?: (item: TIn, index: number) => string;
  /** Repair passes after a schema failure. Defaults to `{ attempts: 1 }`. */
  repair?: { attempts: number };
  /** Execution policy. Defaults to `"auto"`. */
  policy?: "auto" | "realtime" | "batch";
  /** `auto` uses batch at or above this item count (default 20) when the model supports it. */
  auto?: { batchAbove?: number };
  batch?: {
    provider?: AIBatchProvider;
    options?: BatchOptions;
    /** Poll cadence for the batch status wait. Defaults to `"60s"`. */
    pollEvery?: number | string;
    /** Non-sliding deadline for the batch wait. Defaults to `"24h"`. */
    timeout?: number | string;
    /**
     * What to do when the batch fails or the wait times out: `"fail"`
     * (default) throws `AiMapBatchFailedError`; `"partial"` returns every
     * item as failed with that error.
     */
    onExpiry?: "fail" | "partial";
  };
  realtime?: {
    /** In-process concurrency for realtime calls. Defaults to 10. */
    concurrency?: number;
    /**
     * Maximum model calls (including repairs) per stage invocation. Exceeding
     * it before an item's first call throws `AiMapBudgetExceededError`; a
     * repair that would exceed it returns the item as failed instead.
     */
    budget?: number;
    /** Durable retries after a thrown model call (step.run `retries`). Defaults to 1. */
    retries?: number;
    /** Delay before a durable retry. Defaults to 0. */
    retryDelayMs?: number | string;
  };
}

export type AiMapResult<TOut> =
  | {
      id: string;
      index: number;
      status: "succeeded";
      result: TOut;
      /** True when a schema was given and the result passed it. */
      validated: boolean;
      /** Model calls made for this item across batch and realtime attempts. */
      attempts: number;
      inputTokens: number;
      outputTokens: number;
      /** Sum of the recorded cost of every attempt for this item. */
      cost: number;
    }
  | {
      id: string;
      index: number;
      status: "failed";
      error: string;
      attempts: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    };

/**
 * Durable AI operations. Every method is memoized through the step ledger:
 * on replay a completed call returns its stored result without contacting
 * the model.
 *
 * Stored results carry `text`/`object`, tokens, cost and reasoning but not
 * the raw SDK object, so anything on the raw result is unavailable after a
 * replay.
 */
export interface StepAiApi {
  generateText(
    id: string,
    modelKey: ModelKey,
    prompt: TextInput,
    options?: TextOptions,
  ): Promise<AITextResult>;
  generateObject<S extends z.ZodTypeAny>(
    id: string,
    modelKey: ModelKey,
    prompt: TextInput,
    schema: S,
    options?: ObjectOptions,
  ): Promise<AIObjectResult<z.infer<S>>>;
  /**
   * Run one prompt per item under an execution policy (realtime or batch),
   * with schema validation and repair applied identically on both paths.
   * Results are returned in input order.
   */
  map<TIn, TOut = string>(
    id: string,
    items: readonly TIn[],
    spec: AiMapSpec<TIn, TOut>,
  ): Promise<AiMapResult<TOut>[]>;
}

/** Thrown when a realtime map would exceed `realtime.budget` model calls. */
export class AiMapBudgetExceededError extends Error {
  readonly mapId: string;
  readonly budget: number;

  constructor(mapId: string, budget: number) {
    super(
      `AI map "${mapId}" exceeded its realtime budget of ${budget} model call(s)`,
    );
    this.name = "AiMapBudgetExceededError";
    this.mapId = mapId;
    this.budget = budget;
  }
}

/** Thrown when a batch map's submission fails upstream and `onExpiry` is `"fail"`. */
export class AiMapBatchFailedError extends Error {
  readonly mapId: string;
  readonly batchId: string;

  constructor(mapId: string, batchId: string, reason: string) {
    super(`AI map "${mapId}" batch "${batchId}" failed: ${reason}`);
    this.name = "AiMapBatchFailedError";
    this.mapId = mapId;
    this.batchId = batchId;
  }
}
