/**
 * OpenAI Batch Provider
 *
 * Implements batch processing using OpenAI's Batch API.
 * Note: OpenAI requires JSONL file uploads for batches.
 * Supports up to 50,000 requests per batch with 24h processing window.
 */

// Optional peer dependency
import OpenAI from "openai";
import { jsonSchema } from "ai";
import { resolveModelForProvider } from "../model-mapping";
import type {
  BatchHandle,
  BatchLogger,
  BatchProvider,
  BatchState,
  BatchStatus,
  BatchSubmitOptions,
  OpenAIBatchRequest,
  RawBatchResult,
} from "../types";

export interface OpenAIBatchProviderConfig {
  apiKey?: string;
}

export class OpenAIBatchProvider
  implements BatchProvider<OpenAIBatchRequest, RawBatchResult>
{
  readonly name = "openai";
  readonly supportsBatching = true;

  private client: OpenAI;
  private logger?: BatchLogger;

  constructor(config: OpenAIBatchProviderConfig = {}, logger?: BatchLogger) {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey in config.",
      );
    }
    this.client = new OpenAI({ apiKey });
    this.logger = logger;
  }

  async submit(
    requests: OpenAIBatchRequest[],
    options?: BatchSubmitOptions,
  ): Promise<BatchHandle> {
    if (requests.length === 0) {
      throw new Error("Cannot submit empty batch");
    }

    // Convert ModelKey to OpenAI-specific model ID
    const modelKey = requests[0]?.model;
    const model = resolveModelForProvider(modelKey, "openai");

    this.logger?.log("INFO", "Submitting OpenAI batch", {
      requestCount: requests.length,
      modelKey: modelKey || "default",
      model,
    });

    // OpenAI requires JSONL file upload for batches
    const jsonlContent = requests
      .map((req, i) => {
        // Each request can optionally override the model
        const reqModel = req.model
          ? resolveModelForProvider(req.model, "openai")
          : model;

        // Convert tools to OpenAI format if provided
        const openaiTools =
          req.tools && Object.keys(req.tools).length > 0
            ? Object.entries(req.tools).map(([name, tool]) => ({
                type: "function" as const,
                function: {
                  name,
                  description: tool.description,
                  parameters: tool.inputSchema
                    ? jsonSchema(tool.inputSchema)
                    : undefined,
                },
              }))
            : undefined;

        // Map toolChoice to OpenAI format
        let toolChoice:
          | "auto"
          | "required"
          | "none"
          | { type: "function"; function: { name: string } }
          | undefined;
        if (req.toolChoice) {
          if (req.toolChoice === "auto") {
            toolChoice = "auto";
          } else if (req.toolChoice === "required") {
            toolChoice = "required";
          } else if (req.toolChoice === "none") {
            toolChoice = "none";
          } else if (
            typeof req.toolChoice === "object" &&
            req.toolChoice.type === "tool"
          ) {
            toolChoice = {
              type: "function",
              function: { name: req.toolChoice.toolName },
            };
          }
        }

        return JSON.stringify({
          custom_id: req.customId || `request-${i}`,
          method: "POST",
          url: "/v1/chat/completions",
          body: {
            model: reqModel,
            messages: [
              ...(req.system
                ? [{ role: "system" as const, content: req.system }]
                : []),
              { role: "user" as const, content: req.prompt },
            ],
            max_tokens: req.maxTokens || 1024,
            ...(req.temperature !== undefined && {
              temperature: req.temperature,
            }),
            ...(openaiTools && { tools: openaiTools }),
            ...(toolChoice && { tool_choice: toolChoice }),
          },
        });
      })
      .join("\n");

    // Upload the JSONL file
    // OpenAI SDK expects a File object or similar
    const file = await this.client.files.create({
      file: new File([jsonlContent], "batch-requests.jsonl", {
        type: "application/jsonl",
      }),
      purpose: "batch",
    });

    this.logger?.log("DEBUG", "OpenAI batch file uploaded", {
      fileId: file.id,
      filename: file.filename,
    });

    // Create the batch
    const batch = await this.client.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/chat/completions",
      completion_window: "24h", // OpenAI only supports 24h
      metadata: options?.metadata,
    });

    this.logger?.log("INFO", "OpenAI batch submitted", {
      batchId: batch.id,
      requestCount: requests.length,
      status: batch.status,
    });

    return {
      id: batch.id,
      provider: this.name,
      requestCount: requests.length,
      createdAt: new Date(batch.created_at * 1000),
      metadata: {
        model,
        inputFileId: file.id,
        outputFileId: batch.output_file_id,
        errorFileId: batch.error_file_id,
        ...options?.metadata,
      },
    };
  }

  async checkStatus(handle: BatchHandle): Promise<BatchStatus> {
    const batch = await this.client.batches.retrieve(handle.id);

    const requestCounts = batch.request_counts;
    const completedCount = requestCounts?.completed || 0;
    const failedCount = requestCounts?.failed || 0;
    const totalCount = requestCounts?.total || handle.requestCount;

    // Don't report as completed until output file is actually available
    // This prevents race conditions where status is "completed" but file isn't ready
    let state = this.mapStatus(batch.status);
    if (state === "completed" && !batch.output_file_id) {
      this.logger?.log(
        "WARN",
        "Batch shows completed but output file not ready yet",
        {
          batchId: handle.id,
          status: batch.status,
        },
      );
      state = "processing"; // Keep polling until file is ready
    }

    const status: BatchStatus = {
      state,
      processedCount: completedCount + failedCount,
      totalCount,
      succeededCount: completedCount,
      failedCount,
      error: batch.errors?.data?.[0]?.message,
    };

    this.logger?.log("INFO", "OpenAI batch status check", {
      batchId: handle.id,
      rawStatus: batch.status,
      mappedState: status.state,
      processed: status.processedCount,
      total: status.totalCount,
      outputFileId: batch.output_file_id,
    });

    return status;
  }

  async getResults(handle: BatchHandle): Promise<RawBatchResult[]> {
    const batch = await this.client.batches.retrieve(handle.id);

    this.logger?.log("INFO", "OpenAI batch retrieve for results", {
      batchId: handle.id,
      status: batch.status,
      outputFileId: batch.output_file_id,
      errorFileId: batch.error_file_id,
    });

    if (batch.status !== "completed" && batch.status !== "failed") {
      throw new Error(`Batch not complete: status=${batch.status}`);
    }

    // Handle failed batches
    if (batch.status === "failed") {
      const errorMessage =
        batch.errors?.data?.[0]?.message || "Unknown batch error";
      throw new Error(`Batch failed: ${errorMessage}`);
    }

    if (!batch.output_file_id) {
      // This can happen in rare cases - log more details
      this.logger?.log("ERROR", "Batch completed but no output file", {
        batchId: handle.id,
        status: batch.status,
        requestCounts: batch.request_counts,
        errors: batch.errors,
      });
      throw new Error(
        `Batch output file not available. Status: ${batch.status}, Request counts: ${JSON.stringify(batch.request_counts)}`,
      );
    }

    this.logger?.log("INFO", "Retrieving OpenAI batch results", {
      batchId: handle.id,
      outputFileId: batch.output_file_id,
    });

    // Download and parse results file
    const fileContent = await this.client.files.content(batch.output_file_id);
    const text = await fileContent.text();
    const lines = text.trim().split("\n").filter(Boolean);

    const results: RawBatchResult[] = lines.map(
      (line: string, index: number) => {
        try {
          const result = JSON.parse(line);
          const response = result.response?.body;
          const choice = response?.choices?.[0];

          if (result.error) {
            return {
              index,
              customId: result.custom_id,
              text: "",
              inputTokens: 0,
              outputTokens: 0,
              error: result.error.message || "Unknown error",
            };
          }

          return {
            index,
            customId: result.custom_id,
            text: choice?.message?.content || "",
            inputTokens: response?.usage?.prompt_tokens || 0,
            outputTokens: response?.usage?.completion_tokens || 0,
          };
        } catch (error) {
          return {
            index,
            customId: undefined,
            text: "",
            inputTokens: 0,
            outputTokens: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );

    this.logger?.log("INFO", "OpenAI batch results retrieved", {
      batchId: handle.id,
      resultCount: results.length,
      successCount: results.filter((r) => !r.error).length,
      errorCount: results.filter((r) => r.error).length,
    });

    return results;
  }

  async cancel(handle: BatchHandle): Promise<void> {
    await this.client.batches.cancel(handle.id);
    this.logger?.log("INFO", "OpenAI batch cancelled", { batchId: handle.id });
  }

  private mapStatus(status: string): BatchState {
    switch (status) {
      case "completed":
        return "completed";
      case "failed":
      case "expired":
        return "failed";
      case "cancelling":
      case "cancelled":
        return "cancelled";
      case "validating":
      case "in_progress":
      case "finalizing":
        return "processing";
      default:
        return "pending";
    }
  }
}
