/**
 * AI Helper - Batch Implementation
 *
 * AIBatch<T> implementation talking only to EngineBatchModel from ./batch/model.
 */

import { z } from "zod";
import {
  getProviderModelId,
  resolveModelForProvider,
} from "../utils/batch/model-mapping";
import { resolveAiSdkBatchModel } from "./batch/ai-sdk";
import {
  type EngineBatchItemResult,
  type EngineBatchModel,
  type EngineBatchRef,
  EngineBatchRefSchema,
  type EngineBatchRequest,
} from "./batch/model";
import { createOpenRouterBatchModel } from "./batch/openrouter";
import { getModel, type ModelKey } from "./model-helper";
import { calculateCostWithDiscount, logger } from "./shared";
import type {
  AIBatch,
  AIBatchHandle,
  AIBatchProvider,
  AIBatchRequest,
  AIBatchResult,
  AIHelperContext,
  BatchLogFn,
  BatchOptions,
} from "./types";

function resolveCustomId(item: EngineBatchItemResult): string | null {
  if (item.id && typeof item.id === "string" && item.id.trim().length > 0) {
    return item.id;
  }
  return null;
}

/**
 * Thrown by `AIBatch.submit()` when a later partition fails after earlier
 * ones were already created upstream. Those batches keep running and bill
 * the account, so their refs are carried here for reconciliation:
 * `getStatus(err.createdRefs[0].id, { batchRefs: err.createdRefs })`.
 */
export class BatchSubmitError extends Error {
  readonly name = "BatchSubmitError";
  constructor(
    message: string,
    public readonly createdRefs: EngineBatchRef[],
  ) {
    super(message);
  }
}

/** Accept an ISO string or epoch number (what a JSON step result holds). */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/**
 * The engine batch provider behind a stored ref's provider id
 * (`"openrouter"`, `"google.generative-ai"`, `"anthropic.messages"`,
 * `"openai.responses"`, ...).
 */
export function batchProviderFromRefProvider(
  providerId: string,
): AIBatchProvider | undefined {
  if (providerId === "openrouter") return "openrouter";
  if (providerId.startsWith("google")) return "google";
  if (providerId.startsWith("anthropic")) return "anthropic";
  if (providerId.startsWith("openai")) return "openai";
  return undefined;
}

export class AIBatchImpl<T = string> implements AIBatch<T> {
  private providerPromise?: Promise<EngineBatchModel>;

  /**
   * Schemas keyed by batchId -> requestId, populated at submit() time.
   */
  private schemasByBatch = new Map<string, Map<string, z.ZodTypeAny>>();

  /** Request counts keyed by batchId. */
  private requestCountsByBatch = new Map<string, number>();

  /** Prompts keyed by batchId -> requestId, for the accounting rows. */
  private promptsByBatch = new Map<string, Map<string, string>>();

  /** Submission time keyed by batchId, for `durationMs` on accounting rows. */
  private submittedAtByBatch = new Map<string, number>();

  /** Refs keyed by primary batchId, for fan-in in the same process. */
  private refsByBatch = new Map<string, EngineBatchRef[]>();

  /** In-flight recording promises by batchId to prevent check-then-act races. */
  private recordingPromises = new Map<string, Promise<void>>();

  /**
   * Batch ids already written to the cost ledger BY THIS PROCESS. Together
   * with `recordingPromises` this closes the in-process check-then-act race;
   * the AICallLogger's unique (batchId, requestId) index closes the
   * cross-process race.
   */
  private recordedBatchIds = new Set<string>();

  constructor(
    private ctx: AIHelperContext,
    private modelKey: ModelKey,
    private provider: AIBatchProvider,
    private batchLogFn?: BatchLogFn,
    private options?: BatchOptions,
    /** Pre-resolved backend; skips provider resolution. Used by tests and adapters. */
    backend?: EngineBatchModel,
  ) {
    if (backend) {
      this.providerPromise = Promise.resolve(backend);
      this.backendInjected = true;
    }
  }

  private backendInjected = false;

