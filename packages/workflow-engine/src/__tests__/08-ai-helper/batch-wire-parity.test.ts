/**
 * Without a provider policy, every batch call sends the requests of
 * 1.0.0-alpha.21 (destination, credential, body) and returns its results.
 * `snapshots/batch-wire-1.0.0-alpha.21.json` holds what alpha.21 sent and
 * returned for each scenario below, recorded with this file's scenarios and
 * fake provider APIs. Only provider HTTP is faked: the helper, the transports
 * and the installed vendor SDKs are real, and a missing optional SDK is the
 * error its import raises.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAIHelper } from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

const sdk = vi.hoisted(() => ({ absent: new Set<string>() }));

vi.mock("../../ai/batch/ai-sdk.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../ai/batch/ai-sdk.js")>();
  const resolve = original.resolveAiSdkBatchModel;
  return {
    ...original,
    resolveAiSdkBatchModel: (async (vendor, ...rest) => {
      if (sdk.absent.has(vendor)) {
        throw new Error(
          `Package "@ai-sdk/${vendor}" is required to use vendor "${vendor}". Please install @ai-sdk/${vendor}.`,
        );
      }
      return resolve(vendor, ...rest);
    }) as typeof resolve,
  };
});

const models = {
  openai: "parity-openai",
  anthropic: "parity-anthropic",
  google: "parity-google",
  openrouter: "parity-openrouter",
} as const;
type Family = keyof typeof models;
type Provider = "openrouter" | "openai" | "anthropic" | "google";

registerModels(
  Object.fromEntries(
    (
      [
        ["openai", "openai/gpt-5-nano"],
        ["anthropic", "anthropic/claude-haiku-4.5"],
        ["google", "google/gemini-2.5-flash"],
        ["openrouter", "meta-llama/llama-3.3-70b-instruct"],
      ] as const
    ).map(([family, id]) => [
      models[family],
      {
        id,
        name: family,
        inputCostPerMillion: 1,
        outputCostPerMillion: 4,
        provider: "openrouter" as const,
        supportsAsyncBatch: true,
        batchModelId: `${id}:batch`,
      },
    ]),
  ),
);

const sumSchema = z.object({ sum: z.number() });
const answer = (customId: string) =>
  JSON.stringify({ sum: customId.length * 3 });

/** The JSON a request body serializes to; an upload's file as its lines. */
async function readBody(body: unknown): Promise<unknown> {
  if (body == null) return undefined;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body instanceof FormData) {
    const entries: [string, unknown][] = [];
    for (const [name, value] of body.entries()) {
      entries.push([
        name,
        typeof value === "string"
          ? value
          : (await value.text())
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
      ]);
    }
    return Object.fromEntries(entries);
  }
  if (body instanceof Blob) return readBody(await body.text());
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return readBody(new TextDecoder().decode(body as ArrayBuffer));
  }
  return String(body);
}

/**
 * OpenRouter (and an OpenRouter-compatible gateway), OpenAI, Anthropic and
 * Gemini batch APIs that complete every batch at once. A host knows only the
 * batches created there.
 */
