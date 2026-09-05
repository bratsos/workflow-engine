import { z } from "zod";
import { toPortableJsonSchema } from "../schema-portability";
import {
  type EngineBatchItemResult,
  type EngineBatchModel,
  type EngineBatchRef,
  type EngineBatchRequest,
  type EngineBatchStartOptions,
  type EngineBatchStatus,
  toJsonSchema,
} from "./model";

export interface OpenRouterBatchConfig {
  /** REQUIRED and injected. Never read process.env in this module. */
  apiKey: string;
  modelId: string;
  baseURL?: string; // default "https://openrouter.ai/api/beta"
  fetch?: typeof globalThis.fetch; // default globalThis.fetch
  headers?: Record<string, string>;
  endpoint?:
    | "/v1/chat/completions"
    | "/v1/responses"
    | "/v1/messages"
    | "/v1/embeddings"; // default "/v1/chat/completions"
}

const OpenRouterBatchResultItemSchema = z.object({
  custom_id: z.string(),
  response: z
    .object({
      status_code: z.number().nullish(),
      request_id: z.string().nullish(),
      body: z.record(z.string(), z.unknown()).nullish(),
    })
    .nullish(),
  error: z
    .union([
      z.object({
        message: z.string().nullish(),
        code: z.union([z.string(), z.number()]).nullish(),
      }),
      z.string(),
    ])
    .nullish(),
});

const OpenRouterBatchResponseSchema = z.object({
  id: z.string().min(1, "Batch id must be a non-empty string"),
  status: z.string().min(1, "Batch status must be a non-empty string"),
  created_at: z.union([z.number(), z.string()]).nullish(),
  request_counts: z
    .object({
      total: z.number().nullish(),
      completed: z.number().nullish(),
      failed: z.number().nullish(),
      pending: z.number().nullish(),
    })
    .nullish(),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
      cost: z.number().nullish(),
      is_byok: z.boolean().nullish(),
    })
    .nullish(),
  results: z.array(OpenRouterBatchResultItemSchema).nullable().optional(),
  error: z
    .union([
      z.object({
        message: z.string().nullish(),
        code: z.union([z.string(), z.number()]).nullish(),
      }),
      z.string(),
    ])
    .nullable()
    .optional(),
});

type OpenRouterBatchResponse = z.infer<typeof OpenRouterBatchResponseSchema>;

async function parseOpenRouterResponse(
  res: Response,
  site: "creation" | "status check" | "results fetch",
): Promise<OpenRouterBatchResponse> {
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new Error(
      `OpenRouter batch ${site} failed to read response body (${res.url}, HTTP ${res.status}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const bodyExcerpt = text.length > 200 ? `${text.slice(0, 200)}...` : text;

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Non-JSON response received for OpenRouter batch ${site} (${res.url}, HTTP ${res.status}): ${bodyExcerpt}`,
    );
  }

  const parsed = OpenRouterBatchResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `OpenRouter batch ${site} returned an invalid batch object (HTTP ${res.status}): ` +
        `${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}. ` +
        `Body: ${bodyExcerpt}`,
    );
  }

  return parsed.data;
}

function mapOpenRouterStatus(status: string): EngineBatchStatus["status"] {
  switch (status) {
    case "validating":
      return "pending";
    case "in_progress":
    case "finalizing":
      return "processing";
    case "completed":
      return "completed";
    case "failed":
    case "expired":
    case "cancelling":
    case "cancelled":
      return "failed";
    default:
      return "failed";
  }
}

function extractOpenRouterError(
  data: OpenRouterBatchResponse,
): string | undefined {
  const explicitError =
    typeof data.error === "string" ? data.error : data.error?.message;
  if (explicitError) {
    return explicitError;
  }

  const knownStatuses = [
    "validating",
    "in_progress",
    "finalizing",
    "completed",
    "failed",
    "expired",
    "cancelling",
    "cancelled",
  ];

  if (!knownStatuses.includes(data.status)) {
    return `Unrecognized OpenRouter batch status "${data.status}".`;
  }

  const mapped = mapOpenRouterStatus(data.status);
  if (mapped === "failed") {
    return `Batch ended in terminal state "${data.status}" without a provider error message. OpenRouter returns results: null for in-progress/failed/expired/cancelled batches and no partial results are recoverable on this transport.`;
  }

  return undefined;
}

