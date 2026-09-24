/**
 * `ai.transcribe` and `ctx.step.ai.transcribe`: speech to text through the
 * AI SDK's `transcribe`.
 *
 * The helper tests run the real AI SDK `transcribe` against a fake
 * transcription model registered with `registerTranscriptionProvider`, so
 * the AI SDK's own handling is exercised rather than mocked away.
 */

import type { TranscriptionModelV4 } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createAIHelper,
  getTranscriptionModelProvider,
  registerTranscriptionProvider,
} from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import { defineWorkflow } from "../../core/workflow.js";
import { createTestHarness } from "../../testing/index.js";

const TRANSCRIBER = "transcribe-test/whisper";
const TEXT_MODEL = "transcribe-test/text";

registerModels({
  [TRANSCRIBER]: {
    id: "whisper-1",
    name: "Whisper",
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    provider: "transcribe-test",
    isTranscriptionModel: true,
    transcriptionCostPerMinute: 0.006,
  },
  "transcribe-test/gemini": {
    id: "gemini-3.5-transcribe",
    name: "Gemini Transcribe",
    inputCostPerMillion: 1,
    outputCostPerMillion: 4,
    provider: "transcribe-test-tokens",
    isTranscriptionModel: true,
  },
  [TEXT_MODEL]: {
    id: "openai/gpt-4o-mini",
    name: "Text",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "transcribe-test",
  },
});

function fakeModel(onCall?: (audio: Uint8Array | string) => void) {
  const model: TranscriptionModelV4 = {
    specificationVersion: "v4",
    provider: "transcribe-test",
    modelId: "whisper-1",
    async doGenerate(options) {
      onCall?.(options.audio);
      return {
        text: "Hello there. General Kenobi.",
        segments: [
          { text: "Hello there.", startSecond: 0, endSecond: 1.5 },
          { text: "General Kenobi.", startSecond: 1.5, endSecond: 3 },
        ],
        language: "en",
        durationInSeconds: 90,
        warnings: [],
        response: { timestamp: new Date(), modelId: "whisper-1" },
      };
    },
  };
  return model;
}

function makeLogger() {
  return {
    logCall: vi.fn(),
    getStats: vi.fn(),
    isRecorded: vi.fn().mockResolvedValue(false),
    logBatchResults: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ai.transcribe", () => {
  it("returns the transcript and prices it by the audio's duration", async () => {
    const received: Array<Uint8Array | string> = [];
    registerTranscriptionProvider("transcribe-test", () =>
      fakeModel((audio) => received.push(audio)),
    );
    const logger = makeLogger();
    const ai = createAIHelper("transcribe.test", logger);
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

    const result = await ai.transcribe(TRANSCRIBER, audio);

    expect(result).toEqual({
      text: "Hello there. General Kenobi.",
      segments: [
        { text: "Hello there.", startSecond: 0, endSecond: 1.5 },
        { text: "General Kenobi.", startSecond: 1.5, endSecond: 3 },
      ],
      language: "en",
      durationInSeconds: 90,
      // 1.5 minutes at $0.006 per minute.
      cost: expect.closeTo(0.009, 12),
      costSource: "estimated",
    });
    expect(received).toHaveLength(1);

    expect(logger.logCall).toHaveBeenCalledTimes(1);
    expect(logger.logCall.mock.calls[0]![0]).toMatchObject({
      topic: "transcribe.test",
      callType: "transcribe",
      modelKey: TRANSCRIBER,
      prompt: "[audio 4 bytes]",
      response: "Hello there. General Kenobi.",
      inputTokens: 0,
      outputTokens: 0,
      cost: expect.closeTo(0.009, 12),
      estimatedCost: expect.closeTo(0.009, 12),
      costSource: "estimated",
      metadata: { durationInSeconds: 90, language: "en", segmentCount: 2 },
    });
  });

  it("prices a token-billed provider from the usage in its metadata", async () => {
    // Google reports tokens, not a duration.
    registerTranscriptionProvider("transcribe-test-tokens", () => ({
      specificationVersion: "v4",
      provider: "transcribe-test-tokens",
      modelId: "gemini-3.5-transcribe",
      async doGenerate() {
        return {
          text: "The workflow engine can now transcribe audio.",
          segments: [],
          language: undefined,
          durationInSeconds: undefined,
          warnings: [],
          response: { timestamp: new Date(), modelId: "gemini-3.5-transcribe" },
          providerMetadata: {
            google: {
              usage: { total_input_tokens: 70_000, total_output_tokens: 1_000 },
            },
          },
        };
      },
    }));
    const logger = makeLogger();
    const ai = createAIHelper("transcribe.test", logger);

    const result = await ai.transcribe(
      "transcribe-test/gemini",
      new Uint8Array([1, 2, 3]),
    );

    // 70k input tokens at $1/M plus 1k output tokens at $4/M.
    expect(result.cost).toBeCloseTo(0.074, 12);
    expect(result.costSource).toBe("estimated");
    expect(logger.logCall.mock.calls[0]![0]).toMatchObject({
      inputTokens: 70_000,
      outputTokens: 1_000,
    });
  });

  it("refuses a model that is not a transcription model before calling any provider", async () => {
    const onCall = vi.fn();
    registerTranscriptionProvider("transcribe-test", () => fakeModel(onCall));
    const logger = makeLogger();
    const ai = createAIHelper("transcribe.test", logger);

    await expect(
      ai.transcribe(TEXT_MODEL, new Uint8Array([1, 2, 3])),
    ).rejects.toThrow(/not a transcription model/);
    expect(onCall).not.toHaveBeenCalled();
    expect(logger.logCall).not.toHaveBeenCalled();
  });

  it("resolves OpenAI and Google transcription models by registry provider", async () => {
    const openai = await getTranscriptionModelProvider({
      id: "openai/gpt-4o-transcribe",
      name: "GPT-4o Transcribe",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      provider: "openai",
      isTranscriptionModel: true,
    });
    expect(openai.modelId).toBe("gpt-4o-transcribe");
    expect(openai.provider).toMatch(/^openai/);

    const google = await getTranscriptionModelProvider({
      id: "google/gemini-3.5-transcribe",
      name: "Gemini Transcribe",
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      provider: "google",
      isTranscriptionModel: true,
    });
    expect(google.modelId).toBe("gemini-3.5-transcribe");
    expect(google.provider).toMatch(/^google/);
  });
});

describe("ctx.step.ai.transcribe", () => {
  it("memoises the transcript so a replay after a suspension does not transcribe again", async () => {
    const In = z.object({ url: z.string() });
    const workflow = defineWorkflow("step-ai-transcribe", { input: In })
      .stage("transcribe", {
        schemas: {
          input: In,
          output: z.object({ text: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const transcript = await ctx.step.ai.transcribe(
            "transcript",
            TRANSCRIBER,
            new URL(ctx.input.url),
          );
          // Suspends once, so execute() runs again on the next tick.
          await ctx.step.sleep("cool-off", "1m");
          return { output: { text: transcript.text } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTranscribeResponse({
      text: "the recorded interview",
      durationInSeconds: 600,
    });

    const result = await harness.run("step-ai-transcribe", {
      url: "https://example.com/interview.mp3",
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ text: "the recorded interview" });
    const calls = harness.mockAi.helper
      .getAllCallsRecursive()
      .filter((call) => call.type === "transcribe");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe("https://example.com/interview.mp3");
  });
});