function fakeProviders() {
  const wire: unknown[] = [];
  const batches = new Map<string, string[]>();
  const files = new Map<string, string[]>();
  let n = 0;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const missing = () => json({ error: { message: "not found" } }, 404);
  const jsonl = (lines: unknown[]) =>
    new Response(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = (await readBody(init?.body)) as any;
    // The Gemini SDK names each batch with a random suffix.
    if (/^ai-sdk-batch-\w+$/.test(body?.batch?.displayName ?? "")) {
      body.batch.displayName = "ai-sdk-batch-<random>";
    }
    wire.push({
      method,
      url: url.href,
      credential:
        headers.get("authorization") ??
        headers.get("x-api-key") ??
        headers.get("x-goog-api-key"),
      ...(body !== undefined ? { body } : {}),
    });
    const path = url.pathname;
    const at = (id: string) => `${url.host} ${id}`;

    if (url.host === "openrouter.ai" || url.host === "gateway.example.test") {
      if (method === "POST" && path === "/api/v1/batches") {
        if (!Array.isArray(body?.requests)) {
          return json({ error: { message: "invalid batch" } }, 400);
        }
        const id = `or-${++n}`;
        batches.set(
          at(id),
          body.requests.map((r: any) => r.custom_id),
        );
        return json({ id, status: "validating" }, 202);
      }
      const id = /^\/api\/v1\/batches\/([^/]+)$/.exec(path)?.[1];
      const ids = id && batches.get(at(id));
      if (method !== "GET" || !ids) return missing();
      return json({
        id,
        status: "completed",
        request_counts: {
          total: ids.length,
          completed: ids.length,
          failed: 0,
        },
        results: ids.map((customId) => ({
          custom_id: customId,
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: answer(customId) } }],
              usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.0002 },
              provider: "Fake",
            },
          },
        })),
      });
    }

    if (url.host === "api.openai.com") {
      if (method === "POST" && path === "/v1/files") {
        if (!Array.isArray(body?.file)) {
          return json({ error: { message: "invalid file" } }, 400);
        }
        const id = `file-${++n}`;
        files.set(
          at(id),
          body.file.map((line: any) => line.custom_id),
        );
        return json({ id, object: "file", purpose: "batch", bytes: 1 });
      }
      if (method === "POST" && path === "/v1/batches") {
        const ids = files.get(at(String(body?.input_file_id)));
        if (!ids) return json({ error: { message: "invalid file" } }, 400);
        const id = `batch_${++n}`;
        batches.set(at(id), ids);
        return json({
          id,
          object: "batch",
          status: "in_progress",
          input_file_id: body.input_file_id,
          metadata: body.metadata ?? null,
          created_at: 1,
        });
      }
      const [, id, action] =
        /^\/v1\/(?:batches|files)\/(?:out-)?([^/]+)(?:\/(cancel|content))?$/.exec(
          path,
        ) ?? [];
      const ids = id && batches.get(at(id));
      if (!ids) return missing();
      if (action === "content") {
        return jsonl(
          ids.map((customId) => ({
            id: `req_${customId}`,
            custom_id: customId,
            response: {
              status_code: 200,
              request_id: `r_${customId}`,
              body: {
                id: `resp_${customId}`,
                created_at: 1,
                model: "gpt-5-nano",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    id: `msg_${customId}`,
                    content: [
                      {
                        type: "output_text",
                        text: answer(customId),
                        annotations: [],
                      },
                    ],
                  },
                ],
                usage: { input_tokens: 3, output_tokens: 2 },
              },
            },
            error: null,
          })),
        );
      }
      return json({
        id,
        object: "batch",
        status: action === "cancel" ? "cancelling" : "completed",
        output_file_id: `out-${id}`,
        request_counts: {
          total: ids.length,
          completed: ids.length,
          failed: 0,
        },
        created_at: 1,
      });
    }

    if (url.host === "api.anthropic.com") {
      if (method === "POST" && path === "/v1/messages/batches") {
        if (!Array.isArray(body?.requests)) {
          return json({ error: { message: "invalid batch" } }, 400);
        }
        const id = `msgbatch_${++n}`;
        batches.set(
          at(id),
          body.requests.map((r: any) => r.custom_id),
        );
        return json({
          id,
          type: "message_batch",
          processing_status: "in_progress",
          request_counts: {
            processing: body.requests.length,
            succeeded: 0,
            errored: 0,
            canceled: 0,
            expired: 0,
          },
          created_at: "2026-01-01T00:00:00Z",
          expires_at: "2026-01-02T00:00:00Z",
        });
      }
      const [, id, action] =
        /^\/v1\/messages\/batches\/([^/]+)(?:\/(cancel|results))?$/.exec(
          path,
        ) ?? [];
      const ids = id && batches.get(at(id));
      if (!ids) return missing();
      if (action === "results") {
        return jsonl(
          ids.map((customId) => ({
            custom_id: customId,
            result: {
              type: "succeeded",
              message: {
                id: `msg_${customId}`,
                type: "message",
                role: "assistant",
                model: "claude-haiku-4-5",
                content: [{ type: "text", text: answer(customId) }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 3, output_tokens: 2 },
              },
            },
          })),
        );
      }
      return json({
        id,
        type: "message_batch",
        processing_status: action === "cancel" ? "canceling" : "ended",
        request_counts: {
          processing: 0,
          succeeded: ids.length,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
        created_at: "2026-01-01T00:00:00Z",
        expires_at: "2026-01-02T00:00:00Z",
        ...(action === "cancel"
          ? { cancel_initiated_at: "2026-01-01T00:01:00Z" }
          : {
              ended_at: "2026-01-01T00:02:00Z",
              results_url: `https://api.anthropic.com/v1/messages/batches/${id}/results`,
            }),
      });
    }

    if (url.host === "generativelanguage.googleapis.com") {
      if (method === "POST" && path.endsWith(":batchGenerateContent")) {
        const requests = body?.batch?.inputConfig?.requests?.requests;
        if (!Array.isArray(requests)) {
          return json({ error: { message: "invalid batch" } }, 400);
        }
        const name = `batches/g${++n}`;
        batches.set(
          at(name),
          requests.map((r: any) => r.metadata.key),
        );
        return json({
          name,
          metadata: { state: "JOB_STATE_PENDING" },
          done: false,
        });
      }
      const [, name, action] =
        /^\/v1beta\/(batches\/[^/:]+)(?::(cancel))?$/.exec(path) ?? [];
      const ids = name && batches.get(at(name));
      if (!ids) return missing();
      if (action === "cancel") return json({});
      return json({
        name,
        metadata: { state: "JOB_STATE_SUCCEEDED" },
        done: true,
        response: {
          inlinedResponses: {
            inlinedResponses: ids.map((key) => ({
              metadata: { key },
              response: {
                candidates: [
                  {
                    content: { role: "model", parts: [{ text: answer(key) }] },
                    finishReason: "STOP",
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 3,
                  candidatesTokenCount: 2,
                  totalTokenCount: 5,
                },
              },
            })),
          },
        },
      });
    }

    return missing();
  };
  return { fetch, wire };
}