async function fetchGetWithRetry(
  fetchFn: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  abortSignal?: AbortSignal,
  maxRetries = 3,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error("Batch request aborted");
    }
    const res = await fetchFn(url, {
      method: "GET",
      headers,
      signal: abortSignal,
    });
    if (res.status === 429 && attempt < maxRetries) {
      attempt++;
      const retryAfterHeader = res.headers.get("Retry-After");
      let delayMs = 500 * 2 ** (attempt - 1);
      if (retryAfterHeader) {
        const parsedSeconds = Number.parseFloat(retryAfterHeader);
        if (!Number.isNaN(parsedSeconds)) {
          if (parsedSeconds > 60) {
            throw Object.assign(
              new Error(
                `OpenRouter rate limit Retry-After (${parsedSeconds}s) exceeds 60s ceiling for GET ${url}`,
              ),
              { retryable: true, retryAfterSeconds: parsedSeconds },
            );
          }
          delayMs = Math.max(0, Math.min(60000, parsedSeconds * 1000));
        }
      }
      if (abortSignal?.aborted) {
        throw new Error("Batch request aborted");
      }
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          reject(new Error("Batch request aborted"));
        };

        if (abortSignal) {
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }

        timer = setTimeout(() => {
          if (abortSignal) {
            abortSignal.removeEventListener("abort", onAbort);
          }
          resolve();
        }, delayMs);
      });
      continue;
    }
    return res;
  }
}

/**
 * Creates an EngineBatchModel communicating directly with the OpenRouter Batch API.
 */
