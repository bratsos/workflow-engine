/**
 * Google Batch Provider
 *
 * Implements batch processing using Google's GenAI Batch API.
 * Uses inline requests for simpler API.
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type InlinedRequest,
  JobState,
} from "@google/genai";
import { jsonSchema } from "ai";
import { resolveModelForProvider } from "../model-mapping";
import type {
  BatchHandle,
  BatchLogger,
  BatchProvider,
  BatchState,
  BatchStatus,
  BatchSubmitOptions,
  GoogleBatchRequest,
  RawBatchResult,
} from "../types";

export interface GoogleBatchProviderConfig {
  apiKey?: string;
}

export class GoogleBatchProvider
  implements BatchProvider<GoogleBatchRequest, RawBatchResult>
{
  readonly name = "google";
  readonly supportsBatching = true;

  private ai: GoogleGenAI;
  private logger?: BatchLogger;

  constructor(config: GoogleBatchProviderConfig = {}, logger?: BatchLogger) {
    const apiKey = config.apiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Google API key is required. Set GOOGLE_GENERATIVE_AI_API_KEY or pass apiKey in config.",
      );
    }
    this.ai = new GoogleGenAI({ apiKey });
    this.logger = logger;
  }

  async submit(
    requests: GoogleBatchRequest[],
    options?: BatchSubmitOptions,
  ): Promise<BatchHandle> {
    if (requests.length === 0) {
      throw new Error("Cannot submit empty batch");
    }

    // Convert ModelKey to Google-specific model ID
    const modelKey = requests[0]?.model;
    const model = resolveModelForProvider(modelKey, "google");

    // Extract customIds from requests to store in handle metadata
    const customIds = requests.map(
      (req, idx) => (req as { id?: string }).id || `request-${idx}`,
    );

    this.logger?.log("INFO", "Submitting Google batch", {
      requestCount: requests.length,
      modelKey: modelKey || "default",
      model,
    });

    // Transform requests into Google's inline format
    const inlinedRequests: InlinedRequest[] = requests.map((req) => {
      const parts: Array<{ text: string }> = [{ text: req.prompt }];

      if (req.schema) {
        // Use schema description since toJSONSchema may not be available in all Zod versions
        parts.push({
          text: `Please respond with a JSON object matching the expected schema structure.`,
        });
      }

      if (req.maxTokens) {
        parts.push({
          text: `Limit your response to a maximum of ${req.maxTokens} tokens.`,
        });
      }

      if (req.temperature !== undefined) {
        parts.push({
          text: `Use a temperature setting of ${req.temperature} for this response.`,
        });
      }

      // Get customId from request (via id field passed from ai-helper)
      const customId =
        (req as { id?: string }).id || `request-${requests.indexOf(req)}`;

      // Build the response object with metadata for ID tracking
      const response: Record<string, unknown> = {
        contents: [
          {
            role: "user",
            parts,
          },
        ],
        // Store customId in metadata - Google SDK supports this
        metadata: { customId },
      };

      // Add tools configuration if provided
      if (req.tools && Object.keys(req.tools).length > 0) {
        const config: Record<string, unknown> = {
          tools: [
            {
              functionDeclarations: Object.entries(req.tools).map(
                ([name, tool]) => ({
                  name,
                  description: tool.description,
                  // AI SDK uses inputSchema, convert to JSON Schema for Google
                  parameters: tool.inputSchema
                    ? jsonSchema(tool.inputSchema)
                    : undefined,
                }),
              ),
            },
          ],
        };

        // Map toolChoice if provided
        if (req.toolChoice) {
          if (req.toolChoice === "required") {
            config.toolConfig = {
              functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
            };
          } else if (req.toolChoice === "none") {
            config.toolConfig = {
              functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
            };
          } else if (
            typeof req.toolChoice === "object" &&
            req.toolChoice.type === "tool"
          ) {
            config.toolConfig = {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.ANY,
                allowedFunctionNames: [req.toolChoice.toolName],
              },
            };
          }
          // 'auto' is the default, no config needed
        }

        response.config = config;
      }

      return response as InlinedRequest;
    });

    const batchJob = await this.ai.batches.create({
      model,
      src: { inlinedRequests },
      config: {
        displayName:
          options?.displayName || `batch-${Date.now()}-${requests.length}`,
      },
    });

    if (!batchJob.name) {
      throw new Error("Batch job created but no name returned");
    }

    this.logger?.log("INFO", "Google batch submitted", {
      batchName: batchJob.name,
      requestCount: requests.length,
    });

    return {
      id: batchJob.name,
      provider: this.name,
      requestCount: requests.length,
      createdAt: new Date(),
      metadata: {
        model,
        displayName: options?.displayName,
        customIds, // Store for getResults to use
      },
    };
  }

  async checkStatus(handle: BatchHandle): Promise<BatchStatus> {
    const batch = await this.ai.batches.get({ name: handle.id });

    const status: BatchStatus = {
      state: this.mapState(batch.state),
      processedCount: Number(batch.completionStats?.successfulCount) || 0,
      totalCount: handle.requestCount,
      succeededCount: batch.completionStats?.successfulCount
        ? Number(batch.completionStats.successfulCount)
        : undefined,
      failedCount: batch.completionStats?.failedCount
        ? Number(batch.completionStats.failedCount)
        : undefined,
      error: (batch as Record<string, unknown>).error
        ? String((batch as Record<string, unknown>).error)
        : undefined,
    };

    // When batch is complete or failed, aggregate token counts from all responses
    // This ensures we capture usage even if getResults fails later
    if (
      batch.state === JobState.JOB_STATE_SUCCEEDED ||
      batch.state === JobState.JOB_STATE_FAILED
    ) {
      const inlinedResponses = batch.dest?.inlinedResponses;
      if (inlinedResponses && Array.isArray(inlinedResponses)) {
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        for (const inlinedResponse of inlinedResponses) {
          const usageMetadata = inlinedResponse.response?.usageMetadata;
          if (usageMetadata) {
            totalInputTokens += usageMetadata.promptTokenCount ?? 0;
            totalOutputTokens += usageMetadata.candidatesTokenCount ?? 0;
          }
        }

        status.totalInputTokens = totalInputTokens;
        status.totalOutputTokens = totalOutputTokens;

        this.logger?.log("INFO", "Google batch token usage", {
          batchId: handle.id,
          totalInputTokens,
          totalOutputTokens,
          responseCount: inlinedResponses.length,
        });
      }
    }

    this.logger?.log("DEBUG", "sdk response", { batch });

    this.logger?.log("DEBUG", "Google batch status", {
      batchId: handle.id,
      state: status.state,
      processed: status.processedCount,
      total: status.totalCount,
      startTime: batch.startTime,
      endTime: batch.endTime,
      totalInputTokens: status.totalInputTokens,
      totalOutputTokens: status.totalOutputTokens,
    });

    return status;
  }

  async getResults(
    handle: BatchHandle,
    customIds?: string[],
  ): Promise<RawBatchResult[]> {
    // Get customIds from: 1) parameter, 2) handle.metadata.customIds, 3) fallback to index-based
    const requestIds =
      customIds || (handle.metadata?.customIds as string[] | undefined);

    this.logger?.log("DEBUG", "Google batch getResults - customIds lookup", {
      batchId: handle.id,
      hasCustomIdsParam: !!customIds,
      hasHandleMetadata: !!handle.metadata,
      hasMetadataCustomIds: !!handle.metadata?.customIds,
      requestIdsFound: requestIds?.length ?? 0,
    });

    const batch = await this.ai.batches.get({ name: handle.id });

    if (
      batch.state !== JobState.JOB_STATE_SUCCEEDED &&
      batch.state !== JobState.JOB_STATE_FAILED
    ) {
      throw new Error(`Batch not complete: state=${batch.state}`);
    }

    if (batch.state === JobState.JOB_STATE_FAILED) {
      const errorMsg =
        (batch as Record<string, unknown>).error || "Unknown error";
      throw new Error(`Batch failed: ${errorMsg}`);
    }

    const maybeInlinedResponses = batch.dest?.inlinedResponses;
    if (!maybeInlinedResponses) {
      throw new Error(
        "Batch response format unexpected - could not find inlinedResponses array",
      );
    }

    if (!maybeInlinedResponses || !Array.isArray(maybeInlinedResponses)) {
      this.logger?.log("ERROR", "Unexpected batch response format", {
        batchId: handle.id,
        hasResponse: !!maybeInlinedResponses,
        destKeys: batch.dest ? Object.keys(batch.dest) : [],
      });
      throw new Error(
        "Batch response format unexpected - could not find inlinedResponses array",
      );
    }

    this.logger?.log("INFO", "Processing Google batch results", {
      batchId: handle.id,
      responseCount: maybeInlinedResponses.length,
      firstItem: JSON.stringify(maybeInlinedResponses[0]), // Log entire first item structure to be sure
    });

    return maybeInlinedResponses.map((inlinedResponse, index) => {
      try {
        // Try to get customId from response metadata first, fall back to stored requestIds, then index-based
        const responseMetadata = (
          inlinedResponse as { metadata?: Record<string, string> }
        ).metadata;
        const customId =
          responseMetadata?.customId ||
          requestIds?.[index] ||
          `request-${index}`;

        if (!requestIds?.[index] && !responseMetadata?.customId) {
          this.logger?.log(
            "WARN",
            `No customId found for index ${index}, using fallback`,
            { index },
          );
        }

        if (inlinedResponse.error) {
          const result = {
            index,
            customId,
            text: "",
            inputTokens: 0,
            outputTokens: 0,
            error: inlinedResponse.error.message || "Unknown error",
          };
          this.logger?.log("DEBUG", `Response ${index} has error`, {
            customId,
            error: result.error,
          });
          return result;
        }

        const response = inlinedResponse.response;
        if (!response) {
          const result = {
            index,
            text: "",
            inputTokens: 0,
            outputTokens: 0,
            error: "InlinedResponse missing response field",
          };
          this.logger?.log(
            "DEBUG",
            `Response ${index} missing response field`,
            { customId },
          );
          return result;
        }

        const text =
          response.text ||
          response.candidates?.[0]?.content?.parts?.[0]?.text ||
          "";
        const usageMetadata = response.usageMetadata;

        const result = {
          index,
          customId, // Use the already-resolved customId from above
          text,
          inputTokens: usageMetadata?.promptTokenCount ?? 0,
          outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
        };
        this.logger?.log("DEBUG", `Response ${index} parsed successfully`, {
          customId,
          textLength: text.length,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
        return result;
      } catch (error) {
        const result = {
          index,
          text: "",
          inputTokens: 0,
          outputTokens: 0,
          error: error instanceof Error ? error.message : String(error),
        };
        this.logger?.log("ERROR", `Response ${index} threw exception`, {
          error: result.error,
        });
        return result;
      }
    });
  }

  async cancel(handle: BatchHandle): Promise<void> {
    // Google's batch API supports cancellation via delete
    try {
      await this.ai.batches.delete({ name: handle.id });
      this.logger?.log("INFO", "Google batch cancelled", {
        batchId: handle.id,
      });
    } catch (error) {
      this.logger?.log("WARN", "Failed to cancel Google batch", {
        batchId: handle.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private mapState(state?: JobState): BatchState {
    switch (state) {
      case JobState.JOB_STATE_SUCCEEDED:
        return "completed";
      case JobState.JOB_STATE_FAILED:
        return "failed";
      case JobState.JOB_STATE_CANCELLED:
        return "cancelled";
      case JobState.JOB_STATE_PENDING:
        return "pending";
      case JobState.JOB_STATE_RUNNING:
        return "processing";
      default:
        return "processing";
    }
  }
}
