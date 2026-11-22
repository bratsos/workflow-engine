/**
 * Durable single AI calls: step options (retries), tool forwarding, and
 * `ctx.step.ai.streamText`.
 */

import { stepCountIs, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerModels } from "../../ai/model-helper.js";
import { isNonRetryableError } from "../../core/steps.js";
import { defineWorkflow } from "../../core/workflow.js";
import { createTestHarness } from "../../testing/index.js";

const MODEL = "ai-step-options-model";

registerModels({
  [MODEL]: {
    id: "openai/gpt-4o-mini",
    name: "AI Step Options Model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
  },
});

const In = z.object({ topic: z.string() });

describe("ctx.step.ai step options", () => {
  it("retries a thrown model call across a suspension and replay", async () => {
    const workflow = defineWorkflow("step-ai-retries", { input: In })
      .stage("summarize", {
        schemas: {
          input: In,
          output: z.object({ text: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const result = await ctx.step.ai.generateText(
            "summary",
            MODEL,
            `summarize ${ctx.input.topic}`,
            undefined,
            { retries: 1 },
          );
          return { output: { text: result.text } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("summarize", { text: "the summary" });
    harness.mockAi.failOnce("summarize", new Error("transient upstream 503"));

    const result = await harness.run("step-ai-retries", { topic: "steps" });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ text: "the summary" });
    // The first execution suspended instead of failing the stage.
    expect(result.reports[0]?.outcomes[0]?.outcome).toBe("suspended");

    const stage = (
      await harness.persistence.getStagesByRun(result.workflowRunId)
    )[0]!;
    const record = await harness.stepLedger.get(stage.id, "summary");
    expect(record?.status).toBe("completed");
    expect(record?.attempt).toBe(2);
  });

  it("fails the stage when the retries are exhausted", async () => {
    const workflow = defineWorkflow("step-ai-retries-exhausted", { input: In })
      .stage("summarize", {
        schemas: {
          input: In,
          output: z.object({ text: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const result = await ctx.step.ai.generateText(
            "summary",
            MODEL,
            "summarize always-fails",
            undefined,
            { retries: 1 },
          );
          return { output: { text: result.text } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setError(true, "model is down");

    const result = await harness.run("step-ai-retries-exhausted", {
      topic: "steps",
    });
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("model is down");
  });

  it("stops retrying a model call that retryIf rejects and fails the stage terminally", async () => {
    const decisions: Array<[string, number]> = [];
    let caught: unknown;
    const workflow = defineWorkflow("step-ai-retry-if", { input: In })
      .stage("summarize", {
        schemas: {
          input: In,
          output: z.object({ text: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const result = await ctx.step.ai
            .generateText("summary", MODEL, "summarize 400", undefined, {
              retries: 3,
              retryIf: (error, info) => {
                decisions.push([(error as Error).message, info.attempt]);
                return false;
              },
            })
            .catch((error: unknown) => {
              caught = error;
              throw error;
            });
          return { output: { text: result.text } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setError(true, "400 invalid request");

    const result = await harness.run("step-ai-retry-if", { topic: "steps" });

    // Three retries and three job attempts were available; none was used.
    expect(result.status).toBe("FAILED");
    expect(decisions).toEqual([["400 invalid request", 1]]);
    expect(isNonRetryableError(caught)).toBe(true);
    expect(result.reports.flatMap((r) => r.outcomes)).toEqual([
      { stageId: "summarize", outcome: "failed", error: expect.any(String) },
    ]);
  });

  it("forwards tools, stopWhen and onStepEnd through step.ai.generateText", async () => {
    const steps: unknown[] = [];
    const lookup = tool({
      description: "Look a topic up",
      inputSchema: z.object({ topic: z.string() }),
      execute: async ({ topic }) => ({ found: topic }),
    });

    const workflow = defineWorkflow("step-ai-tools", { input: In })
      .stage("research", {
        schemas: {
          input: In,
          output: z.object({ text: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const result = await ctx.step.ai.generateText(
            "research",
            MODEL,
            "research the topic",
            {
              tools: { lookup },
              stopWhen: stepCountIs(3),
              onStepEnd: (step) => {
                steps.push(step);
              },
            },
          );
          return { output: { text: result.text } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("research", { text: "researched" });

    const result = await harness.run("step-ai-tools", { topic: "tools" });
    expect(result.status).toBe("COMPLETED");

    const call = harness.mockAi.helper.getAllCallsRecursive()[0];
    expect(call?.options).toMatchObject({ tools: { lookup } });
    expect(call?.options?.stopWhen).toBeDefined();
    expect(call?.options?.onStepEnd).toBeTypeOf("function");
  });

  it("streams on first execution and replays the stored text without streaming", async () => {
    const chunks: string[] = [];
    let polls = 0;

    const workflow = defineWorkflow("step-ai-stream", { input: In })
      .stage("draft", {
        schemas: {
          input: In,
          output: z.object({ text: z.string(), cost: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const draft = await ctx.step.ai.streamText(
            "draft",
            MODEL,
            "draft the answer",
            { onChunk: (chunk) => chunks.push(chunk) },
          );
          // Force a suspension after the stream so the next replay has to
          // answer `draft` from the ledger.
          await ctx.step.waitFor("gate", {
            poll: async () => ++polls,
            ready: (n) => n >= 2,
            every: "10s",
            timeout: "1h",
          });
          return { output: { text: draft.text, cost: draft.cost } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("draft", {
      text: "one two three",
      inputTokens: 7,
      outputTokens: 9,
      cost: 0.5,
    });

    const result = await harness.run("step-ai-stream", { topic: "streaming" });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ text: "one two three", cost: 0.5 });
    // Exactly one model call: the replay came from the ledger.
    expect(
      harness.mockAi.helper
        .getAllCallsRecursive()
        .filter((c) => c.type === "stream"),
    ).toHaveLength(1);
    // Incremental chunks first, then one whole-text call on the replay.
    expect(chunks.slice(0, 3)).toEqual(["one ", "two ", "three"]);
    expect(chunks[chunks.length - 1]).toBe("one two three");
  });
});
