/**
 * Durable AI steps: `ctx.step.ai.generateText/generateObject/streamText/evaluate/transcribe/map`.
 *
 * Every model call is memoized through `step.run`. `map` chooses between a
 * realtime path (one durable step per item, in-process concurrency, budget)
 * and a batch path (submit / poll / collect as three durable steps, followed
 * by a realtime repair pass), so batch output receives the same validation
 * and repair as realtime output. All bookkeeping lives in step results.
 */

import type { z } from "zod";
import type { EngineBatchRef } from "../../ai/batch/model";
import { getModel, type ModelKey } from "../../ai/model-helper";
import { calculateCostWithDiscount } from "../../ai/shared";
import type {
  AIBatchCancelResult,
  AIBatchProvider,
  AIBatchRequest,
  AIBatchResult,
  AIEvaluateResult,
  AIHelper,
  AIObjectResult,
  AITextResult,
  AITranscribeResult,
  EvaluateOptions,
  EvaluationQuestions,
  EvaluationSpec,
  ObjectOptions,
  StreamOptions,
  StreamTextInput,
  TextInput,
  TextOptions,
  TranscribeOptions,
  TranscriptionAudio,
} from "../../ai/types";
import {
  AiMapBatchFailedError,
  AiMapBudgetExceededError,
  type AiMapResult,
  type AiMapSpec,
  type StepAiApi,
  type StepStreamResult,
} from "../../core/step-ai";
import {
  isDuplicateStepKeyError,
  isNonRetryableError,
  isStepControlFlowError,
  type StepApi,
  type StepControlFlowError,
  StepLeaseLostError,
  type StepRunOptions,
  StepSuspend,
  StepTimeoutError,
  stageAbortReason,
} from "../../core/steps";
import { getBestProviderForModel } from "../../utils/batch/model-mapping";
import type { StepRecord } from "../ports.js";
import {
  dueOwedRefs,
  excludedIdsOf,
  generationTag,
  hasCancelFence,
  nextOwedRetry,
  type OwedAnswer,
  type OwedSettlement,
  owedRefsOf,
  owedRetryOf,
  parseStoredSubmit,
  rebaseMarkers,
  type StoredSubmit,
} from "./batch-submit-record.js";
import { timerDurationMs } from "./host-support";

/** The `cancelledBatchIds` a row's result lists, whatever else it holds. */
function cancelledIdsOf(result: unknown): string[] | undefined {
  const ids = (result as { cancelledBatchIds?: unknown } | null | undefined)
    ?.cancelledBatchIds;
  return Array.isArray(ids)
    ? ids.filter((x): x is string => typeof x === "string")
    : undefined;
}

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_BATCH_ABOVE = 20;
const DEFAULT_REPAIR_ATTEMPTS = 1;
const DEFAULT_REALTIME_RETRIES = 1;
// `poll.1`, `collect.1`, ... are the bookkeeping steps of a replaced batch.
const RESERVED_ITEM_ID = /^(?:submit|poll|collect)(?:\.\d+)?$/;

export interface StepAiDeps {
  run: StepApi["run"];
  waitFor: StepApi["waitFor"];
  /** True when the step already holds a completed result (used to skip budget reservation). */
  isCompleted(stepId: string): Promise<boolean>;
  /** Record an in-process retry on a running step: bumps the row's `attempt` by one. */
  noteAttempt(stepId: string): Promise<void>;
  /**
   * Mark an item step `failed` and keep its verdict as the row's result, so
   * a replay of the same attempt answers the verdict (with `errorName`,
   * attempts and tokens intact) and a new job attempt can re-open the row.
   */
  storeFailedVerdict(stepId: string, verdict: unknown): Promise<void>;
  /** The verdict stored by `storeFailedVerdict`, if the row is still failed. */
  loadFailedVerdict(stepId: string): Promise<unknown | undefined>;
  /** Wait before an in-process retry. Defaults to a real timer. */
  delay?(ms: number): Promise<void>;
  /**
   * The result a step's row holds, whatever its status: a re-opened row keeps
   * the result of its last execution. Optional; without it a reclaimed batch
   * submit cannot tell that the engine cancelled its batches.
   */
  storedResult?(stepId: string): Promise<unknown>;
  /**
   * Write a step's result onto its row while the step is still executing,
   * pinned to (`running`, `attempt`). Throws `StepLeaseLostError` when the row
   * is no longer this execution's (a replay or a cancel sweep took it over).
   */
  storeResult?(stepId: string, result: unknown, attempt: number): Promise<void>;
  /** A step's row as it stands, or `null` when it does not exist. */
  loadRow?(stepId: string): Promise<StepRecord | null>;
  /**
   * Record batches as owed a cancel (`cancelOwed`) on a completed or failed
   * row, or a running one with no lease, pinned to the status and attempt in
   * `row`. False when the row moved.
   */
  excludeBatches?(
    stepId: string,
    row: StepRecord,
    refs: EngineBatchRef[],
  ): Promise<boolean>;
  /**
   * Settle the owed cancels of the row `stepId` the provider has answered
   * (`settleOwed`), and record one more failed attempt for `failed` (id to
   * kind of failure, in `cancelRetry`), when nothing holds the row. Best
   * effort; says what it wrote.
   */
  settleBatches?(
    stepId: string,
    answered: ReadonlyMap<string, OwedAnswer>,
    failed?: ReadonlyMap<string, string>,
  ): Promise<OwedSettlement>;
  /** The engine clock. Without it a replay tries every owed cancel. */
  now?(): Date;
  /**
   * A WARN that names a provider batch which may still be running: written
   * on the run (it outlives the stage record), and never lost silently.
   */
  onBatchWarn?: (message: string) => void;
  /** Throws when durable steps are unavailable (no ledger / stage record). */
  assertReady(): void;
  ai(): AIHelper;
  onLog?: (level: "WARN", message: string) => void;
}

interface Feedback {
  output?: string;
  issues: string;
}

interface PriorAttempt {
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  feedback: Feedback;
}

interface ItemEntry<TIn> {
  index: number;
  id: string;
  item: TIn;
  prompt: TextInput;
}

interface Budget {
  reserve(): boolean;
}

/** The batches a rejected submit had already created (`BatchSubmitError.createdRefs`). */
function createdRefsOf(error: unknown): EngineBatchRef[] {
  if (!(error instanceof Error) || error.name !== "BatchSubmitError") return [];
  const refs = (error as { createdRefs?: unknown }).createdRefs;
  return Array.isArray(refs) ? (refs as EngineBatchRef[]) : [];
}

