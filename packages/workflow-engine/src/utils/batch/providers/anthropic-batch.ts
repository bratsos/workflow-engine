/**
 * Anthropic Batch Provider
 *
 * Implements batch processing using Anthropic's Message Batches API.
 * Supports up to 10,000 requests per batch with 24h processing window.
 */

// Optional peer dependency
import { Anthropic } from "@anthropic-ai/sdk";
import { asSchema } from "ai";
import { resolveModelForProvider } from "../model-mapping";
import type {
  AnthropicBatchRequest,
  BatchHandle,
  BatchLogger,
  BatchProvider,
  BatchState,
  BatchStatus,
  BatchSubmitOptions,
  RawBatchResult,
} from "../types";
import {
  assertNonEmptyBatch,
  logBatchResultsSummary,
  resolveApiKey,
  resolveBatchModel,
  resolveCustomId,
} from "./shared";

export interface AnthropicBatchProviderConfig {
  apiKey?: string;
}

export class AnthropicBatchProvider
  implements BatchProvider<AnthropicBatchRequest, RawBatchResult>
{
  readonly name = "anthropic";
  readonly supportsBatching = true;

  private client: Anthropic;
  private logger?: BatchLogger;

  constructor(config: AnthropicBatchProviderConfig = {}, logger?: BatchLogger) {
    this.client = new Anthropic({
      apiKey: resolveApiKey(config.apiKey, "ANTHROPIC_API_KEY", "Anthropic"),
    });
    this.logger = logger;
  }

  async submit(
    requests: AnthropicBatchRequest[],
    options?: BatchSubmitOptions,
  ): Promise<BatchHandle> {
    assertNonEmptyBatch(requests);

    // Convert ModelKey to Anthropic-specific model ID
    const { modelKey, model } = resolveBatchModel(requests, "anthropic");

    this.logger?.log("INFO", "Submitting Anthropic batch", {
      requestCount: requests.length,
      modelKey: modelKey || "default",
      model,
    });

    // Transform requests into Anthropic's batch format
    const batchRequests = requests.map((req, i) => {
      // Each request can optionally override the model
      const reqModel = req.model
        ? resolveModelForProvider(req.model, "anthropic")
        : model;

      // Convert tools to Anthropic format if provided
      const anthropicTools =
        req.tools && Object.keys(req.tools).length > 0
          ? Object.entries(req.tools).map(([name, tool]) => ({
              name,
              // Batch tool defs are static (no call-time options), so a v7
              // dynamic (function) description can't be resolved here.
              description:
                typeof tool.description === "string" ? tool.description : "",
              input_schema: (tool.inputSchema
                ? asSchema(tool.inputSchema).jsonSchema
                : {
                    type: "object",
                    properties: {},
                  }) as Anthropic.Tool["input_schema"],
            }))
          : undefined;

      // Map toolChoice to Anthropic's tool_choice format
      let toolChoice: Anthropic.MessageCreateParams["tool_choice"] | undefined;
      if (req.toolChoice) {
        if (req.toolChoice === "auto") {
          toolChoice = { type: "auto" };
        } else if (req.toolChoice === "required") {
          toolChoice = { type: "any" };
        } else if (
          typeof req.toolChoice === "object" &&
          req.toolChoice.type === "tool"
        ) {
          toolChoice = { type: "tool", name: req.toolChoice.toolName };
        }
        // 'none' removes tools entirely, so we skip adding them
      }

      return {
        custom_id: resolveCustomId(req.customId, i),
        params: {
          model: reqModel,
          max_tokens: req.maxTokens || 1024,
          messages: [{ role: "user" as const, content: req.prompt }],
          ...(req.system && { system: req.system }),
          ...(req.temperature !== undefined && {
            temperature: req.temperature,
          }),
          ...(anthropicTools &&
            req.toolChoice !== "none" && { tools: anthropicTools }),
          ...(toolChoice && { tool_choice: toolChoice }),
        },
      };
    });

    const response = await this.client.messages.batches.create({
      requests: batchRequests,
    });

    this.logger?.log("INFO", "Anthropic batch submitted", {
      batchId: response.id,
      requestCount: requests.length,
      processingStatus: response.processing_status,
    });

    return {
      id: response.id,
      provider: this.name,
      requestCount: requests.length,
      createdAt: new Date(response.created_at),
      metadata: {
        model,
        processingStatus: response.processing_status,
        ...options?.metadata,
      },
    };
  }

  async checkStatus(handle: BatchHandle): Promise<BatchStatus> {
    const batch = await this.client.messages.batches.retrieve(handle.id);

    const succeededCount = batch.request_counts?.succeeded || 0;
    const erroredCount = batch.request_counts?.errored || 0;
    const canceledCount = batch.request_counts?.canceled || 0;
    const expiredCount = batch.request_counts?.expired || 0;
    const processingCount = batch.request_counts?.processing || 0;

    const processedCount =
      succeededCount + erroredCount + canceledCount + expiredCount;
    const totalCount = processedCount + processingCount;

    const status: BatchStatus = {
      state: this.mapStatus(batch.processing_status),
      processedCount,
      totalCount: totalCount || handle.requestCount,
      succeededCount,
      failedCount: erroredCount + canceledCount + expiredCount,
    };

    this.logger?.log("DEBUG", "Anthropic batch status", {
      batchId: handle.id,
      state: status.state,
      processed: status.processedCount,
      total: status.totalCount,
    });

    return status;
  }

  async getResults(handle: BatchHandle): Promise<RawBatchResult[]> {
    // First check status
    const status = await this.checkStatus(handle);
    if (status.state !== "completed" && status.state !== "failed") {
      throw new Error(`Batch not complete: state=${status.state}`);
    }

    this.logger?.log("INFO", "Retrieving Anthropic batch results", {
      batchId: handle.id,
    });

    const results: RawBatchResult[] = [];
    let index = 0;

    // Anthropic uses async iteration for results
    const resultsIterator = await this.client.messages.batches.results(
      handle.id,
    );
    for await (const entry of resultsIterator) {
      if (entry.result.type === "succeeded") {
        const message = entry.result.message;
        const textContent = message.content.find(
          (c: Anthropic.ContentBlock): c is Anthropic.TextBlock =>
            c.type === "text",
        );

        results.push({
          index,
          customId: entry.custom_id,
          text: textContent?.text || "",
          inputTokens: message.usage?.input_tokens || 0,
          outputTokens: message.usage?.output_tokens || 0,
        });
      } else {
        // Handle errored, canceled, or expired results
        let errorMsg: string;
        switch (entry.result.type) {
          case "errored": {
            // ErrorResponse has error.type and error.message at different levels
            const errBody = entry.result.error as
              | { message?: string; type?: string }
              | undefined;
            errorMsg = errBody?.message
              ? errBody.message
              : errBody?.type
                ? `Error type: ${errBody.type}`
                : "Request errored";
            break;
          }
          case "canceled":
            errorMsg = "Request was canceled";
            break;
          case "expired":
            errorMsg = "Request expired";
            break;
          default:
            errorMsg = `Unknown result type: ${(entry.result as { type: string }).type}`;
        }

        results.push({
          index,
          customId: entry.custom_id,
          text: "",
          inputTokens: 0,
          outputTokens: 0,
          error: errorMsg,
        });
      }
      index++;
    }

    logBatchResultsSummary(this.logger, "Anthropic", handle.id, results);

    return results;
  }

  async cancel(handle: BatchHandle): Promise<void> {
    await this.client.messages.batches.cancel(handle.id);
    this.logger?.log("INFO", "Anthropic batch cancelled", {
      batchId: handle.id,
    });
  }

  private mapStatus(status: string): BatchState {
    switch (status) {
      case "ended":
        return "completed";
      case "canceling":
      case "canceled":
        return "cancelled";
      case "in_progress":
        return "processing";
      default:
        return "pending";
    }
  }
}
