import { expect, it, vi } from "vitest";
import { createAIHelper } from "../../ai/ai-helper.js";
import type { CreateAICallInput } from "../../persistence/interface.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";
import { createLogger } from "../../utils/logger.js";

const modelKey = "gemini-2.5-flash";
const externalCall = {
  modelKey: "external-realtime",
  callType: "realtime",
  prompt: "request marker",
  response: "response marker",
  inputTokens: 2,
  outputTokens: 3,
  cost: 0.25,
  servedBy: "provider-a",
  cachedInputTokens: 1,
  reasoningTokens: 2,
  metadata: { session: "session-1" },
} as const;

it("passes the external cost, merged attribution and text policy to a custom logger", async () => {
  const logger = new InMemoryAICallLogger();
  const logCall = vi.spyOn(logger, "logCall");
  const ai = createAIHelper("accounting", logger, undefined, undefined, {
    attribution: { tenantId: "tenant-a", labels: { tier: "base", task: "a" } },
    text: { store: "full", ttlMs: 60_000 },
  });
  ai.createChild("session", "1", {
    attribution: { labels: { tier: "priority" } },
    text: { store: "none" },
  }).recordCall(externalCall);
  expect(logCall).toHaveBeenCalledWith(
    expect.objectContaining({
      topic: "accounting.session.1",
      tenantId: "tenant-a",
      labels: { tier: "priority", task: "a" },
      modelId: externalCall.modelKey,
      callType: "realtime",
      cost: 0.25,
      reportedCost: 0.25,
      costSource: "reported",
      servedBy: "provider-a",
      cachedInputTokens: 1,
      reasoningTokens: 2,
      metadata: { session: "session-1" },
      prompt: "",
      response: "",
    }),
  );
});

it("waits for child writes, reports rejections, and bounds unconsumed adapter streams", async () => {
  const logger = new InMemoryAICallLogger();
  const write = Promise.withResolvers<void>();
  const error = new Error("write failed");
  const onLogError = vi.fn<(error: unknown, call: CreateAICallInput) => void>();
  vi.spyOn(logger, "logCall").mockImplementation(() => write.promise);
  const ai = createAIHelper("accounting", logger, undefined, undefined, {
    onLogError,
    adapter: {
      streamText: () => ({
        stream: (async function* () {
          yield "response marker";
        })(),
      }),
    },
  });
  const child = ai.createChild("stream");
  const stream = child.streamText(modelKey, { prompt: "request marker" });
  expect(await ai.flush({ timeoutMs: 5 })).toEqual({ failed: 0, pending: 1 });
  const flushed = ai.flush();
  for await (const _ of stream.stream) {
    // Drain while the flush is waiting.
  }
  write.reject(error);
  expect(await flushed).toEqual({ failed: 1, pending: 0 });
  expect(await child.flush()).toEqual({ failed: 1, pending: 0 });
  expect(onLogError).toHaveBeenCalledWith(
    error,
    expect.objectContaining({ topic: "accounting.stream" }),
  );
});

it("only emits request, response and provider error text with the text trace flag", async () => {
  vi.stubEnv("WORKFLOW_ENGINE_TRACE", "1");
  vi.stubEnv("WORKFLOW_ENGINE_TRACE_TEXT", "");
  const trace = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const logger = new InMemoryAICallLogger();
    const ai = createAIHelper("accounting", logger, undefined, undefined, {
      adapter: {
        async generateText({ prompt }) {
          if (prompt === "fail") throw new Error("error body marker");
          return { text: "response marker", inputTokens: 2, outputTokens: 3 };
        },
        async embed() {
          return { embeddings: [[1]], inputTokens: 2 };
        },
      },
    });
    const call = async () => {
      createLogger("JobQueue").debug(
        "Job job-1 failed permanently: error body marker",
      );
      createLogger("AIHelper").debug("transcribe request", {
        audio: "audio URL marker",
      });
      await ai.generateText(modelKey, "request marker");
      await ai.embed(modelKey, "embedding marker");
      const failure = ai.generateText(modelKey, "fail");
      await expect(failure).rejects.toThrow("Provider generation failed");
      await expect(failure).rejects.not.toHaveProperty("cause");
    };
    await call();
    expect(trace.mock.calls.flat()).toContain(
      "[AIHelper] generateText request",
    );
    expect(JSON.stringify([trace.mock.calls, errors.mock.calls])).not.toMatch(
      /request marker|response marker|embedding marker|error body marker|audio URL marker/,
    );
    vi.stubEnv("WORKFLOW_ENGINE_TRACE_TEXT", "1");
    await call();
    const output = JSON.stringify([trace.mock.calls, errors.mock.calls]);
    for (const marker of [
      "request marker",
      "response marker",
      "embedding marker",
      "error body marker",
      "audio URL marker",
    ]) {
      expect(output).toContain(marker);
    }
  } finally {
    trace.mockRestore();
    errors.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("does not send provider warnings to process diagnostics", async () => {
  vi.stubEnv("WORKFLOW_ENGINE_TRACE", "");
  vi.stubEnv("WORKFLOW_ENGINE_TRACE_TEXT", "");
  const warnings = vi
    .spyOn(process, "emitWarning")
    .mockImplementation(() => {});
  try {
    const { MockLanguageModelV4 } = await import("ai/test");
    const model = new MockLanguageModelV4({
      async doGenerate() {
        return {
          content: [{ type: "text", text: "reply" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: {
              total: 1,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
          warnings: [{ type: "other", message: "private warning marker" }],
        };
      },
    });
    const ai = createAIHelper(
      "accounting",
      new InMemoryAICallLogger(),
      undefined,
      () => model,
      {
        text: { store: "none" },
      },
    );
    expect((await ai.generateText(modelKey, "request marker")).text).toBe(
      "reply",
    );
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(
      "private warning marker",
    );
  } finally {
    warnings.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("does not leave an open write after normalizing an empty stream prompt", async () => {
  const ai = createAIHelper(
    "accounting",
    new InMemoryAICallLogger(),
    undefined,
    undefined,
    {
      adapter: {
        streamText: () => ({
          stream: (async function* () {
            yield "reply";
          })(),
        }),
      },
    },
  );
  const { stream } = ai.streamText(modelKey, { prompt: "" });
  for await (const _ of stream) {
    /* drain */
  }
  expect(await ai.flush({ timeoutMs: 0 })).toEqual({ failed: 0, pending: 0 });
});

it("tracks batch recording from the duplicate check through the write", async () => {
  const logger = new InMemoryAICallLogger();
  const check = Promise.withResolvers<boolean>();
  vi.spyOn(logger, "isRecorded").mockReturnValue(check.promise);
  const ai = createAIHelper("accounting", logger);
  const batch = ai.createChild("batch").batch(modelKey, "openrouter");
  const recorded = batch.recordResults("batch-1", [
    {
      id: "item-1",
      prompt: "request marker",
      status: "succeeded",
      result: "response marker",
      inputTokens: 1,
      outputTokens: 1,
    },
  ]);
  try {
    expect(await ai.flush({ timeoutMs: 0 })).toEqual({ failed: 0, pending: 1 });
  } finally {
    check.resolve(false);
    await recorded;
  }
  expect(await ai.flush()).toEqual({ failed: 0, pending: 0 });
});
