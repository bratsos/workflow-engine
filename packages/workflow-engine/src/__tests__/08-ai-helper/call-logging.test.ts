import { APICallError } from "@ai-sdk/provider";
import type { TextStreamPart, ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createAIHelper,
  registerEvaluationProvider,
} from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import { isRetryableStageError } from "../../kernel/helpers/stage-retry.js";
import type {
  AICallLogger,
  CreateAICallInput,
} from "../../persistence/interface.js";
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
      text: { store: "none" },
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
      // The caller gets the provider's error unchanged.
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

const marker = "private stream diagnostic marker";
const usage = {
  inputTokens: {
    total: 1,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

it.each([
  "rejected call",
  "error part",
  "broken stream",
] as const)("passes a %s through the SDK unchanged and keeps it out of the row and trace", async (failure) => {
  vi.stubEnv("WORKFLOW_ENGINE_TRACE", "1");
  vi.stubEnv("WORKFLOW_ENGINE_TRACE_TEXT", "");
  const trace = vi.spyOn(console, "log").mockImplementation(() => {});
  let calls = 0;
  const model = new MockLanguageModelV4({
    async doStream() {
      calls++;
      if (failure === "rejected call") {
        throw new APICallError({
          message: marker,
          url: "https://provider.invalid/v1",
          requestBodyValues: { prompt: marker },
          statusCode: 503,
          // The SDK reads the retry delay from the headers.
          responseHeaders: { "retry-after-ms": "1" },
          responseBody: marker,
          isRetryable: true,
        });
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({ type: "text-delta", id: "1", delta: "a" });
            if (failure === "broken stream") {
              controller.error(new Error(marker));
              return;
            }
            controller.enqueue({ type: "error", error: new Error(marker) });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "error", raw: "error" },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
  });
  const logger = new InMemoryAICallLogger();
  const ai = createAIHelper("accounting", logger, undefined, () => model, {
    text: { store: "none" },
  });
  const seen: unknown[] = [];
  try {
    const { rawResult } = ai.streamText(
      modelKey,
      { prompt: "request marker" },
      { maxRetries: 1 },
    );
    try {
      for await (const part of rawResult!.fullStream as AsyncIterable<
        TextStreamPart<ToolSet>
      >) {
        if (part.type === "error") seen.push(part.error);
      }
    } catch (error) {
      seen.push(error);
    }
    // A stream that ended, even in a read rejection, is no longer pending.
    expect(await ai.flush({ timeoutMs: 50 })).toEqual({
      failed: 0,
      pending: 0,
    });
    expect(calls).toBe(failure === "rejected call" ? 2 : 1);
    expect(seen).not.toHaveLength(0);
    const messages = seen.map((error) => (error as Error).message);
    expect(messages.join(" ")).toContain(marker);
    if (failure === "rejected call") {
      // The SDK's retry error, holding the provider's own error.
      const last = (seen[0] as { lastError?: unknown }).lastError;
      expect(APICallError.isInstance(last)).toBe(true);
    }
    expect(
      JSON.stringify(logger.getAllCalls()) + JSON.stringify(trace.mock.calls),
    ).not.toContain(marker);
    if (failure === "error part") {
      // The usage after the error is charged, as in earlier releases.
      expect(
        logger
          .getAllCalls()
          .map((call) => [call.inputTokens, call.outputTokens]),
      ).toContainEqual([1, 1]);
    }
    vi.stubEnv("WORKFLOW_ENGINE_TRACE_TEXT", "1");
    calls = 0;
    const second = ai.streamText(
      modelKey,
      { prompt: "request marker" },
      { maxRetries: 0 },
    );
    try {
      for await (const _ of second.stream) {
        // The helper's own stream traces the raw diagnostic with both flags.
      }
    } catch {
      // Expected for every case.
    }
    // The failure row, and its trace, follow the SDK's own end.
    await ai.flush();
    expect(JSON.stringify(trace.mock.calls)).toContain(marker);
  } finally {
    trace.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("keeps an adapter's Zod error unchanged and terminal, and its text out of the row", async () => {
  const logger = new InMemoryAICallLogger();
  const ai = createAIHelper("accounting", logger, undefined, undefined, {
    text: { store: "none" },
    adapter: {
      async generateText() {
        z.strictObject({}).parse({ [marker]: 1 });
        return { text: "", inputTokens: 0, outputTokens: 0 };
      },
    },
  });
  const error = await ai
    .generateText(modelKey, "request marker")
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(z.ZodError);
  expect((error as Error).message).toContain(marker);
  expect(isRetryableStageError(error)).toBe(false);
  expect(logger.getAllCalls()).toHaveLength(1);
  expect(JSON.stringify(logger.getAllCalls())).not.toContain(marker);
});

it("prints provider error text to the console only with text tracing on", async () => {
  const output = (["log", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
  const printed = () => JSON.stringify(output.map((spy) => spy.mock.calls));
  const logger = new InMemoryAICallLogger();
  const workflowLogs: string[] = [];
  const model = new MockLanguageModelV4({
    async doGenerate() {
      throw new APICallError({
        message: marker,
        url: "https://provider.invalid/v1",
        requestBodyValues: {},
        statusCode: 400,
        responseBody: marker,
        isRetryable: false,
      });
    },
  });
  // A completed batch whose one item the provider failed.
  const fetch = async () =>
    Response.json({
      id: "batch-1",
      status: "completed",
      results: [{ custom_id: "item-1", error: { message: marker } }],
    });
  const run = async () => {
    for (const logContext of [
      undefined,
      {
        workflowRunId: "run-1",
        stageRecordId: "stage-1",
        createLog: async ({ message }: { message: string }) => {
          workflowLogs.push(message);
        },
      },
    ]) {
      // The default policy: full capture, no expiry.
      const ai = createAIHelper("accounting", logger, logContext, () => model);
      await ai
        .batch(modelKey, "openrouter", { apiKey: "fixture-key", fetch })
        .getResults("batch-1");
      await ai
        .generateText(modelKey, "request marker", { maxRetries: 0 })
        .catch(() => {});
    }
  };
  try {
    vi.stubEnv("WORKFLOW_ENGINE_TRACE", "");
    await run();
    vi.stubEnv("WORKFLOW_ENGINE_TRACE", "1");
    await run();
    expect(output[0]!.mock.calls.length).toBeGreaterThan(0);
    expect(printed()).not.toContain(marker);
    // Workflow logs and full-capture rows keep the text, as in earlier releases.
    expect(workflowLogs.join(" ")).toContain(marker);
    expect(
      logger
        .getAllCalls()
        .map((call) => (call.metadata as { error?: string }).error),
    ).toContain(marker);
    vi.stubEnv("WORKFLOW_ENGINE_TRACE_TEXT", "1");
    await run();
    expect(printed()).toContain(marker);
  } finally {
    for (const spy of output) spy.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("works with frozen loggers and providers", async () => {
  const base = new InMemoryAICallLogger();
  const logger = Object.freeze({
    logCall: (call: CreateAICallInput) => base.logCall(call),
    logBatchResults: (batchId: string, calls: CreateAICallInput[]) =>
      base.logBatchResults(batchId, calls),
    isRecorded: (batchId: string) => base.isRecorded(batchId),
    getStats: (topic: string) => base.getStats(topic),
  });
  registerModels({
    "call-logging/frozen": {
      id: "call-logging/frozen",
      name: "Frozen evaluation fixture",
      provider: "call-logging-frozen",
      isEvaluationModel: true,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
  });
  registerEvaluationProvider(
    "call-logging-frozen",
    () =>
      Object.freeze({
        specificationVersion: "v4",
        provider: "call-logging-frozen",
        modelId: "call-logging/frozen",
        supportedQuestionTypes: ["boolean"],
        async doEvaluate() {
          return {
            answers: { ok: { type: "boolean", probability: 0.9 } },
            usage: { inputTokens: 1, outputTokens: 1 },
            warnings: [],
          };
        },
      }) as never,
  );
  const ai = createAIHelper("accounting", logger);
  ai.recordCall(externalCall);
  const result = await ai.evaluate("call-logging/frozen", {
    state: "state",
    questions: { ok: { type: "boolean", instructions: "yes or no" } },
  });
  expect(result.answers.ok).toBeDefined();
  expect(await ai.flush()).toEqual({ failed: 0, pending: 0 });
  expect(base.getAllCalls()).toHaveLength(2);
});

it("rejects an awaited failed write safely, reports every failure and forwards logger members", async () => {
  const onLogError = vi.fn<(error: unknown, call: CreateAICallInput) => void>();
  const refusal = new Error(`constraint refused ${marker}`);
  const base = new InMemoryAICallLogger();
  const logger = Object.assign(base, {
    async logCall() {
      throw refusal;
    },
    custom: () => "forwarded",
  });
  let bound: AICallLogger | undefined;
  const ai = createAIHelper("accounting", logger, undefined, undefined, {
    onLogError,
    bindCallLogger: (callLogger) => {
      bound = callLogger;
    },
  });
  const call = { ...externalCall, topic: "accounting", modelId: "m" };
  const awaited = await Promise.resolve(bound!.logCall(call)).catch(
    (error: unknown) => error,
  );
  expect(awaited).toBeInstanceOf(Error);
  expect(String((awaited as Error).message)).toBe(
    "AI call accounting write failed",
  );
  // Ignored: handled, counted and reported.
  void bound!.logCall(call);
  ai.recordCall(externalCall);
  expect(await ai.flush()).toEqual({ failed: 3, pending: 0 });
  expect(onLogError).toHaveBeenCalledTimes(3);
  expect(onLogError).toHaveBeenCalledWith(refusal, expect.any(Object));
  expect((bound as unknown as { custom(): string }).custom()).toBe("forwarded");

  // A synchronous throw reaches the caller, as in earlier releases.
  logger.logCall = (() => {
    throw refusal;
  }) as unknown as typeof logger.logCall;
  expect(() => ai.recordCall(externalCall)).toThrow(refusal);
  expect(await ai.flush()).toEqual({ failed: 4, pending: 0 });
});

it("traces how many evaluation questions there are, not their keys", async () => {
  registerModels({
    "call-logging/evaluator": {
      id: "call-logging/evaluator",
      name: "Evaluation fixture",
      provider: "call-logging",
      isEvaluationModel: true,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
  });
  const question = `Is this ${marker}?`;
  registerEvaluationProvider("call-logging", () => ({
    specificationVersion: "v4",
    provider: "call-logging",
    modelId: "call-logging/evaluator",
    supportedQuestionTypes: ["boolean"],
    async doEvaluate() {
      return {
        answers: { [question]: { type: "boolean", probability: 0.9 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
      };
    },
  }));
  vi.stubEnv("WORKFLOW_ENGINE_TRACE", "1");
  vi.stubEnv("WORKFLOW_ENGINE_TRACE_TEXT", "");
  const trace = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const ai = createAIHelper("accounting", new InMemoryAICallLogger());
    await ai.evaluate("call-logging/evaluator", {
      state: "request marker",
      questions: { [question]: { type: "boolean", instructions: "yes or no" } },
    });
    expect(JSON.stringify(trace.mock.calls)).toContain("questionCount");
    expect(JSON.stringify(trace.mock.calls)).not.toContain(marker);
  } finally {
    trace.mockRestore();
    vi.unstubAllEnvs();
  }
});