/** A batch item the provider or the schema rejected (small: no output). */
interface FailedItemSummary {
  id: string;
  error: string;
  errorName: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/** What the repair pass needs to re-prompt an item (its prior attempt). */
interface RepairItemSummary {
  id: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  feedback: Feedback;
}

/**
 * The `${id}:collect` step result: counts plus the items that failed or
 * need repair. Per-item verdicts are on the item rows, so this stays
 * small on a clean batch whatever its size.
 */
interface CollectSummary {
  total: number;
  succeeded: number;
  failed: FailedItemSummary[];
  repair: RepairItemSummary[];
}

/**
 * Thrown from inside an item's `run` step when the item ends in a failed
 * verdict, so the ledger row is recorded as `failed` (not as a completed
 * step whose result happens to be a failure) and a later job attempt
 * re-executes it. The map catches it and returns the verdict.
 */
class AiMapItemFailedSignal<TOut> extends Error {
  constructor(readonly verdict: AiMapResult<TOut> & { status: "failed" }) {
    super(verdict.error);
    this.name = "AiMapItemFailedSignal";
  }
}

function pickTextResult(result: AITextResult): AITextResult {
  return {
    text: result.text,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cost: result.cost,
    ...(result.reportedCostUsd !== undefined
      ? { reportedCostUsd: result.reportedCostUsd }
      : {}),
    ...(result.costSource !== undefined
      ? { costSource: result.costSource }
      : {}),
    ...(result.reasoning !== undefined ? { reasoning: result.reasoning } : {}),
    ...(result.output !== undefined ? { output: result.output } : {}),
  };
}

function pickObjectResult<T>(result: AIObjectResult<T>): AIObjectResult<T> {
  return {
    object: result.object,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cost: result.cost,
    ...(result.reportedCostUsd !== undefined
      ? { reportedCostUsd: result.reportedCostUsd }
      : {}),
    ...(result.costSource !== undefined
      ? { costSource: result.costSource }
      : {}),
    ...(result.reasoning !== undefined ? { reasoning: result.reasoning } : {}),
  };
}

/** What a durable evaluate step stores: the result without undefined fields. */
function pickEvaluateResult<Q extends EvaluationQuestions>(
  result: AIEvaluateResult<Q>,
): AIEvaluateResult<Q> {
  return {
    answers: result.answers,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cost: result.cost,
    ...(result.reportedCostUsd !== undefined
      ? { reportedCostUsd: result.reportedCostUsd }
      : {}),
    ...(result.costSource !== undefined
      ? { costSource: result.costSource }
      : {}),
  };
}

/** What a durable transcribe step stores: the result without undefined fields. */
function pickTranscribeResult(result: AITranscribeResult): AITranscribeResult {
  return {
    text: result.text,
    segments: result.segments,
    ...(result.language !== undefined ? { language: result.language } : {}),
    ...(result.durationInSeconds !== undefined
      ? { durationInSeconds: result.durationInSeconds }
      : {}),
    cost: result.cost,
    ...(result.reportedCostUsd !== undefined
      ? { reportedCostUsd: result.reportedCostUsd }
      : {}),
    ...(result.costSource !== undefined
      ? { costSource: result.costSource }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return `${path || "(root)"}: ${issue.message}`;
    })
    .join("\n");
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function withRepair(prompt: TextInput, feedback: Feedback): TextInput {
  const suffix =
    "\n\nYour previous response did not satisfy the required output format." +
    (feedback.output !== undefined
      ? `\nPrevious response:\n${feedback.output}`
      : "") +
    `\nProblems:\n${feedback.issues}` +
    "\nRespond again, fixing every problem listed above.";
  if (typeof prompt === "string") return prompt + suffix;
  return [...prompt, { type: "text", text: suffix }];
}

/**
 * Decide whether a thrown model call is repairable output rather than a
 * transport failure. Repairable: the AI SDK's `AI_NoObjectGeneratedError`,
 * any error that carries the model's raw text (`text`, or `cause.text`), a
 * Zod error, or a JSON `SyntaxError` — i.e. the model answered and the
 * answer could not be parsed or validated. Anything else counts against
 * `realtime.retries`.
 */
function asGenerationFailure(error: unknown): Feedback | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as {
    name?: unknown;
    text?: unknown;
    cause?: unknown;
    message?: string;
    issues?: unknown;
  };
  const cause =
    typeof e.cause === "object" && e.cause !== null
      ? (e.cause as { name?: unknown; text?: unknown; issues?: unknown })
      : undefined;
  const text =
    typeof e.text === "string"
      ? e.text
      : typeof cause?.text === "string"
        ? cause.text
        : undefined;
  const isZod = (x: { name?: unknown; issues?: unknown } | undefined) =>
    x !== undefined && x.name === "ZodError" && Array.isArray(x.issues);
  const repairable =
    e.name === "AI_NoObjectGeneratedError" ||
    text !== undefined ||
    isZod(e) ||
    error instanceof SyntaxError;
  if (!repairable) return undefined;

  let issues: string;
  if (isZod(e)) issues = formatIssues(error as z.ZodError);
  else if (isZod(cause)) issues = formatIssues(cause as z.ZodError);
  else if (e.cause instanceof Error) issues = e.cause.message;
  else issues = e.message || "No object generated";
  return { output: text, issues };
}

function createBudget(limit: number | undefined): Budget {
  if (limit === undefined) return { reserve: () => true };
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("realtime.budget must be a non-negative integer");
  }
  let used = 0;
  return {
    reserve() {
      if (used >= limit) return false;
      used++;
      return true;
    },
  };
}

/**
 * Run tasks with a fixed concurrency. Stops launching new tasks after the
 * first rejection but lets in-flight tasks settle so their durable results
 * are persisted before the error propagates.
 */
