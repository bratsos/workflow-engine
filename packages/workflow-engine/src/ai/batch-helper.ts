/**
 * AI Helper - Batch Implementation
 *
 * AIBatch<T> on top of the low-level provider classes in utils/batch/providers.
 */

import { z } from "zod";
import { AnthropicBatchProvider } from "../utils/batch/providers/anthropic-batch";
import { GoogleBatchProvider } from "../utils/batch/providers/google-batch";
import { OpenAIBatchProvider } from "../utils/batch/providers/openai-batch";
import type {
  BaseBatchRequest,
  BatchHandle,
  BatchLogger,
  BatchProvider,
  RawBatchResult,
} from "../utils/batch/types";
import { calculateCost, getModel, type ModelKey } from "./model-helper";
import { logger } from "./shared";
import type {
  AIBatch,
  AIBatchHandle,
  AIBatchProvider,
  AIBatchRequest,
  AIBatchResult,
  AIHelperContext,
  BatchLogFn,
} from "./types";

/**
 * Build a system prompt that communicates the exact expected output shape
 * to the model via its JSON Schema, rather than a vague "respond with JSON"
 * instruction. Used for batch providers (Anthropic, OpenAI) that don't have
 * native structured-output support in their batch APIs.
 */
function buildJsonSchemaSystemPrompt(schema: z.ZodTypeAny): string {
  const jsonSchema = z.toJSONSchema(schema);
  return (
    "You must respond with valid JSON only that conforms exactly to the " +
    "following JSON Schema. No markdown, no explanation, just the JSON object.\n\n" +
    `JSON Schema:\n${JSON.stringify(jsonSchema)}`
  );
}

export class AIBatchImpl<T = string> implements AIBatch<T> {
  private readonly batchProvider: BatchProvider<
    BaseBatchRequest,
    RawBatchResult
  >;

  /**
   * Schemas keyed by batchId -> customId, populated at submit() time so
   * getResults() can validate responses against them. This only survives
   * for the lifetime of this AIBatchImpl instance (i.e. the same process) -
   * a fresh instance created after a workflow suspend/resume won't have it.
   * Callers that need validation across a resume can re-supply schemas via
   * getResults(batchId, { schemas }).
   */
  private schemasByBatch = new Map<string, Map<string, z.ZodTypeAny>>();

  /** Request counts keyed by batchId, populated at submit() time. */
  private requestCountsByBatch = new Map<string, number>();

  constructor(
    private ctx: AIHelperContext,
    private modelKey: ModelKey,
    private provider: AIBatchProvider,
    private batchLogFn?: BatchLogFn,
  ) {
    // Create a logger adapter for batch providers
    // Uses provided log function (for persistence) or falls back to console
    const batchLogger: BatchLogger = {
      log: (
        level: "DEBUG" | "INFO" | "WARN" | "ERROR",
        message: string,
        meta?: Record<string, unknown>,
      ) => {
        if (this.batchLogFn) {
          this.batchLogFn(level, `[Batch:${provider}] ${message}`, meta);
        } else {
          logger.debug(
            `[Batch:${provider}] [${level}] ${message}`,
            meta ? JSON.stringify(meta) : "",
          );
        }
      },
    };

    // Resolve the concrete provider once; submit/getStatus/getResults all
    // dispatch through this single field instead of three nullable ones.
    switch (provider) {
      case "google":
        this.batchProvider = new GoogleBatchProvider({}, batchLogger);
        break;
      case "anthropic":
        this.batchProvider = new AnthropicBatchProvider({}, batchLogger);
        break;
      case "openai":
        this.batchProvider = new OpenAIBatchProvider({}, batchLogger);
        break;
      default:
        throw new Error(`Unsupported batch provider "${provider}".`);
    }
  }

  async submit(requests: AIBatchRequest[]): Promise<AIBatchHandle> {
    // Trace log before batch submission
    logger.debug(`batch submit request`, {
      provider: this.provider,
      model: this.modelKey,
      requestCount: requests.length,
      requestIds: requests.slice(0, 10).map((r) => r.id),
      hasMoreRequests: requests.length > 10,
    });

    // Register schemas for later validation in getResults(), keyed by the
    // request id supplied by the caller (not the batchId, which we don't
    // have yet).
    const schemasById = new Map<string, z.ZodTypeAny>();
    for (const req of requests) {
      if (req.schema) schemasById.set(req.id, req.schema);
    }

    let handle: BatchHandle;
    if (this.provider === "google") {
      // Google gets native structured output (responseMimeType +
      // responseJsonSchema in google-batch.ts), so we just pass the schema
      // through rather than synthesizing prompt text for it.
      const googleRequests = requests.map((req) => ({
        id: req.id,
        prompt: req.prompt,
        model: this.modelKey,
        ...(req.schema && { schema: req.schema }),
      }));
      handle = await this.batchProvider.submit(googleRequests);
    } else {
      // Anthropic and OpenAI both lack native batch structured-output, so
      // the schema is synthesized into a system prompt for either.
      const genericRequests = requests.map((req) => ({
        customId: req.id,
        prompt: req.prompt,
        model: this.modelKey,
        ...(req.schema && {
          system: buildJsonSchemaSystemPrompt(req.schema),
        }),
      }));
      handle = await this.batchProvider.submit(genericRequests);
    }

    this.schemasByBatch.set(handle.id, schemasById);
    this.requestCountsByBatch.set(handle.id, requests.length);
    logger.debug(`batch submitted`, {
      provider: this.provider,
      batchId: handle.id,
      requestCount: requests.length,
    });
    return { id: handle.id, status: "pending", provider: this.provider };
  }