  /**
   * A batch that was submitted elsewhere (a poll or collect after a
   * suspend/resume, or in another process) must be read through the
   * transport that created it, which the stored refs name — not through
   * whatever the live registry resolves for the model key today. A
   * `batchProvider` change between submit and poll would otherwise strand
   * the run with "belongs to unknown provider".
   */
  private adoptProviderFromRefs(metadata?: Record<string, unknown>): void {
    // An injected backend is authoritative (tests, adapters).
    if (this.backendInjected) return;
    const rawRefs = metadata?.batchRefs;
    if (!Array.isArray(rawRefs) || rawRefs.length === 0) return;
    const first = rawRefs[0];
    const providerId =
      typeof first === "object" && first !== null
        ? (first as { provider?: unknown }).provider
        : undefined;
    if (typeof providerId !== "string") return;
    const provider = batchProviderFromRefProvider(providerId);
    if (provider === undefined || provider === this.provider) return;
    this.provider = provider;
    this.providerPromise = undefined;
  }

  /**
   * Lazy memoized backend resolution. Never runs in the constructor.
   */
  private async provider$(): Promise<EngineBatchModel> {
    return (this.providerPromise ??= (async () => {
      if (
        this.provider === "google" ||
        this.provider === "anthropic" ||
        this.provider === "openai"
      ) {
        const nativeModelId = resolveModelForProvider(
          this.modelKey,
          this.provider,
        );
        const warn = (message: string) => {
          if (this.batchLogFn) this.batchLogFn("WARN", message);
          else logger.warn(message);
        };
        try {
          return await resolveAiSdkBatchModel(this.provider, nativeModelId, {
            apiKey: this.options?.apiKey,
            baseURL: this.options?.baseURL,
            fetch: this.options?.fetch,
            onWarning: warn,
          });
        } catch (error) {
          // The vendor SDK is an optional peer. When it is not installed but
          // OpenRouter can batch the model (a ":batch" catalog row), use the
          // transport the consumer already has a key for rather than failing
          // the submit with an install instruction.
          const missingSdk =
            error instanceof Error &&
            /Package ".*" is required/.test(error.message);
          // A catalog generated before `batchModelId` existed names no
          // ":batch" sibling; derive it the way the sync CLI does
          // (`<id>:batch`) rather than failing on the install instruction.
          // OpenRouter answers "does not have a :batch endpoint" (explained
          // at submit) when the derived row is not live.
          const modelConfig = getModel(this.modelKey);
          const viaOpenRouter =
            getProviderModelId(this.modelKey, "openrouter") ??
            (modelConfig.supportsAsyncBatch ? modelConfig.id : undefined);
          if (!missingSdk || !viaOpenRouter) throw error;
          const derived = modelConfig.batchModelId === undefined;
          warn(
            `${error.message} Falling back to the OpenRouter batch transport for "${this.modelKey}"${
              derived
                ? ` (assuming OpenRouter serves "${modelConfig.id}:batch"; the catalog entry has no batchModelId — regenerate it with workflow-engine-sync)`
                : ""
            }; set batchProvider: "openrouter" on the model (or batch.provider) to make this explicit.`,
          );
          this.provider = "openrouter";
          return this.createOpenRouterModel();
        }
      }

      if (this.provider === "openrouter") {
        return this.createOpenRouterModel();
      }

      const _exhaustive: never = this.provider;
      throw new Error(`Unsupported batch provider "${_exhaustive}".`);
    })());
  }

  private createOpenRouterModel(): EngineBatchModel {
    const modelConfig = getModel(this.modelKey);
    const apiKey =
      this.options?.apiKey ??
      (typeof process !== "undefined"
        ? process.env?.OPENROUTER_API_KEY
        : undefined);

    if (!apiKey) {
      throw new Error(
        `OpenRouter batch processing requires an API key. ` +
          `Pass apiKey in BatchOptions or set the OPENROUTER_API_KEY environment variable.`,
      );
    }

    return createOpenRouterBatchModel({
      apiKey,
      modelId: modelConfig.id,
      baseURL: this.options?.baseURL,
      fetch: this.options?.fetch,
      endpoint: this.options?.endpoint,
    });
  }