export function createOpenRouterBatchModel(
  cfg: OpenRouterBatchConfig,
): EngineBatchModel {
  const baseURL = (cfg.baseURL ?? "https://openrouter.ai/api/beta").replace(
    /\/+$/,
    "",
  );
  const fetchFn = cfg.fetch ?? globalThis.fetch;
  const endpoint = cfg.endpoint ?? "/v1/chat/completions";

  // Note: The model id uses cfg.modelId verbatim (e.g. "openai/gpt-4o"), NOT the ":batch" variant.
  // This is unverified against a live key and is the documented example behavior.
  const modelId = cfg.modelId;

  return {
    provider: "openrouter",
    modelId: cfg.modelId,
    // The beta batch body takes only `endpoint`, `model` and `requests` --
    // no metadata field the engine could stamp and search -- and there is no
    // documented idempotency header. A crashed submit is therefore not
    // recoverable here; `AIBatchImpl` refuses to re-create rather than pay
    // for a second batch nobody reads.
    recovery: "none" as const,

    async start(
      requests: EngineBatchRequest[],
      opts?: EngineBatchStartOptions,
    ): Promise<EngineBatchRef & EngineBatchStatus> {
      const items = requests.map((req) => {
        const body: Record<string, unknown> = {
          messages: req.system
            ? [
                { role: "system", content: req.system },
                { role: "user", content: req.prompt },
              ]
            : [{ role: "user", content: req.prompt }],
        };
        if (req.maxOutputTokens !== undefined) {
          body.max_tokens = req.maxOutputTokens;
        }
        if (req.temperature !== undefined) {
          body.temperature = req.temperature;
        }
        if (req.schema !== undefined) {
          // Strict structured outputs (OpenAI's rules, which OpenRouter
          // forwards) reject `oneOf`; see schema-portability.ts.
          body.response_format = {
            type: "json_schema",
            json_schema: {
              name: "response",
              strict: true,
              schema: toPortableJsonSchema(toJsonSchema(req.schema), "openai"),
            },
          };
        }
        return {
          custom_id: req.id,
          body,
        };
      });

      // LOAD-BEARING: OpenRouter stream-parses the body and returns 400 if `requests`
      // appears before `endpoint` and `model`. Must build string directly.
      const payload =
        '{"endpoint":' +
        JSON.stringify(endpoint) +
        ',"model":' +
        JSON.stringify(modelId) +
        ',"requests":' +
        JSON.stringify(items) +
        "}";

      // NEVER auto-retry the POST. There is no idempotency key; a retry after a network timeout
      // would create and bill a second batch. Retry only GETs, and honor Retry-After when present.
      const res = await fetchFn(`${baseURL}/batches`, {
        method: "POST",
        headers: {
          ...cfg.headers,
          ...opts?.headers,
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: opts?.abortSignal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const excerpt =
          errText.length > 200 ? `${errText.slice(0, 200)}...` : errText;
        const hint = /does not have a :batch endpoint/.test(errText)
          ? ` OpenRouter's Batch API only serves models with a live ":batch" endpoint (the catalog row alone is not enough); pick a model that has one or batch through the vendor transport (ai.batch(modelKey, "<vendor>")).`
          : "";
        throw new Error(
          `OpenRouter batch creation failed (HTTP ${res.status}): ${excerpt}${hint}`,
        );
      }

      const data = await parseOpenRouterResponse(res, "creation");
      const ref: EngineBatchRef = {
        version: 1,
        type: "text",
        id: data.id,
        provider: "openrouter",
        modelId: cfg.modelId,
      };

      const total = data.request_counts?.total ?? requests.length;
      const completed = data.request_counts?.completed ?? 0;
      const failed = data.request_counts?.failed ?? 0;
      const pending =
        data.request_counts?.pending ?? Math.max(0, total - completed - failed);

      const errorMessage = extractOpenRouterError(data);

      return {
        ...ref,
        status: mapOpenRouterStatus(data.status),
        rawStatus: data.status,
        requestCounts: data.request_counts
          ? { total, pending, completed, failed }
          : undefined,
        error: errorMessage,
      };
    },

    async status(
      ref: EngineBatchRef,
      opts?: {
        abortSignal?: AbortSignal;
        headers?: Record<string, string>;
      },
    ): Promise<EngineBatchStatus> {
      const res = await fetchGetWithRetry(
        fetchFn,
        `${baseURL}/batches/${encodeURIComponent(ref.id)}`,
        {
          ...cfg.headers,
          ...opts?.headers,
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        opts?.abortSignal,
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const excerpt =
          errText.length > 200 ? `${errText.slice(0, 200)}...` : errText;
        throw new Error(
          `OpenRouter batch status check failed (HTTP ${res.status}): ${excerpt}`,
        );
      }

      const data = await parseOpenRouterResponse(res, "status check");
      const counts = data.request_counts;
      // Never synthesize `total: 0` from a counts object that lacks a total:
      // a caller that merges this handle into persisted metadata would then
      // carry totalRequests = 0, which reads as "empty batch" downstream.
      const requestCounts =
        counts && typeof counts.total === "number"
          ? {
              total: counts.total,
              completed: counts.completed ?? 0,
              failed: counts.failed ?? 0,
              pending:
                counts.pending ??
                Math.max(
                  0,
                  counts.total - (counts.completed ?? 0) - (counts.failed ?? 0),
                ),
            }
          : undefined;

      const errorMessage = extractOpenRouterError(data);

      return {
        status: mapOpenRouterStatus(data.status),
        rawStatus: data.status,
        requestCounts,
        error: errorMessage,
      };
    },

    async *results(
      ref: EngineBatchRef,
      opts?: {
        abortSignal?: AbortSignal;
        headers?: Record<string, string>;
      },
    ): AsyncIterable<EngineBatchItemResult> {
      const res = await fetchGetWithRetry(
        fetchFn,
        `${baseURL}/batches/${encodeURIComponent(ref.id)}`,
        {
          ...cfg.headers,
          ...opts?.headers,
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        opts?.abortSignal,
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const excerpt =
          errText.length > 200 ? `${errText.slice(0, 200)}...` : errText;
        throw new Error(
          `OpenRouter batch results fetch failed (HTTP ${res.status}): ${excerpt}`,
        );
      }

      const data = await parseOpenRouterResponse(res, "results fetch");

      if (data.status !== "completed") {
        throw new Error(
          `Batch ${ref.id} is not completed (status: ${data.status}). ` +
            `OpenRouter returns results: null for in-progress/failed/expired/cancelled batches and no partial results are recoverable on this transport.`,
        );
      }

      if (!data.results) {
        throw new Error(
          `Batch ${ref.id} has status "completed" but returned null or missing results.`,
        );
      }

      for (const item of data.results) {
        const customId = item.custom_id;
        if (item.error) {
          const errorMsg =
            typeof item.error === "string"
              ? item.error
              : (item.error.message ?? "Unknown batch item error");
          yield {
            id: customId,
            status: "failed",
            error: errorMsg,
            inputTokens: 0,
            outputTokens: 0,
          };
          continue;
        }

        const response = item.response;
        if (response) {
          const statusCode = response.status_code ?? 200;
          if (statusCode >= 200 && statusCode < 300) {
            const body = response.body as Record<string, any> | undefined;
            let text = "";
            const choice = body?.choices?.[0];
            if (choice?.message?.content !== undefined) {
              const content = choice.message.content;
              text =
                typeof content === "string"
                  ? content
                  : Array.isArray(content)
                    ? content
                        .filter(
                          (c: any) =>
                            c?.type === "text" || typeof c?.text === "string",
                        )
                        .map((c: any) => c.text ?? "")
                        .join("")
                    : "";
            }
            const usage = body?.usage;
            const inputTokens = usage?.prompt_tokens ?? 0;
            const outputTokens = usage?.completion_tokens ?? 0;

            yield {
              id: customId,
              status: "succeeded",
              text,
              inputTokens,
              outputTokens,
            };
          } else {
            const body = response.body as Record<string, any> | undefined;
            const errorMsg =
              body?.error?.message ??
              `OpenRouter batch item failed with status ${statusCode}`;
            yield {
              id: customId,
              status: "failed",
              error: errorMsg,
              inputTokens: 0,
              outputTokens: 0,
            };
          }
        } else {
          yield {
            id: customId,
            status: "failed",
            error: "Missing response and error in batch item result",
            inputTokens: 0,
            outputTokens: 0,
          };
        }
      }
    },
  };
}