async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
  minDelayMs = 0,
): Promise<Array<PromiseSettledResult<T> | undefined>> {
  const results: Array<PromiseSettledResult<T> | undefined> = new Array(
    tasks.length,
  );
  let next = 0;
  let halted = false;

  async function worker(): Promise<void> {
    while (!halted) {
      const index = next++;
      if (index >= tasks.length) return;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]!() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
        halted = true;
      }
      // Per-slot pacing: this slot waits before taking its next item, so
      // `concurrency` calls may still be in flight elsewhere.
      if (!halted && minDelayMs > 0 && next < tasks.length) {
        await new Promise((resolve) => setTimeout(resolve, minDelayMs));
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Choose the error to surface when several items of one map reject.
 *
 * A duplicate step key wins over everything. It is a bug in the stage
 * definition, and unlike a suspension it cannot resolve itself: preferring
 * the control-flow signal suspends the stage, the poll replays it, and the
 * same duplicate key is raised again — a correct report, one replay late,
 * after a poll cycle has been spent on a stage that could never finish.
 *
 * Raising it now loses no suspension. A control-flow error is thrown after
 * its step's ledger row exists — `StepInFlight` after a claim found a live
 * lease, `StepSuspend` after the row recorded its handle and deadline — so
 * the row and everything it holds survive the stage failing. Once the key
 * is fixed, the replay meets those rows exactly as a resumed poll would
 * have, and answers them from the ledger.
 *
 * Otherwise control flow first, earliest wake-up wins: one item still
 * waiting must suspend the stage rather than let a stray item failure
 * decide the map's outcome.
 */
function pickError(reasons: unknown[]): unknown {
  const duplicateKey = reasons.find((reason) =>
    isDuplicateStepKeyError(reason),
  );
  if (duplicateKey) return duplicateKey;

  let chosen: StepControlFlowError | undefined;
  for (const reason of reasons) {
    if (!isStepControlFlowError(reason)) continue;
    if (!chosen) {
      chosen = reason;
      continue;
    }
    if (
      reason instanceof StepSuspend &&
      (!(chosen instanceof StepSuspend) ||
        reason.nextPollAt.getTime() < chosen.nextPollAt.getTime())
    ) {
      chosen = reason;
    }
  }
  return chosen ?? reasons[0];
}

/** `TextInput` as the AI SDK stream input shape. */
function toStreamInput(prompt: TextInput): StreamTextInput {
  if (typeof prompt === "string") return { prompt };
  return {
    messages: [{ role: "user", content: prompt }],
  } as unknown as StreamTextInput;
}

/** Stream one call to completion and reduce it to what the ledger stores. */
async function collectStream(
  ai: AIHelper,
  modelKey: ModelKey,
  prompt: TextInput,
  options?: StreamOptions,
): Promise<StepStreamResult> {
  const stream = ai.streamText(modelKey, toStreamInput(prompt), options);
  // Drain the helper's tapped iterable: that tap is what forwards `onChunk`.
  // `getText()` alone reads the buffered final text and would skip it.
  for await (const _chunk of stream.stream) {
    // The tap already handed the chunk to `options.onChunk`.
  }
  const text = await stream.getText();
  const usage = await stream.getUsage();
  const reasoning = await stream.getReasoning();
  return {
    text,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cost: usage.cost,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

export function createStepAi(deps: StepAiDeps): StepAiApi {
  async function generateText(
    id: string,
    modelKey: ModelKey,
    prompt: TextInput,
    options?: TextOptions,
    stepOptions?: StepRunOptions,
  ): Promise<AITextResult> {
    return deps.run(
      id,
      async () =>
        pickTextResult(await deps.ai().generateText(modelKey, prompt, options)),
      stepOptions,
    );
  }

  async function generateObject<S extends z.ZodTypeAny>(
    id: string,
    modelKey: ModelKey,
    prompt: TextInput,
    schema: S,
    options?: ObjectOptions,
    stepOptions?: StepRunOptions,
  ): Promise<AIObjectResult<z.infer<S>>> {
    return deps.run(
      id,
      async () =>
        pickObjectResult(
          await deps.ai().generateObject(modelKey, prompt, schema, options),
        ),
      stepOptions,
    );
  }

  async function streamText(
    id: string,
    modelKey: ModelKey,
    prompt: TextInput,
    options?: StreamOptions,
    stepOptions?: StepRunOptions,
  ): Promise<StepStreamResult> {
    // Decided before `run`: a completed step returns its stored result
    // without executing `fn`, so the incremental `onChunk` calls never
    // happen and the consumer gets the whole text in one call instead.
    const replayed = await deps.isCompleted(id);
    const result = await deps.run(
      id,
      () => collectStream(deps.ai(), modelKey, prompt, options),
      stepOptions,
    );
    if (replayed) options?.onChunk?.(result.text);
    return result;
  }

  async function evaluate<const Q extends EvaluationQuestions>(
    id: string,
    modelKey: ModelKey,
    spec: EvaluationSpec<Q>,
    options?: EvaluateOptions,
    stepOptions?: StepRunOptions,
  ): Promise<AIEvaluateResult<Q>> {
    return deps.run(
      id,
      async () =>
        pickEvaluateResult(await deps.ai().evaluate(modelKey, spec, options)),
      stepOptions,
    );
  }

  async function transcribe(
    id: string,
    modelKey: ModelKey,
    audio: TranscriptionAudio,
    options?: TranscribeOptions,
    stepOptions?: StepRunOptions,
  ): Promise<AITranscribeResult> {
    return deps.run(
      id,
      async () =>
        pickTranscribeResult(
          await deps.ai().transcribe(modelKey, audio, options),
        ),
      stepOptions,
    );
  }

  async function map<TIn, TOut = string>(
    id: string,
    items: readonly TIn[],
    spec: AiMapSpec<TIn, TOut>,
  ): Promise<AiMapResult<TOut>[]> {
    deps.assertReady();
    if (!id) throw new Error("AI map id must not be empty");

    const repairAttempts = spec.repair?.attempts ?? DEFAULT_REPAIR_ATTEMPTS;
    if (!Number.isInteger(repairAttempts) || repairAttempts < 0) {
      throw new Error("repair.attempts must be a non-negative integer");
    }
    const budget = createBudget(spec.realtime?.budget);
    const concurrency = spec.realtime?.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("realtime.concurrency must be a positive integer");
    }
    const retries = spec.realtime?.retries ?? DEFAULT_REALTIME_RETRIES;
    // 0 turns each delay off; anything else must fit a timer.
    const retryDelayMs = timerDurationMs(
      "realtime.retryDelayMs",
      spec.realtime?.retryDelayMs ?? 0,
      { allowZero: true },
    );
    const minDelayMs = timerDurationMs(
      "realtime.minDelayMs",
      spec.realtime?.minDelayMs ?? 0,
      { allowZero: true },
    );
    const wait =
      deps.delay ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const callOptions = {
      ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
      ...(spec.temperature !== undefined
        ? { temperature: spec.temperature }
        : {}),
    };

    const entries: ItemEntry<TIn>[] = [];
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const itemId = spec.itemId ? spec.itemId(item, index) : `${index}`;
      if (!itemId) {
        throw new Error(`AI map "${id}": itemId for index ${index} is empty`);
      }
      if (RESERVED_ITEM_ID.test(itemId)) {
        throw new Error(
          `AI map "${id}": itemId "${itemId}" is reserved for batch bookkeeping`,
        );
      }
      if (seen.has(itemId)) {
        throw new Error(`AI map "${id}": duplicate itemId "${itemId}"`);
      }
      seen.add(itemId);
      entries.push({
        index,
        id: itemId,
        item,
        prompt: spec.prompt(item, index),
      });
    });

    const itemStepId = (itemId: string) => `${id}:${itemId}`;

    function applySystem(prompt: TextInput): TextInput {
      if (spec.system === undefined) return prompt;
      if (typeof prompt === "string") return `${spec.system}\n\n${prompt}`;
      return [{ type: "text", text: spec.system }, ...prompt];
    }

    /**
     * One item's attempt loop; runs inside `step.run`, so it is memoized.
     * A thrown model call (transport, quota, ...) is retried IN-PROCESS up
     * to `realtime.retries` times after `retryDelayMs`, bumping the ledger
     * row's `attempt`; the stage never suspends for a map item.
     */
    async function executeItem(
      entry: ItemEntry<TIn>,
      prior: PriorAttempt | undefined,
      stepId: string,
    ): Promise<AiMapResult<TOut>> {
      const ai = deps.ai();
      let attempts = prior?.attempts ?? 0;
      let inputTokens = prior?.inputTokens ?? 0;
      let outputTokens = prior?.outputTokens ?? 0;
      let cost = prior?.cost ?? 0;
      let feedback = prior?.feedback;
      let repairsLeft = repairAttempts;
      let retriesLeft = retries;
      const base = { id: entry.id, index: entry.index };

      /**
       * Route a thrown model call: control flow propagates, repairable
       * output becomes feedback, anything else consumes a retry or fails
       * the item. Returns the failed verdict when no retry remains.
       */
      async function onThrown(
        error: unknown,
      ): Promise<"repair" | "retry" | AiMapResult<TOut>> {
        if (isStepControlFlowError(error)) throw error;
        const failure = asGenerationFailure(error);
        // A NonRetryableError gets no repair and no retry (its brand alone is
        // read, after main's checks).
        const terminal = isNonRetryableError(error);
        if (failure && !terminal) {
          feedback = failure;
          return "repair";
        }
        if (terminal || retriesLeft <= 0) {
          return failed(
            errorMessage(error),
            error instanceof Error ? error.name : undefined,
          );
        }
        retriesLeft--;
        await deps.noteAttempt(stepId);
        if (retryDelayMs > 0) await wait(retryDelayMs);
        return "retry";
      }

      const failed = (
        error: string,
        errorName?: string,
      ): AiMapResult<TOut> => ({
        ...base,
        status: "failed",
        error,
        ...(errorName !== undefined ? { errorName } : {}),
        attempts,
        inputTokens,
        outputTokens,
        cost,
      });

      for (;;) {
        if (feedback) {
          if (repairsLeft <= 0) return failed(feedback.issues);
          if (!budget.reserve()) {
            return failed(
              `${feedback.issues}\n(realtime budget exhausted before repair)`,
            );
          }
          repairsLeft--;
        }
        const prompt = applySystem(
          feedback ? withRepair(entry.prompt, feedback) : entry.prompt,
        );
        attempts++;

        if (spec.stream) {
          let collected: StepStreamResult;
          try {
            collected = await collectStream(
              ai,
              spec.model,
              prompt,
              callOptions,
            );
          } catch (error) {
            const routed = await onThrown(error);
            if (routed === "repair" || routed === "retry") continue;
            return routed;
          }
          inputTokens += collected.inputTokens;
          outputTokens += collected.outputTokens;
          cost += collected.cost;
          if (!spec.schema) {
            return {
              ...base,
              status: "succeeded",
              result: collected.text as unknown as TOut,
              validated: false,
              attempts,
              inputTokens,
              outputTokens,
              cost,
            };
          }
          let streamed: unknown;
          try {
            streamed = JSON.parse(collected.text);
          } catch {
            feedback = {
              output: collected.text,
              issues: "the response was not valid JSON",
            };
            continue;
          }
          const validated = spec.schema.safeParse(streamed);
          if (validated.success) {
            return {
              ...base,
              status: "succeeded",
              result: validated.data,
              validated: true,
              attempts,
              inputTokens,
              outputTokens,
              cost,
            };
          }
          feedback = {
            output: collected.text,
            issues: formatIssues(validated.error),
          };
          continue;
        }

        if (!spec.schema) {
          let result: AITextResult;
          try {
            result = await ai.generateText(spec.model, prompt, callOptions);
          } catch (error) {
            const routed = await onThrown(error);
            if (routed === "repair" || routed === "retry") continue;
            return routed;
          }
          inputTokens += result.inputTokens;
          outputTokens += result.outputTokens;
          cost += result.cost;
          return {
            ...base,
            status: "succeeded",
            result: result.text as unknown as TOut,
            validated: false,
            attempts,
            inputTokens,
            outputTokens,
            cost,
          };
        }

        let object: unknown;
        try {
          const result = await ai.generateObject(
            spec.model,
            prompt,
            spec.schema,
            callOptions,
          );
          inputTokens += result.inputTokens;
          outputTokens += result.outputTokens;
          cost += result.cost;
          object = result.object;
        } catch (error) {
          const routed = await onThrown(error);
          if (routed === "repair" || routed === "retry") continue;
          return routed;
        }

        const parsed = spec.schema.safeParse(object);
        if (parsed.success) {
          return {
            ...base,
            status: "succeeded",
            result: parsed.data,
            validated: true,
            attempts,
            inputTokens,
            outputTokens,
            cost,
          };
        }
        feedback = {
          output: stringify(object),
          issues: formatIssues(parsed.error),
        };
      }
    }

    /** Realtime path for a set of entries; returns results by entry position. */
    async function runRealtime(
      subset: ItemEntry<TIn>[],
      priors: Map<string, PriorAttempt>,
    ): Promise<AiMapResult<TOut>[]> {
      // Resolve which items the ledger already answers BEFORE any task
      // starts: `deps.run` reserves the item's seq synchronously on entry,
      // so no task may await ahead of it or the seq order would follow the
      // ledger's response order and differ between replays.
      const completed = new Set<string>();
      await Promise.all(
        subset.map(async (entry) => {
          if (priors.has(entry.id)) return;
          if (await deps.isCompleted(itemStepId(entry.id))) {
            completed.add(entry.id);
          }
        }),
      );
      const tasks = subset.map((entry) => async () => {
        const stepId = itemStepId(entry.id);
        const prior = priors.get(entry.id);
        if (!prior && !completed.has(entry.id)) {
          if (!budget.reserve()) {
            throw new AiMapBudgetExceededError(id, spec.realtime?.budget ?? 0);
          }
        }
        try {
          return await deps.run(stepId, async () => {
            const verdict = await executeItem(entry, prior, stepId);
            if (verdict.status === "failed") {
              throw new AiMapItemFailedSignal(verdict);
            }
            return verdict;
          });
        } catch (error) {
          if (isStepControlFlowError(error)) throw error;
          // A duplicate step key is a bug in the stage definition, not an
          // item that failed: burying it in a verdict is exactly the
          // silence the guard exists to remove.
          if (isDuplicateStepKeyError(error)) throw error;
          if (error instanceof AiMapBudgetExceededError) throw error;
          // The item ended in a failed verdict (retries and repair
          // exhausted, or a throw outside the model-call loop). The row is
          // `failed`; its result carries the verdict so a replay of this
          // attempt returns it unchanged (the row's error column alone
          // would lose `errorName`, attempts and tokens), while a new job
          // attempt re-opens the row and re-prompts the item.
          if (error instanceof AiMapItemFailedSignal) {
            await deps.storeFailedVerdict(stepId, error.verdict);
            return error.verdict as AiMapResult<TOut>;
          }
          const stored = (await deps.loadFailedVerdict(stepId)) as
            | AiMapResult<TOut>
            | undefined;
          if (stored && stored.status === "failed" && stored.id === entry.id) {
            return stored;
          }
          const verdict: AiMapResult<TOut> = {
            id: entry.id,
            index: entry.index,
            status: "failed",
            error: errorMessage(error),
            ...(error instanceof Error ? { errorName: error.name } : {}),
            attempts: (prior?.attempts ?? 0) + 1,
            inputTokens: prior?.inputTokens ?? 0,
            outputTokens: prior?.outputTokens ?? 0,
            cost: prior?.cost ?? 0,
          };
          await deps.storeFailedVerdict(stepId, verdict);
          return verdict;
        }
      });

      const settled = await runWithConcurrency(tasks, concurrency, minDelayMs);
      const reasons = settled
        .filter((s): s is PromiseRejectedResult => s?.status === "rejected")
        .map((s) => s.reason);
      if (reasons.length > 0) throw pickError(reasons);
      return settled.map(
        (s) => (s as PromiseFulfilledResult<AiMapResult<TOut>>).value,
      );
    }

    // ---- Policy -----------------------------------------------------------

    const policy = spec.policy ?? "auto";
    let batchProvider: AIBatchProvider | undefined;
    let batchBlocker: string | undefined;
    try {
      const modelConfig = getModel(spec.model);
      if (!modelConfig.supportsAsyncBatch) {
        batchBlocker = `model "${spec.model}" does not support async batch`;
      } else {
        batchProvider =
          spec.batch?.provider ?? getBestProviderForModel(spec.model);
        if (!batchProvider) {
          batchBlocker = `no batch provider resolves for model "${spec.model}"`;
        }
      }
    } catch (error) {
      batchBlocker = errorMessage(error);
    }
    if (!batchBlocker && entries.some((e) => typeof e.prompt !== "string")) {
      batchBlocker = "batch requests require string prompts";
    }

    let useBatch: boolean;
    if (policy === "realtime") {
      useBatch = false;
    } else if (policy === "batch") {
      if (batchBlocker) {
        throw new Error(
          `AI map "${id}" cannot use the batch policy: ${batchBlocker}`,
        );
      }
      useBatch = true;
    } else {
      useBatch =
        !batchBlocker &&
        entries.length >= (spec.auto?.batchAbove ?? DEFAULT_BATCH_ABOVE);
    }

    if (!useBatch) {
      return runRealtime(entries, new Map());
    }

    // ---- Batch path -------------------------------------------------------

    const provider = batchProvider!;
    const batch = deps
      .ai()
      .batch<unknown>(spec.model, provider, spec.batch?.options);
    const requestIds = entries.map((e) => e.id);

    // Batches this execution's submit body created, and the key they carry.
    // The body's outcome write can lose the row (on a submit row it is pinned
    // to the attempt it claimed, see `step-api.ts`): another execution of the
    // step recorded its own outcome first, a run.cancel sweep holds the row,
    // or the row is gone with its stage record. A batch the row does not list
    // is then this execution's alone, and nothing would ever cancel it.
    let made: EngineBatchRef[] = [];
    let madeKey = "";
    const batchWarn = (message: string) =>
      deps.onBatchWarn
        ? deps.onBatchWarn(message)
        : deps.onLog?.("WARN", message);
    /**
     * Send one cancel for `refs` and sort the answers: settled (cancelled,
     * ended, or a provider with no cancel call) and failed, by kind of failure
     * (what a replay compares to decide whether to warn again).
     */
    const sendCancel = async (refs: EngineBatchRef[]) => {
      let outcomes: AIBatchCancelResult[] | undefined;
      let why: string | undefined;
      try {
        outcomes = await batch.cancel?.(refs[0]!.id, { batchRefs: refs });
      } catch (error) {
        why = errorMessage(error);
      }
      const answered = new Map<string, OwedAnswer>();
      for (const o of outcomes ?? []) {
        if (o.outcome === "cancelled") answered.set(o.ref.id, "cancelled");
        else if (o.outcome === "already-terminal")
          answered.set(o.ref.id, "ended");
        else if (o.outcome === "unsupported")
          answered.set(o.ref.id, "unsupported");
      }
      const kind =
        why !== undefined
          ? "error"
          : outcomes
            ? "unanswered"
            : "no-transport-cancel";
      const failed = new Map(
        refs
          .filter((ref) => !answered.has(ref.id))
          .map((ref) => [ref.id, kind]),
      );
      return {
        answered,
        failed,
        why:
          why ?? (outcomes ? "no answer" : "its transport has no cancel call"),
      };
    };
    const quoted = (ids: string[]) => ids.map((x) => `"${x}"`).join(", ");
    /** Owed batches whose provider has no cancel call: settled, once. */
    const warnNoCancel = (refs: EngineBatchRef[]) => {
      if (refs.length === 0) return;
      batchWarn(
        `AI map "${id}": batch(es) ${quoted(refs.map((ref) => ref.id))}, created by an execution of the submit step that lost it, are owed a cancel, and their provider (${[...new Set(refs.map((ref) => ref.provider))].join(", ")}) has no cancel call. The engine cannot cancel them and will not try again: they run until they end and are billed. Cancel them in the provider's console if it has one, otherwise let them end. They are recorded on the step (noCancelBatchIds) and are never adopted.`,
      );
    };
    const warnOwedFailed = (ids: string[], why: string, next: string) => {
      if (ids.length === 0) return;
      batchWarn(
        `AI map "${id}": batch(es) ${quoted(ids)}, created by an earlier execution of the submit step that lost it, are owed a cancel and cancelling them failed (${why}). They may still be running and billed; they stay owed on the step and ${next}. Cancel them at the provider to stop the billing now.`,
      );
    };
    /**
     * Cancel batches this execution created that its row does not list. When
     * `owed` they are recorded on the row as owed a cancel, which is settled
     * (or its failure recorded) once the provider answers.
     */
    const cancelUnlisted = async (
      lost: EngineBatchRef[],
      why: string,
      owed = false,
    ) => {
      const sent = await sendCancel(lost);
      let notCancelled = lost.filter((ref) => !sent.answered.has(ref.id));
      if (owed) {
        await deps
          .settleBatches?.(`${id}:submit`, sent.answered, sent.failed)
          .catch(() => {});
        warnNoCancel(
          lost.filter((ref) => sent.answered.get(ref.id) === "unsupported"),
        );
      } else {
        notCancelled = lost.filter(
          (ref) =>
            !sent.answered.has(ref.id) ||
            sent.answered.get(ref.id) === "unsupported",
        );
      }
      if (notCancelled.length > 0) {
        const failure = sent.failed.size > 0 ? sent.why : "unsupported";
        batchWarn(
          `AI map "${id}": batch(es) ${quoted(notCancelled.map((ref) => ref.id))} were created by an execution of the submit step whose outcome was not recorded (${why}), and cancelling them failed (${failure}). They may still be running and billed; look them up by external key ${madeKey}.`,
        );
      }
    };
    const REPLAY_NEXT =
      "the stage's next execution tries again on a backoff (a run.cancel or a run.redrive sends it at once)";
    /**
     * A replay's read of the submit row completes the cancels it owes. Only
     * those due by the row's `cancelRetry` are sent, and a WARN names a batch
     * only when its kind of failure is new or changed.
     */
    const completeOwed = async (result: unknown) => {
      const now = deps.now?.();
      const owed = now ? dueOwedRefs(result, now) : owedRefsOf(result);
      if (owed.length === 0) return;
      const sent = await sendCancel(owed);
      const settled: OwedSettlement | undefined = await deps
        .settleBatches?.(`${id}:submit`, sent.answered, sent.failed)
        .catch(() => undefined);
      warnOwedFailed(
        settled ? settled.changed : [...sent.failed.keys()],
        sent.why,
        REPLAY_NEXT,
      );
      const noCancel = settled
        ? settled.noCancel
        : owed
            .filter((ref) => sent.answered.get(ref.id) === "unsupported")
            .map((ref) => ref.id);
      warnNoCancel(owed.filter((ref) => noCancel.includes(ref.id)));
    };
    const releaseUnlisted = async () => {
      if (made.length === 0 || !deps.loadRow) return;
      for (let tries = 0; tries < 3; tries++) {
        let row: StepRecord | null;
        try {
          row = await deps.loadRow(`${id}:submit`);
        } catch {
          break;
        }
        const record = parseStoredSubmit(row?.result);
        const listed = new Set(record?.refs.map((ref) => ref.id) ?? []);
        const lost = made.filter((ref) => !listed.has(ref.id));
        if (lost.length === 0) return;
        // Gone with its stage record (or a ledger cleared whole): no
        // execution searches under this row's key again.
        if (row === null) return cancelUnlisted(lost, "the step's row is gone");
        // Already recorded as owed a cancel or cancelled (by an exclusion
        // write of this execution whose answer was lost, or by a sweep): the
        // record does not cancel them, so this execution does (idempotent:
        // the transports read the batch first).
        const excluded = excludedIdsOf(row.result);
        if (lost.every((ref) => excluded.includes(ref.id))) {
          return cancelUnlisted(
            lost,
            "they are recorded on the step as excluded",
            true,
          );
        }
        // A running row with a lease has a holder; one with no lease (a
        // sweep's write-back, a reset, a re-open) has none until a takeover,
        // which moves the attempt, so it is recorded on like a settled row.
        if (row.status === "running" && row.leaseExpiresAt !== null) {
          // A sweep holds the row: the run is cancelled and nothing will
          // continue on these. Its writes are its own, so nothing is written.
          if (hasCancelFence(row)) {
            return cancelUnlisted(lost, "a run.cancel sweep holds the row");
          }
          // Another execution of the step holds it. Where its transport can
          // search by the external key it may adopt them, and cancelling could
          // cancel the batch it waits on. Where it cannot, it lists only what
          // the row held when it claimed (listed above, on this fresh read)
          // and batches it creates itself, so these are never listed.
          if (!((await batch.canAdopt?.().catch(() => true)) ?? true)) {
            return cancelUnlisted(
              lost,
              `another execution holds the step (attempt ${row.attempt}) and its transport cannot adopt them`,
            );
          }
          batchWarn(
            `AI map "${id}": batch(es) ${lost.map((ref) => `"${ref.id}"`).join(", ")} were created by an execution of the submit step that lost the step to another execution (attempt ${row.attempt}), which adopts them by external key ${madeKey} or leaves them running.`,
          );
          return;
        }
        // Recorded first as owed a cancel (never adopted, never waited on,
        // and completed by whoever reads the row next if this process stops
        // here), then cancelled. A write whose answer is lost may have
        // applied: the row is read again.
        const recorded = await deps
          .excludeBatches?.(`${id}:submit`, row, lost)
          .catch(() => false);
        if (recorded) {
          return cancelUnlisted(
            lost,
            "another execution recorded its outcome first",
            true,
          );
        }
      }
      batchWarn(
        `AI map "${id}": batch(es) ${made.map((ref) => `"${ref.id}"`).join(", ")} were created by an execution of the submit step whose outcome was not recorded, and they could not be recorded on the step; they were not cancelled. Look them up by external key ${madeKey}.`,
      );
    };

    let submitted: StoredSubmit;
    let ranBody = false;
    try {
      submitted = await deps.run(
        `${id}:submit`,
        async (step): Promise<StoredSubmit> => {
          ranBody = true;
          madeKey = step.externalKey;
          const requests: AIBatchRequest[] = entries.map((e) => ({
            id: e.id,
            prompt: e.prompt as string,
            ...(spec.schema ? { schema: spec.schema } : {}),
            ...(spec.system !== undefined ? { system: spec.system } : {}),
            ...(spec.maxTokens !== undefined
              ? { maxTokens: spec.maxTokens }
              : {}),
            ...(spec.temperature !== undefined
              ? { temperature: spec.temperature }
              : {}),
          }));
          // What an earlier execution recorded on this row. After the engine
          // cancelled every batch of it (`run.cancel`), the row carries a
          // tombstone; the execution that takes the re-opened row over, and only
          // that one, may create a new batch without the adoption search, which
          // a transport that cannot adopt would refuse. A later takeover (a
          // crash while creating the replacement) searches as usual. Batches the
          // engine cancelled are excluded from every search: a provider that
          // cancels asynchronously can still list one as running.
          const earlier = step.isReclaim
            ? await deps.storedResult?.(step.stepId)
            : undefined;
          let previous = parseStoredSubmit(earlier);
          // Batches an execution of this step created and lost, and still owes
          // a cancel (`cancelOwed`, see `releaseUnlisted`; its process may have
          // stopped before the request left). Cancelled now, whatever else this
          // execution does (idempotent); never adopted.
          // Sent at once (an execution of the step is rare and bounded); the
          // failures are recorded for the replays (`cancelRetry`), and a WARN
          // names a batch only when its kind of failure changed.
          const owed = owedRefsOf(earlier);
          let owedLeft = owed;
          const settled: string[] = [];
          const noCancel: string[] = [
            ...((earlier as { noCancelBatchIds?: string[] } | undefined)
              ?.noCancelBatchIds ?? []),
          ];
          let retry = owedRetryOf(earlier);
          if (owed.length > 0) {
            const sent = await sendCancel(owed);
            for (const [batchId, how] of sent.answered) {
              if (how === "cancelled") settled.push(batchId);
              if (how === "unsupported") noCancel.push(batchId);
            }
            owedLeft = owed.filter((ref) => !sent.answered.has(ref.id));
            const prior = retry;
            const now = deps.now?.();
            retry = Object.fromEntries(
              Object.entries(
                now ? nextOwedRetry(prior, sent.failed, now) : prior,
              ).filter(([batchId]) =>
                owedLeft.some((ref) => ref.id === batchId),
              ),
            );
            warnOwedFailed(
              [...sent.failed.keys()],
              sent.why,
              "its next execution tries again",
            );
            warnNoCancel(
              owed.filter((ref) => sent.answered.get(ref.id) === "unsupported"),
            );
            if (previous) {
              const {
                cancelOwed: _owed,
                cancelRetry: _retry,
                noCancelBatchIds: _none,
                ...rest
              } = previous;
              const ids = [
                ...new Set([...(previous.cancelledBatchIds ?? []), ...settled]),
              ];
              previous = {
                ...rest,
                ...(ids.length > 0 ? { cancelledBatchIds: ids } : {}),
                ...(noCancel.length > 0 ? { noCancelBatchIds: noCancel } : {}),
                ...(owedLeft.length > 0 ? { cancelOwed: owedLeft } : {}),
                ...(Object.keys(retry).length > 0
                  ? { cancelRetry: retry }
                  : {}),
              };
            }
          }
          // A run.cancel sweep held this row. Its fence (the sweep died holding
          // it) says nothing was sent unless the record also carries
          // `cancelIntent`: batches a cancel may have been sent for, with no
          // recorded outcome (a timeout, a lost response, a crash, a lost final
          // write). Those are cancelled now (idempotent: the transports read the
          // batch first) and the step goes on from the answer, never from an
          // active status alone, which a provider that cancels asynchronously
          // still reports after it accepted the cancel. When the cancel cannot be
          // completed the step fails, keeping the intent, and its next attempt
          // tries again: waiting on a batch a cancel may have reached could fail
          // the stage, and the run.cancel asked for it to be cancelled anyway.
          if (
            previous !== undefined &&
            (previous.cancelFence !== undefined ||
              previous.cancelIntent !== undefined)
          ) {
            const { cancelFence, cancelIntent, ...rest } = previous;
            const intentIds = cancelIntent?.batchIds ?? [];
            // The hold moved the row's attempt without executing anything (and a
            // takeover that failed here created nothing): the tombstone counts
            // from the attempt before the hold, and this execution is the
            // takeover that follows it.
            let held = rebaseMarkers(
              rest,
              cancelFence
                ? [cancelFence.fromAttempt, step.attempt - 1]
                : [step.attempt - 1],
              step.attempt - 1,
            ) as StoredSubmit;
            const pending = held.refs.filter((ref) =>
              intentIds.includes(ref.id),
            );
            if (pending.length > 0) {
              let outcomes: AIBatchCancelResult[] | undefined;
              let why = "its transport has no cancel call";
              try {
                outcomes = await batch.cancel?.(held.handleId, {
                  batchRefs: pending,
                });
              } catch (error) {
                why = errorMessage(error);
              }
              if (
                !outcomes ||
                outcomes.some((o) => o.outcome === "unsupported")
              ) {
                const message = `AI map "${id}": run.cancel may have sent a cancel for batch(es) ${pending.map((ref) => `"${ref.id}"`).join(", ")} and its outcome is not recorded; completing the cancel failed (${why}). The step fails rather than wait on a batch that may be cancelled; its next attempt tries again.`;
                batchWarn(message);
                // Nothing is written: the row keeps its fence and intent, and
                // the failure write puts the failure record beside them.
                throw new Error(message);
              }
              const cancelledIds = outcomes
                .filter((o) => o.outcome === "cancelled")
                .map((o) => o.ref.id);
              if (cancelledIds.length > 0) {
                held = {
                  ...held,
                  cancelledBatchIds: [
                    ...new Set([
                      ...(held.cancelledBatchIds ?? []),
                      ...cancelledIds,
                    ]),
                  ],
                };
              }
            }
            const dead = held.refs.filter((ref) =>
              held.cancelledBatchIds?.includes(ref.id),
            );
            if (dead.length === held.refs.length && !held.engineCancelled) {
              // This execution is the takeover that replaces the batch.
              held = {
                ...held,
                engineCancelled: {
                  attempt: step.attempt - 1,
                  generation: (held.generation ?? 0) + 1,
                },
              };
            }
            // Nothing was cancelled: the batches are as recorded.
            if (dead.length === 0 && !held.engineCancelled && !held.partial) {
              return held;
            }
            // Recorded before anything is created, so a crash after the
            // replacement was created cannot make the next takeover create
            // another.
            await deps.storeResult?.(step.stepId, held, step.attempt);
            previous = held;
          }
          const tombstone = previous?.engineCancelled;
          const replacing =
            tombstone !== undefined && tombstone.attempt + 1 === step.attempt;
          const generation = tombstone?.generation ?? previous?.generation;
          // A row whose result is not a submit record can still list batches
          // another execution of this step created and cancelled, or owes a
          // cancel (see `releaseUnlisted` above). None of them is ever adopted.
          const cancelledIds = [
            ...new Set([
              ...(previous?.cancelledBatchIds ?? cancelledIdsOf(earlier) ?? []),
              ...settled,
            ]),
          ];
          const excluded = [
            ...new Set([
              ...cancelledIds,
              ...noCancel,
              ...owed.map((ref) => ref.id),
            ]),
          ];
          // Partitions an earlier execution created before a later one was
          // rejected are reused, not created twice.
          const resume =
            previous?.partial === true &&
            tombstone === undefined &&
            previous.refs.every((ref) => !excluded.includes(ref.id))
              ? previous.refs
              : undefined;
          const record = (
            refs: EngineBatchRef[],
            extra: Partial<StoredSubmit> = {},
          ): StoredSubmit => ({
            handleId: refs[0]!.id,
            refs,
            requestIds,
            totalRequests: requests.length,
            submittedAt: new Date().toISOString(),
            // The engine's proof that it wrote this record (see
            // `batch-submit-record.ts`): `run.cancel` cancels nothing without it.
            externalKey: step.externalKey,
            ...(generation !== undefined ? { generation } : {}),
            ...(cancelledIds.length > 0
              ? { cancelledBatchIds: [...cancelledIds] }
              : {}),
            ...(noCancel.length > 0 ? { noCancelBatchIds: noCancel } : {}),
            ...(owedLeft.length > 0 ? { cancelOwed: owedLeft } : {}),
            ...(owedLeft.length > 0 && Object.keys(retry).length > 0
              ? { cancelRetry: retry }
              : {}),
            ...extra,
          });
          /**
           * Cancel batches the provider accepted for a run that was cancelled;
           * the row keeps the verdict. The row says first that a cancel may be
           * sent (`cancelIntent`); the intent stays when the outcome is unknown,
           * so whoever executes the step next completes the cancel.
           */
          const cancelCreated = async (
            refs: EngineBatchRef[],
            stored: StoredSubmit,
          ): Promise<StoredSubmit> => {
            // A complete record is the step's batch; a partial one resumes.
            const intent = {
              batchIds: refs.map((ref) => ref.id),
              from: stored.partial
                ? ("failed" as const)
                : ("completed" as const),
            };
            let unsettled: string | undefined;
            let outcomes: AIBatchCancelResult[] | undefined;
            let uncertain = false;
            try {
              if (!deps.storeResult)
                throw new Error("no step ledger to record it");
              await deps.storeResult(
                step.stepId,
                { ...stored, cancelIntent: intent },
                step.attempt,
              );
            } catch (error) {
              // Another execution has the row: these are a loser's batches,
              // which `releaseUnlisted` records and cancels.
              if (error instanceof StepLeaseLostError) throw error;
              unsettled = `the cancel could not be recorded first: ${errorMessage(error)}`;
            }
            if (unsettled === undefined) {
              try {
                outcomes = await batch.cancel?.(refs[0]!.id, {
                  batchRefs: refs,
                });
                if (
                  !outcomes ||
                  outcomes.some((o) => o.outcome === "unsupported")
                ) {
                  unsettled = "its transport has no cancel call";
                } else if (outcomes.some((o) => o.outcome !== "cancelled")) {
                  unsettled = "a batch had already ended";
                }
              } catch (error) {
                unsettled = errorMessage(error);
                uncertain = true;
              }
            }
            const cancelledIds = (outcomes ?? [])
              .filter((o) => o.outcome === "cancelled")
              .map((o) => o.ref.id);
            const known: StoredSubmit = {
              ...stored,
              ...(cancelledIds.length > 0
                ? {
                    cancelledBatchIds: [
                      ...new Set([
                        ...(stored.cancelledBatchIds ?? []),
                        ...cancelledIds,
                      ]),
                    ],
                  }
                : {}),
            };
            if (unsettled === undefined) {
              return {
                ...known,
                engineCancelled: {
                  attempt: step.attempt,
                  generation: (generation ?? 0) + 1,
                },
              };
            }
            batchWarn(
              `AI map "${id}": the run was cancelled while a batch submit was in flight, and batch(es) ${refs.map((ref) => `"${ref.id}"`).join(", ")} could not be cancelled (${unsettled}). They may still be running and billed; look them up by external key ${step.externalKey}.`,
            );
            return uncertain ? { ...known, cancelIntent: intent } : known;
          };
          const cancelled = () =>
            stageAbortReason(step.abortSignal) === "cancelled";
          // The provider bills a batch the moment it is created, so a replay
          // of this step must find what a dead worker already created rather
          // than create a second one. `step.externalKey` is the same on every
          // replay; `step.isReclaim` is true only when an earlier execution of
          // this body may have run.
          let handle: Awaited<ReturnType<typeof batch.submit>>;
          try {
            handle = await batch.submit(requests, {
              externalKey: step.externalKey,
              recovering: step.isReclaim && !replacing,
              ...(excluded.length > 0 ? { excludeBatchIds: excluded } : {}),
              ...(resume ? { existingRefs: resume } : {}),
              ...(spec.batch?.onReclaim
                ? { onReclaim: spec.batch.onReclaim }
                : {}),
            });
          } catch (error) {
            // A later partition was rejected after earlier ones were accepted:
            // those batches are running and billed. Keep them reachable in the
            // row (a retry resumes after them, `run.cancel` can cancel them) and
            // cancel them now when the run was cancelled.
            const created = createdRefsOf(error);
            made = created;
            if (created.length > 0) {
              let stored = record(created, { partial: true });
              if (cancelled()) stored = await cancelCreated(created, stored);
              await deps
                .storeResult?.(step.stepId, stored, step.attempt)
                .catch((writeError) =>
                  batchWarn(
                    `AI map "${id}": batch(es) ${created.map((ref) => `"${ref.id}"`).join(", ")} were accepted before the submit failed, and recording them failed (${errorMessage(writeError)}); look them up by external key ${step.externalKey}.`,
                  ),
                );
            }
            throw error;
          }
          const stored = record(handle.refs ?? [], {
            handleId: handle.id,
            totalRequests: handle.totalRequests ?? requests.length,
          });
          // The cancel can land while the provider call is in flight, after
          // `run.cancel` read the ledger and before this result is recorded.
          // `step.run` discards the result of a body that finished after a
          // cancel, so the handle would be lost with the batch still billed:
          // cancel it here, while the refs are in hand. When every batch is
          // cancelled, the row keeps the record with the tombstone, so a redrive
          // replaces them on any transport; otherwise it is warned about.
          // Known as made first: a write here that loses the row leaves them
          // to the loser's cleanup (`releaseUnlisted`).
          made = stored.refs;
          if (cancelled() && stored.refs.length > 0) {
            await deps.storeResult?.(
              step.stepId,
              await cancelCreated(stored.refs, stored),
              step.attempt,
            );
          }
          return stored;
        },
      );
    } catch (error) {
      await releaseUnlisted();
      // A failed submit with no retry left is replayed by throwing its
      // stored error: that read completes the owed cancels too.
      if (!ranBody) {
        const row = await deps.loadRow?.(`${id}:submit`).catch(() => null);
        if (row?.status === "failed") await completeOwed(row.result);
      }
      throw error;
    }
    if (made.some((ref) => !submitted.refs.some((r) => r.id === ref.id))) {
      await releaseUnlisted();
    }
    // A recorded submit is replayed, never executed again, so the body's
    // recovery above never sees a batch a loser recorded as owed after the
    // row was completed (its process may have stopped before the cancel
    // left). Every replay of the stage reads the row, so the replay completes
    // the cancel; the provider's answer moves it to `cancelledBatchIds`.
    if (!ranBody) await completeOwed(submitted);

    // A replaced batch (see `batch-submit-record.ts`) polls and collects under
    // its own step ids, so rows the cancelled batch left behind stay unread.
    const tag = generationTag(submitted.generation);
    const refsMetadata =
      submitted.refs.length > 0 ? { batchRefs: submitted.refs } : {};
    const onExpiry = spec.batch?.onExpiry ?? "fail";

    const allFailed = (error: string, errorName: string): AiMapResult<TOut>[] =>
      entries.map((e) => ({
        id: e.id,
        index: e.index,
        status: "failed",
        error,
        errorName,
        attempts: 1,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      }));

    let status: { status: string; error?: string };
    try {
      status = await deps.waitFor(`${id}:poll${tag}`, {
        poll: () => batch.getStatus(submitted.handleId, refsMetadata),
        ready: (s) => s.status === "completed" || s.status === "failed",
        every: spec.batch?.pollEvery ?? "60s",
        timeout: spec.batch?.timeout ?? "24h",
      });
    } catch (error) {
      if (isStepControlFlowError(error)) throw error;
      // A duplicate step key is a bug in the stage definition, not an
      // item that failed: burying it in a verdict is exactly the
      // silence the guard exists to remove.
      if (isDuplicateStepKeyError(error)) throw error;
      if (error instanceof StepTimeoutError && onExpiry === "partial") {
        return allFailed(error.message, error.name);
      }
      throw error;
    }

    if (status.status === "failed") {
      const reason = status.error ?? "batch reported failure";
      if (onExpiry === "partial") {
        return allFailed(reason, "AiMapBatchFailedError");
      }
      throw new AiMapBatchFailedError(id, submitted.handleId, reason);
    }

    // ---- Collect ----------------------------------------------------------
    // The collect step memoizes the fetch (and therefore the accounting rows)
    // and stores only a summary: counts, the failed items, and the feedback
    // for the items the repair pass will re-prompt. Every item's verdict
    // lives on its own `${id}:${itemId}` row, exactly as on the realtime
    // path, so `workflow_steps.result` does not grow with the batch size.
    const resultsMetadata = {
      ...refsMetadata,
      requestIds: submitted.requestIds,
      totalRequests: submitted.totalRequests,
      // Accounting rows: the item prompt and the batch wall time.
      prompts: Object.fromEntries(
        entries.map((e) => [e.id, e.prompt as string]),
      ),
      ...(submitted.submittedAt ? { submittedAt: submitted.submittedAt } : {}),
      ...(spec.schema
        ? {
            schemas: Object.fromEntries(
              submitted.requestIds.map((rid) => [rid, spec.schema]),
            ),
          }
        : {}),
    };

    const toVerdict = (
      e: ItemEntry<TIn>,
      r: AIBatchResult<unknown> | undefined,
    ): AiMapResult<TOut> => {
      if (!r) {
        return {
          id: e.id,
          index: e.index,
          status: "failed",
          error: "batch returned no result for this request",
          errorName: "AiMapBatchItemMissingError",
          attempts: 1,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        };
      }
      let cost = 0;
      try {
        cost = calculateCostWithDiscount(
          spec.model,
          r.inputTokens,
          r.outputTokens,
          true,
          provider,
        );
      } catch {
        cost = 0;
      }
      if (r.status === "failed") {
        return {
          id: e.id,
          index: e.index,
          status: "failed",
          error: r.error,
          errorName: "AiMapBatchItemFailedError",
          attempts: 1,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cost,
        };
      }
      return {
        id: e.id,
        index: e.index,
        status: "succeeded",
        result: r.result as TOut,
        validated: r.validated === true,
        attempts: 1,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cost,
      };
    };

    // The verdicts of this execution's fetch. Undefined on a replay whose
    // collect step was memoized; an item row missing then (the process died
    // between the collect and that row) re-fetches — an idempotent read, and
    // the accounting rows are recorded once per batch id by the logger.
    let fetched: Map<string, AiMapResult<TOut>> | undefined;
    const fetchVerdicts = async (): Promise<Map<string, AiMapResult<TOut>>> => {
      const results = await batch.getResults(
        submitted.handleId,
        resultsMetadata,
      );
      const byId = new Map(results.map((r) => [r.id, r]));
      return new Map(entries.map((e) => [e.id, toVerdict(e, byId.get(e.id))]));
    };

    const summary = await deps.run(
      `${id}:collect${tag}`,
      async (): Promise<CollectSummary> => {
        fetched = await fetchVerdicts();
        let succeeded = 0;
        const failed: FailedItemSummary[] = [];
        const repair: RepairItemSummary[] = [];
        // Each item is listed once, so its batch-phase tokens and cost are
        // attributed once: under `repair` (as the prior attempt the repair
        // pass continues from) when it will be re-prompted, under `failed`
        // when the batch verdict is final.
        for (const e of entries) {
          const v = fetched.get(e.id)!;
          if (v.status === "failed") {
            if (repairAttempts === 0) {
              failed.push({
                id: v.id,
                error: v.error,
                errorName: v.errorName ?? "AiMapBatchItemFailedError",
                inputTokens: v.inputTokens,
                outputTokens: v.outputTokens,
                cost: v.cost,
              });
            } else {
              repair.push({
                id: v.id,
                attempts: v.attempts,
                inputTokens: v.inputTokens,
                outputTokens: v.outputTokens,
                cost: v.cost,
                feedback: { issues: v.error },
              });
            }
            continue;
          }
          succeeded++;
          if (repairAttempts > 0 && spec.schema !== undefined && !v.validated) {
            repair.push({
              id: v.id,
              attempts: v.attempts,
              inputTokens: v.inputTokens,
              outputTokens: v.outputTokens,
              cost: v.cost,
              feedback: {
                output: stringify(v.result),
                issues:
                  "the response could not be validated against the schema",
              },
            });
          }
        }
        return { total: entries.length, succeeded, failed, repair };
      },
    );

    const repairIds = new Set(summary.repair.map((r) => r.id));
    const failedById = new Map(summary.failed.map((f) => [f.id, f]));

    /** Record a verdict the batch settled on its item row (memoized). */
    async function recordBatchVerdict(
      e: ItemEntry<TIn>,
    ): Promise<AiMapResult<TOut>> {
      const stepId = itemStepId(e.id);
      try {
        return await deps.run(stepId, async () => {
          const failed = failedById.get(e.id);
          if (failed) {
            throw new AiMapItemFailedSignal({
              id: e.id,
              index: e.index,
              status: "failed",
              error: failed.error,
              errorName: failed.errorName,
              attempts: 1,
              inputTokens: failed.inputTokens,
              outputTokens: failed.outputTokens,
              cost: failed.cost,
            });
          }
          fetched ??= await fetchVerdicts();
          const verdict = fetched.get(e.id);
          if (!verdict || verdict.status !== "succeeded") {
            throw new Error(
              `AI map "${id}": batch "${submitted.handleId}" returned no result for item "${e.id}" when re-fetched`,
            );
          }
          return verdict;
        });
      } catch (error) {
        if (isStepControlFlowError(error)) throw error;
        // A duplicate step key is a bug in the stage definition, not an
        // item that failed: burying it in a verdict is exactly the
        // silence the guard exists to remove.
        if (isDuplicateStepKeyError(error)) throw error;
        if (error instanceof AiMapItemFailedSignal) {
          await deps.storeFailedVerdict(stepId, error.verdict);
          return error.verdict as AiMapResult<TOut>;
        }
        const stored = (await deps.loadFailedVerdict(stepId)) as
          | AiMapResult<TOut>
          | undefined;
        if (stored && stored.status === "failed" && stored.id === e.id) {
          return stored;
        }
        throw error;
      }
    }

    // Items the batch settled get their rows first, in entry order (the
    // seq must be the same on every replay); the repair subset follows.
    const results: AiMapResult<TOut>[] = new Array(entries.length);
    const finals = entries.filter((e) => !repairIds.has(e.id));
    const settled = await runWithConcurrency(
      finals.map((e) => async () => {
        results[e.index] = await recordBatchVerdict(e);
      }),
      concurrency,
    );
    const reasons = settled
      .filter((s): s is PromiseRejectedResult => s?.status === "rejected")
      .map((s) => s.reason);
    if (reasons.length > 0) throw pickError(reasons);

    // ---- Repair pass (parity with realtime) --------------------------------
    if (summary.repair.length > 0) {
      const priors = new Map<string, PriorAttempt>(
        summary.repair.map((r) => [
          r.id,
          {
            attempts: r.attempts,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            cost: r.cost,
            feedback: r.feedback,
          },
        ]),
      );
      const subset = entries.filter((e) => repairIds.has(e.id));
      const repaired = await runRealtime(subset, priors);
      for (const r of repaired) results[r.index] = r;
    }
    return results;
  }

  return {
    generateText,
    generateObject,
    streamText,
    evaluate,
    transcribe,
    map,
  };
}