  private resolveRefs(
    batchId: string,
    metadata?: Record<string, unknown>,
    batchModel?: EngineBatchModel,
  ): EngineBatchRef[] {
    let targetRefs: EngineBatchRef[] = [];

    if (
      metadata &&
      "batchRefs" in metadata &&
      metadata.batchRefs !== undefined
    ) {
      const rawBatchRefs = metadata.batchRefs;
      if (!Array.isArray(rawBatchRefs)) {
        throw new Error(
          `Invalid metadata.batchRefs: expected an array of EngineBatchRef, got ${typeof rawBatchRefs}`,
        );
      }
      if (rawBatchRefs.length === 0) {
        throw new Error(
          `Invalid metadata.batchRefs: batchRefs array cannot be empty`,
        );
      }
      for (const item of rawBatchRefs) {
        const parsed = EngineBatchRefSchema.safeParse(item);
        if (!parsed.success) {
          throw new Error(
            `Corrupted batch ref in metadata.batchRefs: ${parsed.error.message}`,
          );
        }
        if (batchModel && parsed.data.provider !== batchModel.provider) {
          throw new Error(
            `Batch ref provider "${parsed.data.provider}" does not match model provider "${batchModel.provider}"`,
          );
        }
        targetRefs.push(parsed.data);
      }
      return targetRefs;
    }

    const inMemoryRefs = this.refsByBatch.get(batchId);
    if (inMemoryRefs && inMemoryRefs.length > 0) {
      if (batchModel) {
        for (const ref of inMemoryRefs) {
          if (ref.provider !== batchModel.provider) {
            throw new Error(
              `Batch ref provider "${ref.provider}" does not match model provider "${batchModel.provider}"`,
            );
          }
        }
      }
      return inMemoryRefs;
    }

    // Legacy / single-batch fallback: synthesize one ref from the batch id.
    //
    // This path is REQUIRED for suspended state written before fan-out existed
    // (0.12 never partitioned, so one id was always the whole batch), which is
    // why it cannot simply throw. But if a 0.13 submit DID fan out and the
    // caller failed to persist `handle.refs`, this silently reduces the run to
    // the first batch. Warn loudly — a short result set here would otherwise
    // be auto-recorded to the cost ledger and marked complete.
    const warning =
      `[Batch] No batchRefs supplied for batch "${batchId}" and none in memory; ` +
      `assuming a single batch. If this stage fanned out across multiple batches, ` +
      `results from all but the first are MISSING. Persist handle.refs into ` +
      `suspendedState.metadata.batchRefs at submit time and pass that metadata to ` +
      `getStatus()/getResults().`;
    if (this.batchLogFn) {
      this.batchLogFn("WARN", warning, { batchId });
    } else {
      logger.warn(warning, { batchId });
    }

    const ref: EngineBatchRef = {
      version: 1,
      type: "text",
      id: batchId,
      provider: batchModel?.provider ?? this.provider,
      modelId: batchModel?.modelId ?? getModel(this.modelKey).id,
    };
    return [ref];
  }

