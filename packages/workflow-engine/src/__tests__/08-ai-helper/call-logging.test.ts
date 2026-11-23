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
      await expect(ai.generateText(modelKey, "fail")).rejects.toThrow(
        "error body marker",
      );
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
