/**
 * Durable AI steps: `ctx.step.ai.generateText/generateObject/map`.
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
  AIBatchProvider,
  AIBatchRequest,
  AIHelper,
  AIObjectResult,
  AITextResult,
  ObjectOptions,
  StreamOptions,
  StreamTextInput,
  TextInput,
  TextOptions,
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
  isStepControlFlowError,
  parseStepDuration,
  type StepApi,
  type StepControlFlowError,
  type StepRunOptions,
  StepSuspend,
  StepTimeoutError,
} from "../../core/steps";
import { getBestProviderForModel } from "../../utils/batch/model-mapping";

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_BATCH_ABOVE = 20;
const DEFAULT_REPAIR_ATTEMPTS = 1;
const DEFAULT_REALTIME_RETRIES = 1;
const RESERVED_ITEM_IDS = new Set(["submit", "poll", "collect"]);

export interface StepAiDeps {
  run: StepApi["run"];
  waitFor: StepApi["waitFor"];
  /** True when the step already holds a completed result (used to skip budget reservation). */
  isCompleted(stepId: string): Promise<boolean>;
  /** Record an in-process retry on a running step: bumps the row's `attempt`. */
  noteAttempt(stepId: string, attempt: number): Promise<void>;
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

interface StoredSubmit {
  handleId: string;
  refs: EngineBatchRef[];
  requestIds: string[];
  totalRequests: number;
  /** ISO time of the submit, for `durationMs` on the accounting rows. */
  submittedAt?: string;
}

interface Budget {
  reserve(): boolean;
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

/** Choose the error to surface: control flow first (earliest wake-up wins). */
function pickError(reasons: unknown[]): unknown {
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
    const retryDelayMs = parseStepDuration(spec.realtime?.retryDelayMs ?? 0);
    const minDelayMs = parseStepDuration(spec.realtime?.minDelayMs ?? 0);
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
      if (RESERVED_ITEM_IDS.has(itemId)) {
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
      let rowAttempt = 1;
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
        if (failure) {
          feedback = failure;
          return "repair";
        }
        if (retriesLeft <= 0) {
          return failed(
            errorMessage(error),
            error instanceof Error ? error.name : undefined,
          );
        }
        retriesLeft--;
        rowAttempt++;
        await deps.noteAttempt(stepId, rowAttempt);
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

    const submitted = await deps.run(
      `${id}:submit`,
      async (): Promise<StoredSubmit> => {
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
        const handle = await batch.submit(requests);
        return {
          handleId: handle.id,
          refs: handle.refs ?? [],
          requestIds,
          totalRequests: handle.totalRequests ?? requests.length,
          submittedAt: new Date().toISOString(),
        };
      },
    );

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
      status = await deps.waitFor(`${id}:poll`, {
        poll: () => batch.getStatus(submitted.handleId, refsMetadata),
        ready: (s) => s.status === "completed" || s.status === "failed",
        every: spec.batch?.pollEvery ?? "60s",
        timeout: spec.batch?.timeout ?? "24h",
      });
    } catch (error) {
      if (isStepControlFlowError(error)) throw error;
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

    const collected = await deps.run(
      `${id}:collect`,
      async (): Promise<AiMapResult<TOut>[]> => {
        const results = await batch.getResults(submitted.handleId, {
          ...refsMetadata,
          requestIds: submitted.requestIds,
          totalRequests: submitted.totalRequests,
          // Accounting rows: the item prompt and the batch wall time.
          prompts: Object.fromEntries(
            entries.map((e) => [e.id, e.prompt as string]),
          ),
          ...(submitted.submittedAt
            ? { submittedAt: submitted.submittedAt }
            : {}),
          ...(spec.schema
            ? {
                schemas: Object.fromEntries(
                  submitted.requestIds.map((rid) => [rid, spec.schema]),
                ),
              }
            : {}),
        });
        const byId = new Map(results.map((r) => [r.id, r]));
        return entries.map((e) => {
          const r = byId.get(e.id);
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
        });
      },
    );

    // ---- Repair pass (parity with realtime) --------------------------------

    const needsRepair = collected.filter(
      (r) =>
        r.status === "failed" || (spec.schema !== undefined && !r.validated),
    );
    if (repairAttempts === 0 || needsRepair.length === 0) return collected;

    const priors = new Map<string, PriorAttempt>();
    const subset: ItemEntry<TIn>[] = [];
    for (const r of needsRepair) {
      priors.set(r.id, {
        attempts: r.attempts,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cost: r.cost,
        feedback:
          r.status === "failed"
            ? { issues: r.error }
            : {
                output: stringify(r.result),
                issues:
                  "the response could not be validated against the schema",
              },
      });
      subset.push(entries[r.index]!);
    }
    const repaired = await runRealtime(subset, priors);
    const merged = [...collected];
    for (const r of repaired) merged[r.index] = r;
    return merged;
  }

  return { generateText, generateObject, streamText, map };
}