  async submit(requests: AIBatchRequest[]): Promise<AIBatchHandle> {
    const seenIds = new Set<string>();
    for (const req of requests) {
      if (!req.id || typeof req.id !== "string" || req.id.trim().length === 0) {
        throw new Error("Batch request id must be a non-empty string");
      }
      if (seenIds.has(req.id)) {
        throw new Error(
          `Duplicate request id "${req.id}" in batch submission.`,
        );
      }
      seenIds.add(req.id);
    }

    if (requests.length === 0) {
      const modelConfig = getModel(this.modelKey);
      const emptyBatchId = `batch-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ref: EngineBatchRef = {
        version: 1,
        type: "text",
        id: emptyBatchId,
        provider: this.provider,
        modelId: modelConfig.id,
      };
      this.schemasByBatch.set(emptyBatchId, new Map());
      this.requestCountsByBatch.set(emptyBatchId, 0);
      this.refsByBatch.set(emptyBatchId, [ref]);

      return {
        id: emptyBatchId,
        status: "completed",
        provider: this.provider,
        refs: [ref],
        batchIds: [emptyBatchId],
        requestCounts: { total: 0, completed: 0, failed: 0 },
        totalRequests: 0,
      };
    }

    const batchModel = await this.provider$();
    const modelConfig = getModel(this.modelKey);

    logger.debug(`batch submit request`, {
      provider: this.provider,
      model: this.modelKey,
      requestCount: requests.length,
      requestIds: requests.slice(0, 10).map((r) => r.id),
      hasMoreRequests: requests.length > 10,
    });

    // Partition + Fan-Out (P9)
    // Group requests by stable key: (endpoint, modelId, stableHashOf(schema))
    // Requests with different schemas must not share a batch — Google rejects a batch whose requests disagree on response_format.
    const endpoint = this.options?.endpoint ?? "/v1/chat/completions";
    const partitionModelId = batchModel.modelId;

    const groupedRequests = new Map<string, AIBatchRequest[]>();
    for (const req of requests) {
      const schemaKey = req.schema
        ? JSON.stringify(z.toJSONSchema(req.schema))
        : "none";
      const key = `${endpoint}:${partitionModelId}:${schemaKey}`;
      let group = groupedRequests.get(key);
      if (!group) {
        group = [];
        groupedRequests.set(key, group);
      }
      group.push(req);
    }

    // Cap each group at maxRequestsPerBatch (default 500) and split into chunks.
    // OpenRouter returns results: null for an expired batch, so an uncapped 10k-request batch is a single bet you lose entirely at hour 24; capping bounds the loss.
    const maxRequestsPerBatch = this.options?.maxRequestsPerBatch ?? 500;
    const partitions: Array<{
      requests: AIBatchRequest[];
      engineRequests: EngineBatchRequest[];
    }> = [];

    for (const group of groupedRequests.values()) {
      for (let i = 0; i < group.length; i += maxRequestsPerBatch) {
        const chunk = group.slice(i, i + maxRequestsPerBatch);
        const engineRequests: EngineBatchRequest[] = chunk.map((req) => ({
          id: req.id,
          prompt: req.prompt,
          system: req.system,
          // P6c: previously hardcoded to 1024 on two of three providers, which
          // silently truncated structured output. Fall back to the model's own
          // ceiling, and leave it unset if that is unknown rather than guessing.
          maxOutputTokens:
            req.maxTokens ?? modelConfig.maxCompletionTokens ?? undefined,
          temperature: req.temperature,
          schema: req.schema,
        }));
        partitions.push({ requests: chunk, engineRequests });
      }
    }

    // Hard cardinality cap check (default 20)
    const maxPartitions = this.options?.maxPartitions ?? 20;
    if (partitions.length > maxPartitions) {
      throw new Error(
        `Batch submission produced ${partitions.length} partitions, exceeding the maximum allowed limit of ${maxPartitions}. ` +
          `Configure \`maxPartitions\` in BatchOptions to increase this limit.`,
      );
    }

    // Submit partitions sequentially so a rate limit stops at partition k instead of firing all N
    const createdRefs: EngineBatchRef[] = [];
    for (let i = 0; i < partitions.length; i++) {
      const partition = partitions[i]!;
      try {
        const res = await batchModel.start(partition.engineRequests, {
          abortSignal: this.options?.abortSignal,
        });
        const ref: EngineBatchRef = {
          version: 1,
          type: "text",
          id: res.id,
          provider: res.provider,
          modelId: res.modelId,
        };
        createdRefs.push(ref);
      } catch (err) {
        const createdIds = createdRefs.map((r) => r.id).join(", ");
        const errMsg = `Batch submission failed at partition ${i + 1}/${partitions.length}${
          createdRefs.length > 0
            ? `. Successfully created ${createdRefs.length} batch(es) before failure: [${createdIds}]`
            : ""
        }: ${err instanceof Error ? err.message : String(err)}`;
        const batchError = new BatchSubmitError(errMsg, createdRefs);
        if (err instanceof Error && err.stack) {
          batchError.stack = `${batchError.stack}\nCaused by: ${err.stack}`;
        }
        throw batchError;
      }
    }