  async getStatus(batchId: string): Promise<AIBatchHandle> {
    const handle: BatchHandle = {
      id: batchId,
      provider: this.provider,
      requestCount: this.requestCountsByBatch.get(batchId) ?? 0,
      createdAt: new Date(),
    };
    const status = await this.batchProvider.checkStatus(handle);

    let batchStatus: "pending" | "processing" | "completed" | "failed";
    switch (status.state) {
      case "completed":
        batchStatus = "completed";
        break;
      case "failed":
        batchStatus = "failed";
        break;
      case "processing":
        batchStatus = "processing";
        break;
      default:
        batchStatus = "pending";
    }

    return { id: batchId, status: batchStatus, provider: this.provider };
  }

  async getResults(
    batchId: string,
    metadata?: Record<string, unknown>,
  ): Promise<AIBatchResult<T>[]> {
    // Debug: Log received metadata to trace customIds flow
    if (this.batchLogFn) {
      this.batchLogFn("DEBUG", `[AIBatch:getResults] Received metadata`, {
        hasMetadata: !!metadata,
        metadataKeys: metadata ? Object.keys(metadata) : [],
        hasCustomIds: !!metadata?.customIds,
        customIdsCount: Array.isArray(metadata?.customIds)
          ? metadata.customIds.length
          : 0,
      });
    }

    const handle: BatchHandle = {
      id: batchId,
      provider: this.provider,
      requestCount: this.requestCountsByBatch.get(batchId) ?? 0,
      createdAt: new Date(),
      metadata,
    };
    const rawResults = await this.batchProvider.getResults(handle);

    // Trace log after results retrieved
    const totalInputTokens = rawResults.reduce(
      (sum, r) => sum + (r.inputTokens || 0),
      0,
    );
    const totalOutputTokens = rawResults.reduce(
      (sum, r) => sum + (r.outputTokens || 0),
      0,
    );
    const failedCount = rawResults.filter((r) => r.error).length;
    logger.debug(`batch getResults response`, {
      batchId,
      provider: this.provider,
      resultCount: rawResults.length,
      failedCount,
      totalInputTokens,
      totalOutputTokens,
    });

    // Schemas for validation: prefer ones re-supplied explicitly via
    // metadata.schemas (works across a suspend/resume, since the caller is
    // responsible for keeping hold of the Zod schema object), falling back
    // to the in-process map populated at submit() time.
    const suppliedSchemas = metadata?.schemas as
      | Record<string, z.ZodTypeAny>
      | undefined;
    const inProcessSchemas = this.schemasByBatch.get(batchId);

    // Transform RawBatchResult to AIBatchResult<T>
    const results: AIBatchResult<T>[] = rawResults.map((raw, index) => {
      const id = raw.customId || `result-${index}`;
      const inputTokens = raw.inputTokens || 0;
      const outputTokens = raw.outputTokens || 0;

      // Check if this request failed at the provider level
      if (raw.error) {
        return {
          id,
          prompt: "", // Not available from raw results
          inputTokens,
          outputTokens,
          status: "failed" as const,
          error: raw.error,
        };
      }

      // Try to parse JSON if the result looks like JSON
      let parsedJson: unknown;
      let parseError: string | undefined;
      try {
        // Clean markdown code blocks before parsing
        let cleaned = raw.text.trim();
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

      const schema = suppliedSchemas?.[id] ?? inProcessSchemas?.get(id);

      if (schema) {
        // A schema was supplied for this request - validate against it
        // instead of blindly trusting the model's output.
        if (parseError) {
          return {
            id,
            prompt: "",
            inputTokens,
            outputTokens,
            status: "failed" as const,
            error: `Failed to parse JSON response for schema validation: ${parseError}`,
          };
        }

        const validation = schema.safeParse(parsedJson);
        if (!validation.success) {
          return {
            id,
            prompt: "",
            inputTokens,
            outputTokens,
            status: "failed" as const,
            error: `Response did not match the request's schema: ${validation.error.message}`,
          };
        }

        return {
          id,
          prompt: "",
          result: validation.data as T,
          inputTokens,
          outputTokens,
          status: "succeeded" as const,
        };
      }

      // No schema to validate against - fall back to best-effort parsing,
      // same as before, but only for a genuinely successful response.
      const result = (parseError === undefined ? parsedJson : raw.text) as T;

      return {
        id,
        prompt: "", // Not available from raw results
        result,
        inputTokens,
        outputTokens,
        status: "succeeded" as const,
      };
    });

    // Auto-record results
    await this.recordResults(batchId, results);

    return results;
  }

  async isRecorded(batchId: string): Promise<boolean> {
    return this.ctx.aiCallLogger.isRecorded(batchId);
  }

  /**
   * Record batch results manually.
   * Use this when batch provider integration is not yet implemented.
   */
  async recordResults(
    batchId: string,
    results: AIBatchResult<T>[],
  ): Promise<void> {
    // Check if already recorded
    if (await this.isRecorded(batchId)) {
      logger.debug(`Batch ${batchId} already recorded, skipping.`);
      return;
    }

    const modelConfig = getModel(this.modelKey);
    const discountPercent = modelConfig.batchDiscountPercent ?? 0;

    // Record all results via logger
    await this.ctx.aiCallLogger.logBatchResults(
      batchId,
      results.map((r) => {
        const baseCost = calculateCost(
          this.modelKey,
          r.inputTokens,
          r.outputTokens,
        );
        const cost = baseCost.totalCost * (1 - discountPercent / 100);

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
              ? { batchId, requestId: r.id, status: "failed", error: r.error }
              : { batchId, requestId: r.id },
        };
      }),
    );
  }
}
