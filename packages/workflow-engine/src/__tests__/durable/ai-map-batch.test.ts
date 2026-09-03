import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerModels } from "../../ai/model-helper.js";
import { defineStage } from "../../core/stage-factory.js";
import type { AiMapResult } from "../../core/step-ai.js";
import { createMockAIHelperFactory } from "../utils/index.js";
import {
  BATCH_MODEL,
  createAiMapHarness,
  createBatchAwareFactory,
  type FakeBackendOptions,
  makeFakeBackend,
} from "./ai-map-harness.js";

const inputSchema = z.object({ count: z.number() });
const outputSchema = z.object({ done: z.number() });
const itemSchema = z.object({ v: z.string() });
type Item = z.infer<typeof itemSchema>;

async function setup(
  id: string,
  count: number,
  backendOptions: FakeBackendOptions = {},
  onExpiry?: "fail" | "partial",
) {
  const mock = createMockAIHelperFactory();
  mock.setObjectResponse("Extract", { object: { v: "repaired" } });
  const backend = makeFakeBackend(backendOptions);
  const batchLogs: { level: string; message: string }[] = [];
  let captured: AiMapResult<Item>[] = [];
  const stage = defineStage({
    id,
    name: id,
    schemas: { input: inputSchema, output: outputSchema, config: z.object({}) },
    async execute(ctx) {
      const items = Array.from({ length: ctx.input.count }, (_, i) => i);
      captured = await ctx.step.ai.map("extract", items, {
        model: BATCH_MODEL,
        schema: itemSchema,
        prompt: (item) => `Extract <<${item}>>`,
        batch: { pollEvery: "60s", timeout: "24h", onExpiry },
      });
      return { output: { done: captured.length } };
    },
  });
  const h = await createAiMapHarness({
    stage,
    inputSchema,
    outputSchema,
    input: { count },
    mock,
    aiFactory: createBatchAwareFactory(mock, backend.model, (level, message) =>
      batchLogs.push({ level, message }),
    ),
  });
  return { ...h, mock, backend, batchLogs, results: () => captured };
}

const OPENROUTER_REGISTERED = "ai-map-openrouter-registered-model";
registerModels({
  [OPENROUTER_REGISTERED]: {
    id: "anthropic/claude-haiku-4.5",
    name: "Haiku via OpenRouter",
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    provider: "openrouter",
    supportsAsyncBatch: true,
    batchProvider: "openrouter",
  },
});