    const refs = createdRefs;
    const batchIds = refs.map((r) => r.id);
    const primaryBatchId = batchIds[0] ?? "";

    // Save schemas and request counts for each partition
    const allSchemasById = new Map<string, z.ZodTypeAny>();
    for (let i = 0; i < partitions.length; i++) {
      const partition = partitions[i]!;
      const ref = refs[i]!;
      const partitionSchemasById = new Map<string, z.ZodTypeAny>();
      for (const req of partition.requests) {
        if (req.schema) {
          partitionSchemasById.set(req.id, req.schema);
          allSchemasById.set(req.id, req.schema);
        }
      }
      this.schemasByBatch.set(ref.id, partitionSchemasById);
      this.requestCountsByBatch.set(ref.id, partition.requests.length);
    }

    this.refsByBatch.set(primaryBatchId, refs);
    this.schemasByBatch.set(primaryBatchId, allSchemasById);
    this.requestCountsByBatch.set(primaryBatchId, requests.length);
    this.promptsByBatch.set(
      primaryBatchId,
      new Map(requests.map((req) => [req.id, req.prompt])),
    );
    this.submittedAtByBatch.set(primaryBatchId, Date.now());

    logger.debug(`batch submitted`, {
      provider: this.provider,
      batchId: primaryBatchId,
      batchIds,
      requestCount: requests.length,
      partitionCount: partitions.length,
    });

