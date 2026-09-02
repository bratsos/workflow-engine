/**
 * AI Helper - Batch Implementation
 *
 * AIBatch<T> implementation talking only to EngineBatchModel from ./batch/model.
 */

import { z } from "zod";
import { resolveModelForProvider } from "../utils/batch/model-mapping";
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

export class AIBatchImpl<T = string> implements AIBatch<T> {
  private providerPromise?: Promise<EngineBatchModel>;

  /**
   * Schemas keyed by batchId -> requestId, populated at submit() time.
   */
  private schemasByBatch = new Map<string, Map<string, z.ZodTypeAny>>();

  /** Request counts keyed by batchId. */
  private requestCountsByBatch = new Map<string, number>();

  /** Refs keyed by primary batchId, for fan-in in the same process. */
  private refsByBatch = new Map<string, EngineBatchRef[]>();

  /** In-flight recording promises by batchId to prevent check-then-act races. */
  private recordingPromises = new Map<string, Promise<void>>();

  /** Recorded batch IDs to prevent duplicate recording. */
  private recordedBatchIds = new Set<string>();

  constructor(
    private ctx: AIHelperContext,
    private modelKey: ModelKey,
    private provider: AIBatchProvider,
    private batchLogFn?: BatchLogFn,
    private options?: BatchOptions,
  ) {}

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
        return resolveAiSdkBatchModel(this.provider, nativeModelId);
      }

      if (this.provider === "openrouter") {
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

      const _exhaustive: never = this.provider;
      throw new Error(`Unsupported batch provider "${_exhaustive}".`);
    })());
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
        const res = await batchModel.start(partition.engineRequests);
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
        const batchError = new Error(errMsg) as Error & {
          createdRefs?: EngineBatchRef[];
        };
        batchError.createdRefs = createdRefs;
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

    const batchModel = await this.provider$();
    const refs = this.resolveRefs(batchId, metadata, batchModel);

    const statuses = await Promise.all(
      refs.map((ref) => batchModel.status(ref)),
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
      batchId.startsWith("batch-empty-") ||
      metadata?.requestCount === 0 ||
      metadata?.totalRequests === 0
    ) {
      const emptyResults: AIBatchResult<T>[] = [];
      await this.recordResults(batchId, emptyResults);
      return emptyResults;
    }

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
      this.requestCountsByBatch.get(batchId);

    const suppliedSchemas = metadata?.schemas as
      | Record<string, unknown>
      | undefined;
    const inProcessSchemas = this.schemasByBatch.get(batchId);

    let unvalidatedCount = 0;
    let totalReceivedItems = 0;
    const results: AIBatchResult<T>[] = [];

    for (const ref of targetRefs) {
      for await (const item of batchModel.results(ref)) {
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
          results.push({
            id: customId,
            prompt: "",
            inputTokens,
            outputTokens,
            status: "failed",
            error:
              item.error ?? `Batch item failed with status "${item.status}"`,
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

        const candidateSchema =
          suppliedSchemas?.[customId] ?? inProcessSchemas?.get(customId);
        const schema =
          candidateSchema &&
          typeof (candidateSchema as any).safeParse === "function"
            ? (candidateSchema as z.ZodTypeAny)
            : undefined;

        if (schema) {
          if (parseError) {
            results.push({
              id: customId,
              prompt: "",
              inputTokens,
              outputTokens,
              status: "failed",
              error: `Failed to parse JSON response for schema validation: ${parseError}`,
              validated: false,
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
              prompt: "",
              inputTokens,
              outputTokens,
              status: "failed",
              error: `Schema validation threw an error: ${errText}`,
              validated: false,
            });
            continue;
          }

          if (!validation.success) {
            results.push({
              id: customId,
              prompt: "",
              inputTokens,
              outputTokens,
              status: "failed",
              error: `Response did not match the request's schema: ${validation.error.message}`,
              validated: false,
            });
            continue;
          }

          results.push({
            id: customId,
            prompt: "",
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
            prompt: "",
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

    // Auto-record results
    await this.recordResults(batchId, results);

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

        this.recordedBatchIds.add(batchId);

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
              response:
                r.status === "succeeded"
                  ? typeof r.result === "string"
                    ? r.result
                    : JSON.stringify(r.result)
                  : "",
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              cost,
              metadata:
                r.status === "failed"
                  ? {
                      batchId,
                      requestId: r.id,
                      status: "failed",
                      error: r.error,
                    }
                  : { batchId, requestId: r.id },
            };
          }),
        );
      } finally {
        this.recordingPromises.delete(batchId);
      }
    })();

    this.recordingPromises.set(batchId, recordPromise);
    return recordPromise;
  }
}