describe("step.ai.map batch provider resolution", () => {
  it("batches a model whose registration names OpenRouter through OpenRouter, not the vendor SDK", async () => {
    const mock = createMockAIHelperFactory();
    const backend = makeFakeBackend();
    const seen: { modelKey: string; provider: string }[] = [];
    const stage = defineStage({
      id: "batch-openrouter-registered",
      name: "batch-openrouter-registered",
      schemas: {
        input: inputSchema,
        output: outputSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        const items = Array.from({ length: ctx.input.count }, (_, i) => i);
        const results = await ctx.step.ai.map("extract", items, {
          model: OPENROUTER_REGISTERED,
          policy: "batch",
          schema: itemSchema,
          prompt: (item) => `Extract <<${item}>>`,
          batch: { pollEvery: "60s", timeout: "24h" },
        });
        return { output: { done: results.length } };
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema,
      outputSchema,
      input: { count: 3 },
      mock,
      aiFactory: createBatchAwareFactory(
        mock,
        backend.model,
        undefined,
        (modelKey, provider) => seen.push({ modelKey, provider }),
      ),
    });

    await h.execute();
    await h.settle(60_000);
    expect((await h.stage())?.status).toBe("COMPLETED");
    expect(seen).toEqual([
      { modelKey: OPENROUTER_REGISTERED, provider: "openrouter" },
    ]);
  });
});

describe("step.ai.map batch policy", () => {
  it("submits once, stays suspended across replays, then returns validated results in order", async () => {
    const h = await setup("batch-auto", 50, { pendingPolls: 3 });

    await expect(h.execute()).resolves.toMatchObject({ outcome: "suspended" });
    expect(h.backend.model.start).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      const before = (await h.stage())?.status;
      if (before !== "SUSPENDED") break;
      await h.tick(60_000);
    }
    expect(h.backend.model.start).toHaveBeenCalledTimes(1);
    expect((await h.stage())?.status).toBe("COMPLETED");
    expect(h.backend.polls()).toBe(4);

    const results = h.results();
    expect(results).toHaveLength(50);
    expect(results.map((r) => r.index)).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );
    for (const r of results) {
      expect(r).toMatchObject({
        status: "succeeded",
        validated: true,
        attempts: 1,
        result: { v: r.id },
      });
      expect(r.cost).toBeGreaterThan(0);
    }
    // No realtime calls were needed.
    expect(h.mock.getCalls()).toHaveLength(0);
    // The submit step holds the bookkeeping; nothing went through metadata.
    const stageRecord = await h.stage();
    const submit = await h.ledger.get(stageRecord!.id, "extract:submit");
    expect(submit?.result).toMatchObject({
      handleId: "batch-1",
      totalRequests: 50,
    });
  });

  it("stores the item prompt and the batch wall time (not a per-item durationMs) on the accounting rows", async () => {
    const h = await setup("batch-accounting", 25);

    await h.execute();
    await h.settle(60_000);
    expect((await h.stage())?.status).toBe("COMPLETED");

    const rows = h.aiLogger
      .getCallsByTopic(h.topic)
      .filter((c) => c.callType === "batch");
    expect(rows).toHaveLength(25);
    for (const row of rows) {
      const requestId = (row.metadata as { requestId?: string }).requestId;
      expect(row.prompt).toBe(`Extract <<${requestId}>>`);
      const meta = row.metadata as {
        durationMs?: unknown;
        batchDurationMs?: unknown;
      };
      expect(typeof meta.batchDurationMs).toBe("number");
      expect(meta.durationMs).toBeUndefined();
      expect(row.response).toBe(JSON.stringify({ v: requestId }));
    }
    expect(h.batchLogs.filter((l) => l.level === "WARN")).toEqual([]);
  });

  it("warns when more than half of a batch fails schema validation", async () => {
    const h = await setup("batch-mostly-invalid", 25, {
      // 20 of 25 items come back with the wrong shape.
      respond: (id) =>
        Number(id) < 20 ? JSON.stringify({ v: 1 }) : JSON.stringify({ v: id }),
    });

    await h.execute();
    await h.settle(60_000);
    expect((await h.stage())?.status).toBe("COMPLETED");

    const warns = h.batchLogs.filter((l) => l.level === "WARN");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("20 of 25 results in batch batch-1");
    expect(warns[0]!.message).toContain("20 failed schema validation");
    expect(warns[0]!.message).toContain("first issue:");
    // The repair pass still fixed every item realtime.
    expect(h.mock.getCalls()).toHaveLength(20);
    expect(h.results().every((r) => r.status === "succeeded")).toBe(true);
    // The accounting row of a rejected reply keeps the model's raw text.
    const rejected = h.aiLogger
      .getCallsByTopic(h.topic)
      .filter((c) => c.callType === "batch" && c.response === '{"v":1}');
    expect(rejected).toHaveLength(20);
  });

  it("warns at the poll and at collect when the provider fails most items, naming the class", async () => {
    const failIds = new Set(
      Array.from({ length: 25 }, (_, i) => String(i)).filter(
        (id) => Number(id) < 20,
      ),
    );
    const h = await setup("batch-provider-failed", 25, {
      failIds,
      failError: "Request contains an invalid argument.",
    });

    await h.execute();
    await h.settle(60_000);
    expect((await h.stage())?.status).toBe("COMPLETED");

    const warns = h.batchLogs.filter((l) => l.level === "WARN");
    // One WARN from getStatus when the batch settled, one from getResults.
    expect(warns.map((w) => w.message)).toEqual([
      expect.stringContaining(
        "20 of 25 requests in batch batch-1 failed at the provider",
      ),
      expect.stringContaining(
        "20 of 25 results in batch batch-1 failed: 20 failed at the provider (first error: Request contains an invalid argument.)",
      ),
    ]);
    // Every provider-failed item was re-run realtime by the repair pass.
    expect(h.mock.getCalls()).toHaveLength(20);
    expect(h.results().every((r) => r.status === "succeeded")).toBe(true);
  });

  it("repairs invalid batch items on the realtime path", async () => {
    const h = await setup("batch-repair", 25, {
      respond: (id) =>
        id === "3" || id === "7"
          ? JSON.stringify({ v: 1 })
          : JSON.stringify({ v: id }),
    });

    await h.execute();
    await h.settle(60_000);
    expect((await h.stage())?.status).toBe("COMPLETED");

    const results = h.results();
    expect(h.mock.getCalls()).toHaveLength(2);
    for (const r of results) {
      expect(r.status).toBe("succeeded");
      if (r.status !== "succeeded") continue;
      expect(r.validated).toBe(true);
      if (r.id === "3" || r.id === "7") {
        expect(r.attempts).toBe(2);
        expect(r.result).toEqual({ v: "repaired" });
      } else {
        expect(r.attempts).toBe(1);
      }
    }
  });

  it("returns every item as failed with onExpiry: partial", async () => {
    const h = await setup(
      "batch-partial",
      25,
      { failWith: "expired" },
      "partial",
    );

    await expect(h.execute()).resolves.toMatchObject({ outcome: "completed" });
    const results = h.results();
    expect(results).toHaveLength(25);
    expect(results.every((r) => r.status === "failed")).toBe(true);
    expect(results[0]).toMatchObject({ error: "expired", attempts: 1 });
    expect(h.mock.getCalls()).toHaveLength(0);
  });

  it("throws AiMapBatchFailedError with onExpiry: fail", async () => {
    const h = await setup("batch-fail", 25, { failWith: "expired" }, "fail");

    const result = await h.execute();
    expect(result.outcome).toBe("failed");
    expect(String((result as { error?: string }).error)).toMatch(
      /batch "batch-1" failed: expired/,
    );
  });
});