    return {
      id: primaryBatchId,
      status: "pending",
      provider: this.provider,
      refs,
      batchIds,
      requestCounts: {
        total: requests.length,
        completed: 0,
        failed: 0,
      },
      totalRequests: requests.length,
    };
  }

  async getStatus(
    batchId: string,
    metadata?: Record<string, unknown>,
  ): Promise<AIBatchHandle> {
    if (
      this.requestCountsByBatch.get(batchId) === 0 ||
      batchId.startsWith("batch-empty-")
    ) {
      const inMemoryRefs = this.refsByBatch.get(batchId);
      const refs: EngineBatchRef[] = inMemoryRefs ?? [
        {
          version: 1,
          type: "text",
          id: batchId,
          provider: this.provider,
          modelId: getModel(this.modelKey).id,
        },
      ];
      return {
        id: batchId,
        status: "completed",
        provider: this.provider,
        refs,
        batchIds: refs.map((r) => r.id),
        requestCounts: { total: 0, completed: 0, failed: 0 },
        totalRequests: 0,
      };
    }

    this.adoptProviderFromRefs(metadata);
    const batchModel = await this.provider$();
    const refs = this.resolveRefs(batchId, metadata, batchModel);

    const statuses = await Promise.all(
      refs.map((ref) =>
        batchModel.status(ref, {
          abortSignal: this.options?.abortSignal,
        }),
      ),
    );

    // Aggregate status across refs: failed if any failed; completed only if all completed; else processing/pending
    let aggregatedStatus: "pending" | "processing" | "completed" | "failed";
    const hasFailed = statuses.some((s) => s.status === "failed");
    const allCompleted =
      statuses.length > 0 && statuses.every((s) => s.status === "completed");
    const anyProcessing = statuses.some((s) => s.status === "processing");

    if (hasFailed) {
      aggregatedStatus = "failed";
    } else if (allCompleted) {
      aggregatedStatus = "completed";
    } else if (anyProcessing) {
      aggregatedStatus = "processing";
    } else {
      aggregatedStatus = "pending";
    }

    let totalCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let hasCounts = false;

    for (const s of statuses) {
      if (s.requestCounts) {
        hasCounts = true;
        totalCount += s.requestCounts.total;
        completedCount += s.requestCounts.completed;
        failedCount += s.requestCounts.failed;
      }
    }

    const errors = statuses
      .map((s) => s.error)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
    const aggregatedError = errors.length > 0 ? errors.join("; ") : undefined;

    // Per-item provider failures are visible in the counts as soon as the
    // batch settles; say so at the poll, not only after collect.
    if (aggregatedStatus === "completed" && hasCounts && failedCount > 0) {
      const warnMsg = `[Batch] ${failedCount} of ${totalCount} requests in batch ${batchId} failed at the provider; getResults() reports each item's error.`;
      if (this.batchLogFn) {
        this.batchLogFn("WARN", warnMsg, {
          batchId,
          failed: failedCount,
          total: totalCount,
        });
      } else {
        logger.warn(warnMsg, {
          batchId,
          failed: failedCount,
          total: totalCount,
        });
      }
    }

    return {
      id: batchId,
      status: aggregatedStatus,
      provider: this.provider,
      refs,
      batchIds: refs.map((r) => r.id),
      requestCounts: hasCounts
        ? { total: totalCount, completed: completedCount, failed: failedCount }
        : undefined,
      totalRequests: hasCounts ? totalCount : undefined,
      error: aggregatedError,
    };
  }

  async getResults(
    batchId: string,
    metadata?: Record<string, unknown>,
  ): Promise<AIBatchResult<T>[]> {
    if (this.batchLogFn) {
      this.batchLogFn("DEBUG", `[AIBatch:getResults] Received metadata`, {
        hasMetadata: !!metadata,
        metadataKeys: metadata ? Object.keys(metadata) : [],
        hasBatchRefs: !!metadata?.batchRefs,
      });
    }

    if (
      this.requestCountsByBatch.get(batchId) === 0 ||
      batchId.startsWith("batch-empty-")
    ) {
      const emptyResults: AIBatchResult<T>[] = [];
      await this.recordResults(batchId, emptyResults);
      return emptyResults;
    }

    this.adoptProviderFromRefs(metadata);
    const batchModel = await this.provider$();
    const targetRefs = this.resolveRefs(batchId, metadata, batchModel);

    const expectedTotal =
      (typeof metadata?.totalRequests === "number"
        ? metadata.totalRequests
        : undefined) ??
      (typeof metadata?.requestCount === "number"
        ? metadata.requestCount
        : undefined) ??
      (typeof (metadata?.requestCounts as any)?.total === "number"
        ? (metadata!.requestCounts as any).total
        : undefined) ??
      (typeof metadata?.expectedTotal === "number"
        ? metadata.expectedTotal
        : undefined) ??
      this.requestCountsByBatch.get(batchId) ??
      // The documented flow persists `requestIds` for schema re-supply; it is
      // also an exact expected count, so the truncation guard works there too.
      (Array.isArray(metadata?.requestIds)
        ? metadata.requestIds.length
        : undefined);

    const suppliedSchemas = metadata?.schemas as
      | Record<string, unknown>
      | undefined;
    const inProcessSchemas = this.schemasByBatch.get(batchId);
    // Prompts and the submission time are carried by the caller across a
    // suspend/resume (`metadata.prompts`, `metadata.submittedAt`); the
    // in-process maps cover the same-process case.
    const suppliedPrompts =
      metadata?.prompts && typeof metadata.prompts === "object"
        ? (metadata.prompts as Record<string, unknown>)
        : undefined;
    const inProcessPrompts = this.promptsByBatch.get(batchId);
    const promptFor = (id: string): string => {
      const supplied = suppliedPrompts?.[id];
      if (typeof supplied === "string") return supplied;
      return inProcessPrompts?.get(id) ?? "";
    };
    const submittedAt =
      toEpochMs(metadata?.submittedAt) ?? this.submittedAtByBatch.get(batchId);
    const durationMs =
      submittedAt !== undefined
        ? Math.max(0, Date.now() - submittedAt)
        : undefined;
    let schemaFailures = 0;
    let firstSchemaIssue: string | undefined;
    let providerFailures = 0;
    let firstProviderError: string | undefined;

    let unvalidatedCount = 0;
    let totalReceivedItems = 0;
    const results: AIBatchResult<T>[] = [];

    for (const ref of targetRefs) {
      for await (const item of batchModel.results(ref, {
        abortSignal: this.options?.abortSignal,
      })) {
        totalReceivedItems++;
        const customId = resolveCustomId(item);
        if (!customId) {
          results.push({
            id: item.id || "unknown",
            prompt: "",
            inputTokens: item.inputTokens ?? 0,
            outputTokens: item.outputTokens ?? 0,
            status: "failed",
            error:
              "Missing or empty custom ID in batch item result; cannot correlate with original request.",
            validated: false,
          });
          continue;
        }

        const inputTokens = item.inputTokens ?? 0;
        const outputTokens = item.outputTokens ?? 0;

        if (item.status !== "succeeded") {
          const error =
            item.error ?? `Batch item failed with status "${item.status}"`;
          providerFailures++;
          firstProviderError ??= error;
          results.push({
            id: customId,
            prompt: promptFor(customId),
            inputTokens,
            outputTokens,
            status: "failed",
            error,
            validated: false,
          });
          continue;
        }

        let parsedJson: unknown;
        let parseError: string | undefined;
        try {
          let cleaned = item.text.trim();
          if (cleaned.startsWith("```json")) {
            cleaned = cleaned.slice(7);
          } else if (cleaned.startsWith("```")) {
            cleaned = cleaned.slice(3);
          }
          if (cleaned.endsWith("```")) {
            cleaned = cleaned.slice(0, -3);
          }
          cleaned = cleaned.trim();
          parsedJson = JSON.parse(cleaned);
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
        }

        // A supplied value that is not a Zod schema (e.g. one that round-
        // tripped a JSON column) must not shadow a valid in-process schema.
        const supplied = suppliedSchemas?.[customId];
        const candidateSchema =
          supplied && typeof (supplied as any).safeParse === "function"
            ? supplied
            : inProcessSchemas?.get(customId);
        const schema =
          candidateSchema &&
          typeof (candidateSchema as any).safeParse === "function"
            ? (candidateSchema as z.ZodTypeAny)
            : undefined;

        if (schema) {
          if (parseError) {
            schemaFailures++;
            firstSchemaIssue ??= `Failed to parse JSON response for schema validation: ${parseError}`;
            results.push({
              id: customId,
              prompt: promptFor(customId),
              inputTokens,
              outputTokens,
              status: "failed",
              error: `Failed to parse JSON response for schema validation: ${parseError}`,
              validated: false,
              responseText: item.text,
            });
            continue;
          }

          let validation: ReturnType<z.ZodTypeAny["safeParse"]>;
          try {
            validation = schema.safeParse(parsedJson);
          } catch (schemaErr) {
            const errText =
              schemaErr instanceof Error
                ? schemaErr.message
                : String(schemaErr);
            results.push({
              id: customId,
              prompt: promptFor(customId),
              inputTokens,
              outputTokens,
              status: "failed",
              error: `Schema validation threw an error: ${errText}`,
              validated: false,
              responseText: item.text,
            });
            continue;
          }

          if (!validation.success) {
            schemaFailures++;
            firstSchemaIssue ??= validation.error.message;
            results.push({
              id: customId,
              prompt: promptFor(customId),
              inputTokens,
              outputTokens,
              status: "failed",
              error: `Response did not match the request's schema: ${validation.error.message}`,
              validated: false,
              responseText: item.text,
            });
            continue;
          }

          results.push({
            id: customId,
            prompt: promptFor(customId),
            result: validation.data as T,
            inputTokens,
            outputTokens,
            status: "succeeded",
            validated: true,
          });
        } else {
          unvalidatedCount++;
          const resultData = (
            parseError === undefined ? parsedJson : item.text
          ) as T;

          results.push({
            id: customId,
            prompt: promptFor(customId),
            result: resultData,
            inputTokens,
            outputTokens,
            status: "succeeded",
            validated: false,
          });
        }
      }
    }

    if (expectedTotal !== undefined && totalReceivedItems < expectedTotal) {
      throw new Error(
        `Batch result count (${totalReceivedItems}) is short of expected total (${expectedTotal}). Results were not recorded.`,
      );
    }

    if (unvalidatedCount > 0) {
      const warnMsg =
        `[Batch] ${unvalidatedCount} result(s) returned without schema validation. ` +
        `Zod schemas do not survive workflow serialization across suspend/resume. ` +
        `Re-supply schemas via getResults(batchId, { schemas: { [requestId]: schema } }) to validate.`;
      if (this.batchLogFn) {
        this.batchLogFn("WARN", warnMsg, { unvalidatedCount, batchId });
      } else {
        logger.warn(warnMsg, { unvalidatedCount, batchId });
      }
    }

    const failures = schemaFailures + providerFailures;
    if (results.length > 0 && failures * 2 > results.length) {
      // Every failed item is re-run realtime by the map's repair pass, so
      // the batch discount is lost twice over. Schema failures are usually
      // a schema the provider's structured-output mode cannot express;
      // provider failures are the endpoint rejecting the request itself.
      const classes = [
        schemaFailures > 0
          ? `${schemaFailures} failed schema validation (first issue: ${firstSchemaIssue ?? "unknown"})`
          : undefined,
        providerFailures > 0
          ? `${providerFailures} failed at the provider (first error: ${firstProviderError ?? "unknown"})`
          : undefined,
      ].filter((c): c is string => c !== undefined);
      const warnMsg = `[Batch] ${failures} of ${results.length} results in batch ${batchId} failed: ${classes.join("; ")}.`;
      const meta = {
        batchId,
        schemaFailures,
        providerFailures,
        total: results.length,
      };
      if (this.batchLogFn) {
        this.batchLogFn("WARN", warnMsg, meta);
      } else {
        logger.warn(warnMsg, meta);
      }
    }

    // Auto-record results
    await this.recordResults(batchId, results, { batchDurationMs: durationMs });

    return results;
  }

  async isRecorded(batchId: string): Promise<boolean> {
    if (this.recordedBatchIds.has(batchId)) {
      return true;
    }
    return this.ctx.aiCallLogger.isRecorded(batchId);
  }

  async recordResults(
    batchId: string,
    results: AIBatchResult<T>[],
    extra: { batchDurationMs?: number } = {},
  ): Promise<void> {
    if (this.recordedBatchIds.has(batchId)) {
      logger.debug(`Batch ${batchId} already recorded, skipping.`);
      return;
    }

    const inFlight = this.recordingPromises.get(batchId);
    if (inFlight) {
      return inFlight;
    }

    const recordPromise = (async () => {
      try {
        if (await this.isRecorded(batchId)) {
          logger.debug(`Batch ${batchId} already recorded, skipping.`);
          this.recordedBatchIds.add(batchId);
          return;
        }

        const modelConfig = getModel(this.modelKey);

        await this.ctx.aiCallLogger.logBatchResults(
          batchId,
          results.map((r) => {
            const cost = calculateCostWithDiscount(
              this.modelKey,
              r.inputTokens,
              r.outputTokens,
              true,
              this.provider,
            );

            return {
              topic: this.ctx.topic,
              callType: "batch",
              modelKey: this.modelKey,
              modelId: modelConfig.id,
              prompt: r.prompt,
              // The model's reply, or its raw text when the reply failed
              // validation; empty only when the provider failed the item.
              response:
                r.status === "succeeded"
                  ? typeof r.result === "string"
                    ? r.result
                    : JSON.stringify(r.result)
                  : (r.responseText ?? ""),
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              cost,
              batchId,
              requestId: r.id,
              metadata: {
                batchId,
                requestId: r.id,
                // Providers report no per-item latency; the batch wall
                // time is recorded under its own name rather than as a
                // per-call `durationMs`.
                ...(extra.batchDurationMs !== undefined
                  ? { batchDurationMs: extra.batchDurationMs }
                  : {}),
                ...(r.status === "failed"
                  ? { status: "failed", error: r.error }
                  : {}),
              },
            };
          }),
        );
        // Only after the ledger write succeeded. Marking before the await
        // meant one transient DB error left the id in the set, and every
        // later getResults() in this process skipped recording for good.
        this.recordedBatchIds.add(batchId);
      } finally {
        this.recordingPromises.delete(batchId);
      }
    })();

    this.recordingPromises.set(batchId, recordPromise);
    return recordPromise;
  }
}
