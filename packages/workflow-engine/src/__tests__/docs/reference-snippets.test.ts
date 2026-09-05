/**
 * The snippets in skills/workflow-engine/references/07-testing-patterns.md
 * and 12-durable-steps.md, kept compiling. Anything documented as a code
 * block that a consumer would paste lives here in the same shape.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerModels } from "../../ai/model-helper.js";
import { defineStage } from "../../core/stage-factory.js";
import { defineWorkflow } from "../../core/workflow.js";
import {
  executeJobWithHeartbeat,
  runMaintenanceTick,
} from "../../kernel/index.js";
import { createTestHarness, createTestKernel } from "../../testing/index.js";

const DOC_MODEL = "doc-snippet-model";
registerModels({
  [DOC_MODEL]: {
    id: "openai/gpt-4o-mini",
    name: "Doc Snippet Model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
  },
});

const In = z.object({ message: z.string() });

const workflow = defineWorkflow("echo-wf", { input: In })
  .stage("echo", {
    schemas: {
      input: In,
      output: z.object({ echoed: z.string() }),
      config: z.object({ prefix: z.string().default("") }),
    },
    async execute(ctx) {
      return { output: { echoed: `${ctx.config.prefix}${ctx.input.message}` } };
    },
  })
  .build();

describe("07-testing-patterns snippets", () => {
  it("completes a single-stage workflow", async () => {
    const harness = createTestHarness({ workflows: [workflow] });

    const result = await harness.run("echo-wf", { message: "hello" });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ echoed: "hello" });
  });

  it("passes per-stage config", async () => {
    const harness = createTestHarness({ workflows: [workflow] });

    const result = await harness.run(
      "echo-wf",
      { message: "hello" },
      { echo: { prefix: "> " } },
    );

    expect(result.output).toEqual({ echoed: "> hello" });
  });

  it("drives the kernel by hand with the host helpers", async () => {
    const { kernel, jobTransport: jobQueue } = createTestKernel([workflow]);
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "snippets-1",
      workflowId: "echo-wf",
      input: { message: "hi" },
    });

    const counts = await runMaintenanceTick(kernel, { workerId: "w-1" });
    expect(counts.claimed).toBe(1);

    const job = await jobQueue.dequeue();
    if (job) {
      await executeJobWithHeartbeat(kernel, { jobTransport: jobQueue, job });
    }
  });

  it("advances the clock before polling suspended stages", async () => {
    const harness = createTestHarness({ workflows: [workflow] });
    harness.clock.advance(60_000);
    const polled = await harness.kernel.dispatch({
      type: "stage.pollSuspended",
    });
    expect(polled.checked).toBe(0);
  });
});

describe("12-durable-steps snippets", () => {
  const ChapterIndex = z.object({ chapters: z.array(z.string()) });
  const FactsSchema = z.object({ facts: z.array(z.string()) });

  it("runs the concurrency, streaming, map and scripting snippets", async () => {
    let polls = 0;
    const chunks: string[] = [];

    const durable = defineWorkflow("doc-durable", { input: In })
      .stage("work", {
        schemas: {
          input: In,
          output: z.object({
            profile: z.string(),
            invoices: z.number(),
            draft: z.string(),
            failed: z.number(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const [profile, , invoices] = await Promise.all([
            ctx.step.run("profile", async () => "alex"),
            ctx.step.waitFor("export", {
              poll: async () => ++polls,
              ready: (n: number) => n >= 2,
              every: "30s",
              timeout: "1h",
            }),
            ctx.step.run("invoices", async () => 3),
          ]);

          const summary = await ctx.step.ai.generateText(
            "summary",
            DOC_MODEL,
            "summarize the document",
            { maxTokens: 2000 },
            { retries: 2, retryDelay: "30s", lease: "2m" },
          );
          expect(summary.text).toBeTypeOf("string");

          const facts = await ctx.step.ai.generateObject(
            "facts",
            DOC_MODEL,
            "extract the facts",
            FactsSchema,
          );
          expect(facts.object).toEqual({ facts: [] });

          const draft = await ctx.step.ai.streamText(
            "draft",
            DOC_MODEL,
            "draft the answer",
            { onChunk: (chunk) => chunks.push(chunk) },
            { retries: 1 },
          );

          const results = await ctx.step.ai.map(
            "extract",
            ["item-1", "item-2", "item-3"],
            {
              model: DOC_MODEL,
              policy: "realtime",
              prompt: (item) => `Extract sections from ${item}`,
              itemId: (item) => item,
              repair: { attempts: 1 },
              realtime: {
                concurrency: 10,
                budget: 500,
                minDelayMs: 1,
                retries: 0,
              },
            },
          );

          let failed = 0;
          for (const r of results) {
            if (r.status === "succeeded") continue;
            if (r.errorName === "SubscriptionLimitError") failed++;
            else failed++;
          }

          return {
            output: {
              profile,
              invoices,
              draft: draft.text,
              failed,
            },
          };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [durable] });
    harness.mockAi.setTextResponse("summarize", { text: "the summary" });
    harness.mockAi.mockObjectResponseForSchema(FactsSchema, { facts: [] });
    harness.mockAi.failOnce("item-2", new Error("subscription limit reached"));

    const result = await harness.run("doc-durable", { message: "hi" });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toMatchObject({
      profile: "alex",
      invoices: 3,
      failed: 1,
    });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("checks a prebuilt stage's context against the accumulated one", () => {
    const indexStage = defineStage({
      id: "chapter-index",
      name: "Chapter Index",
      schemas: {
        input: "none",
        output: ChapterIndex,
        config: z.object({}),
      },
      async execute() {
        return { output: { chapters: ["one"] } };
      },
    });

    const needs = defineStage<{
      "chapter-index": z.infer<typeof ChapterIndex>;
    }>()({
      id: "summary",
      name: "Summary",
      schemas: {
        input: "none",
        output: z.string(),
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: `${ctx.require("chapter-index").chapters.length}` };
      },
    });

    const built = defineWorkflow("doc-prebuilt")
      .stage(indexStage)
      .stage(needs)
      .build();

    expect(built.getStage("summary")).toBeDefined();
  });
});
