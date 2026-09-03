/**
 * The consumer's 1,067-line extraction stage (realtime branch with
 * validation/retry/budget, batch branch with hand-threaded metadata, no
 * validation on batch output) reimplemented on `ctx.step.ai.map`: prompt
 * build + schema + repair + policy, with durability and batch parity for free.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { createMockAIHelperFactory } from "../utils/index.js";
import {
  createAiMapHarness,
  REALTIME_MODEL,
  withCallHook,
} from "./ai-map-harness.js";

const SectionSchema = z.object({
  title: z.string(),
  body: z.string(),
});
const ExtractionSchema = z.object({ sections: z.array(SectionSchema) });

const inputSchema = z.object({
  documents: z.array(z.object({ id: z.string(), text: z.string() })),
});
const outputSchema = z.object({
  extracted: z.array(
    z.object({
      documentId: z.string(),
      sections: z.array(SectionSchema),
      attempts: z.number(),
    }),
  ),
  failed: z.array(z.object({ documentId: z.string(), error: z.string() })),
  cost: z.number(),
});

let lastOutput: z.infer<typeof outputSchema> | undefined;

const unifiedExtract = defineStage({
  id: "unified-extract",
  name: "Unified Extract",
  schemas: {
    input: inputSchema,
    output: outputSchema,
    config: z.object({ concurrency: z.number().default(4) }),
  },
  async execute(ctx) {
    const results = await ctx.step.ai.map("extract", ctx.input.documents, {
      model: REALTIME_MODEL,
      schema: ExtractionSchema,
      system: "You extract structured sections from documents.",
      prompt: (doc) =>
        `Extract the sections of document ${doc.id}:\n${doc.text}`,
      itemId: (doc) => doc.id,
      repair: { attempts: 2 },
      policy: "auto",
      auto: { batchAbove: 100 },
      realtime: { concurrency: ctx.config.concurrency ?? 4, budget: 500 },
    });
    lastOutput = {
      extracted: results.flatMap((r) =>
        r.status === "succeeded"
          ? [
              {
                documentId: r.id,
                sections: r.result.sections,
                attempts: r.attempts,
              },
            ]
          : [],
      ),
      failed: results.flatMap((r) =>
        r.status === "failed" ? [{ documentId: r.id, error: r.error }] : [],
      ),
      cost: results.reduce((sum, r) => sum + r.cost, 0),
    };
    return { output: lastOutput };
  },
});

describe("unified extraction stage on step.ai.map", () => {
  it("completes with N validated results and N model calls across a crash/resume", async () => {
    const N = 25;
    const documents = Array.from({ length: N }, (_, i) => ({
      id: `doc-${i}`,
      text: `body ${i}`,
    }));
    const mock = createMockAIHelperFactory();
    for (const doc of documents) {
      mock.setObjectResponse(`document ${doc.id}:`, {
        object: { sections: [{ title: doc.id, body: `section of ${doc.id}` }] },
      });
    }
    let calls = 0;
    const crashing = withCallHook(mock, () => {
      calls++;
      if (calls === 10) throw new Error("worker lost");
    });
    const h = await createAiMapHarness({
      stage: unifiedExtract,
      inputSchema,
      outputSchema,
      input: { documents },
      mock,
      aiFactory: crashing,
    });

    await expect(h.execute()).resolves.toMatchObject({ outcome: "suspended" });
    await h.settle();
    expect((await h.stage())?.status).toBe("COMPLETED");

    // Every document reached the model exactly once (the crashed call never did).
    expect(mock.getCalls()).toHaveLength(N);
    const output = lastOutput!;
    expect(output.failed).toEqual([]);
    expect(output.extracted).toHaveLength(N);
    expect(output.extracted.map((e) => e.documentId)).toEqual(
      documents.map((d) => d.id),
    );
    expect(output.extracted.every((e) => e.attempts === 1)).toBe(true);
    expect(output.extracted[3]?.sections).toEqual([
      { title: "doc-3", body: "section of doc-3" },
    ]);
    expect(output.cost).toBeCloseTo(N * 0.001, 9);
  });
});