const urls = {
  unset: undefined,
  openrouter: "https://openrouter.ai/api/v1",
  gateway: "https://gateway.example.test/api/v1",
  native: {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    google: "https://generativelanguage.googleapis.com/v1beta",
    openrouter: "https://api.openai.com/v1",
  },
} as const;
type Url = "unset" | "openrouter" | "gateway" | "native";

const flows = [
  "same-client",
  "resume",
  "resume-without-refs",
  "saved-elsewhere",
] as const;

interface Scenario {
  name: string;
  family: Family;
  provider: Provider | undefined;
  sdkAbsent: boolean;
  url: Url;
  key: "env" | "inline";
  flow: (typeof flows)[number];
}

const scenarios: Scenario[] = [];
for (const family of Object.keys(models) as Family[]) {
  const native = family === "openrouter" ? [] : [family];
  for (const provider of [undefined, "openrouter", ...native] as const) {
    for (const sdkAbsent of family === "openai" || family === "anthropic"
      ? [false, true]
      : [false]) {
      for (const url of ["unset", "openrouter", "gateway", "native"] as const) {
        for (const key of ["env", "inline"] as const) {
          for (const flow of flows) {
            scenarios.push({
              name: [
                family,
                provider ?? "auto",
                sdkAbsent ? "sdk-absent" : "sdk-present",
                `url-${url}`,
                `key-${key}`,
                flow,
              ].join(" "),
              family,
              provider,
              sdkAbsent,
              url,
              key,
              flow,
            });
          }
        }
      }
    }
  }
}

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function run(s: Scenario) {
  const { fetch, wire } = fakeProviders();
  const steps: unknown[] = [];
  const logger = new InMemoryAICallLogger();
  const ai = createAIHelper("parity", logger);
  const modelKey = models[s.family];
  const options = {
    fetch,
    ...(s.url === "native"
      ? { baseURL: urls.native[s.family] }
      : s.url !== "unset"
        ? { baseURL: urls[s.url] }
        : {}),
    ...(s.key === "inline" ? { apiKey: "inline-key" } : {}),
  };
  const client = () => ai.batch(modelKey, s.provider, options);
  const step = async (name: string, call: () => unknown) => {
    try {
      const value = await call();
      steps.push({ name, value });
      return value as any;
    } catch (error) {
      steps.push({ name, error: (error as Error).message });
      return undefined;
    }
  };

  const plain = { id: "plain", prompt: "Add 2 and 3." };
  const structured = {
    id: "structured",
    prompt: "Add 4 and 5.",
    schema: sumSchema,
  };

  if (s.flow === "saved-elsewhere") {
    // A batch an earlier worker submitted through the other transport.
    const configured =
      s.provider ?? (s.family === "openrouter" ? "openrouter" : s.family);
    const [savedKey, savedProvider]: [string, Provider] =
      configured !== "openrouter"
        ? [modelKey, "openrouter"]
        : s.family === "openrouter"
          ? [models.google, "google"]
          : [modelKey, s.family as Provider];
    const saved = await step("saved submit", () =>
      ai.batch(savedKey, savedProvider, { fetch }).submit([plain]),
    );
    if (!saved) return roundTrip({ steps, wire });
    const refs = roundTrip(saved.refs);
    if (s.sdkAbsent) sdk.absent.add(s.family);
    const batch = client();
    await step("status with refs", () =>
      batch.getStatus(saved.id, { batchRefs: refs }),
    );
    await step("results by id", () => batch.getResults(saved.id));
    await step("results with schemas", () =>
      batch.getResults(saved.id, { schemas: { plain: sumSchema } }),
    );
    const next = await step("submit", () =>
      batch.submit([{ id: "next", prompt: "Add 6 and 7." }]),
    );
    if (next) {
      await step("new status", () => batch.getStatus(next.id));
      await step("new results", () => batch.getResults(next.id));
    }
    await step("cancel with refs", () =>
      batch.cancel?.(saved.id, { batchRefs: refs }),
    );
  } else {
    if (s.sdkAbsent) sdk.absent.add(s.family);
    const batch = client();
    const handle = await step("submit", () =>
      batch.submit(
        s.flow === "resume-without-refs" ? [plain] : [plain, structured],
      ),
    );
    if (handle && s.flow === "same-client") {
      await step("status", () => batch.getStatus(handle.id));
      await step("results", () => batch.getResults(handle.id));
      await step("cancel", () => batch.cancel?.(handle.id));
    }
    if (handle && s.flow === "resume") {
      const batchRefs = roundTrip(handle.refs);
      const resumed = client();
      await step("status", () => resumed.getStatus(handle.id, { batchRefs }));
      await step("results", () =>
        resumed.getResults(handle.id, {
          batchRefs,
          totalRequests: 2,
          schemas: { structured: sumSchema },
        }),
      );
      await step("cancel", () => resumed.cancel?.(handle.id, { batchRefs }));
    }
    if (handle && s.flow === "resume-without-refs") {
      const batchRefs = roundTrip(handle.refs);
      const resumed = client();
      await step("status", () => resumed.getStatus(handle.id, { batchRefs }));
      await step("results by id", () => resumed.getResults(handle.id));
      const another = client();
      await step("status again", () =>
        another.getStatus(handle.id, { batchRefs }),
      );
      await step("results with schemas", () =>
        another.getResults(handle.id, { schemas: { plain: sumSchema } }),
      );
    }
  }

  const ledger = logger.getAllCalls().map((call) => ({
    requestId: call.requestId,
    modelId: call.modelId,
    response: call.response,
    cost: call.cost,
    costSource: (call as { costSource?: unknown }).costSource,
  }));
  return roundTrip({ steps, wire, ledger });
}

const SNAPSHOT = new URL(
  "./snapshots/batch-wire-1.0.0-alpha.21.json",
  import.meta.url,
);

describe("batch requests and results without a provider policy match alpha.21", () => {
  // Each recorded outcome lists the scenarios that produced it.
  const expected = new Map<string, unknown>();
  for (const { scenarios: names, ...outcome } of JSON.parse(
    readFileSync(SNAPSHOT, "utf8"),
  ).outcomes as { scenarios: string[] }[]) {
    for (const name of names) expected.set(name, outcome);
  }

  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "env-openrouter");
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "env-google");
  });
  afterEach(() => {
    sdk.absent.clear();
    vi.unstubAllEnvs();
  });

  it("covers every recorded scenario", () => {
    expect(scenarios.map((s) => s.name).sort()).toEqual(
      [...expected.keys()].sort(),
    );
  });

  it.each(scenarios)("$name", async (s) => {
    expect(await run(s)).toEqual(expected.get(s.name));
  });
});
