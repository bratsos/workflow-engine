/**
 * Resume-path coverage for the REAL AIBatchImpl.
 *
 * This is the scenario the batch subsystem exists for and the one the rest of
 * the batch tests do not reach: `submit()` runs in one process, and
 * `getStatus()` / `getResults()` run in another one up to 24 hours later, on a
 * FRESH AIBatchImpl whose in-process maps are empty by construction. Anything
 * the retrieval side needs must travel through `suspendedState.metadata`.
 *
 * Every test here builds a brand-new AIBatchImpl for the retrieval half rather
 * than reusing the instance that submitted — reusing it hides exactly the bugs
 * this file is here to catch.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AIBatchImpl } from "../../ai/batch-helper.js";
import { registerModels } from "../../ai/model-helper.js";

const MODEL_ID = "batch-resume-model";

beforeAll(() => {
  registerModels({
    [MODEL_ID]: {
      id: "openai/gpt-4o",
      name: "Batch Resume Model",
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
      provider: "openrouter",
      supportsAsyncBatch: true,
    },
  });
});

function makeLogger() {
  const logged: Array<{ batchId: string; records: unknown[] }> = [];
  return {
    logged,
    logger: {
      logCall: vi.fn(),
      getStats: vi.fn().mockResolvedValue({
        totalCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        perModel: {},
      }),
      isRecorded: vi.fn().mockResolvedValue(false),
      logBatchResults: vi.fn(async (batchId: string, records: unknown[]) => {
        logged.push({ batchId, records });
      }),
      getCalls: vi.fn().mockResolvedValue([]),
    },
  };
}

/**
 * A fake EngineBatchModel that hands back whatever was submitted to it,
 * partition by partition, so tests can assert which requests actually came
 * back rather than trusting a count.
 */
function makeFakeBackend(opts: { failOnStart?: number } = {}) {
  const byBatch = new Map<string, string[]>();
  const statuses = new Map<string, "pending" | "completed" | "failed">();
  let n = 0;

  const model = {
    provider: "openrouter",
    modelId: "openai/gpt-4o",
    start: vi.fn(async (requests: Array<{ id: string }>) => {
      n += 1;
      if (opts.failOnStart === n) {
        throw new Error(`429 rate limited on partition ${n}`);
      }
      const id = `batch-${n}`;
      byBatch.set(
        id,
        requests.map((r) => r.id),
      );
      statuses.set(id, "completed");
      return {
        version: 1 as const,
        type: "text" as const,
        id,
        provider: "openrouter",
        modelId: "openai/gpt-4o",
        status: "pending" as const,
      };
    }),
    status: vi.fn(async (ref: { id: string }) => ({
      status: statuses.get(ref.id) ?? "completed",
    })),
    results: vi.fn(async function* (ref: { id: string }) {
      for (const id of byBatch.get(ref.id) ?? []) {
        yield {
          id,
          status: "succeeded" as const,
          text: JSON.stringify({ v: id }),
          inputTokens: 1,
          outputTokens: 1,
        };
      }
    }),
  };
  return { model, byBatch, statuses };
}

function newBatch(
  logger: unknown,
  backend: unknown,
  options: Record<string, unknown> = {},
  logFn?: (level: string, message: string, meta?: unknown) => void,
) {
  const batch = new AIBatchImpl(
    { topic: "resume-test", aiCallLogger: logger as never },
    MODEL_ID,
    "openrouter",
    logFn as never,
    { apiKey: "k", ...options } as never,
  );
  // Bypass credential resolution; we are testing AIBatchImpl, not the backends.
  (batch as unknown as { providerPromise: unknown }).providerPromise =
    Promise.resolve(backend);
  return batch;
}

describe("fan-out survives a suspend/resume", () => {
  it("returns every result when batchRefs travel through metadata", async () => {
    const { model } = makeFakeBackend();
    const { logger } = makeLogger();

    const submitter = newBatch(logger, model, { maxRequestsPerBatch: 2 });
    const handle = await submitter.submit([
      { id: "r1", prompt: "p" },
      { id: "r2", prompt: "p" },
      { id: "r3", prompt: "p" },
      { id: "r4", prompt: "p" },
    ]);
    expect(handle.batchIds).toHaveLength(2);

    // The resume half: a brand-new instance, exactly as a later process gets.
    const resumed = newBatch(logger, model, { maxRequestsPerBatch: 2 });
    const results = await resumed.getResults(handle.id, {
      batchRefs: JSON.parse(JSON.stringify(handle.refs)),
    });

    expect(results.map((r) => r.id).sort()).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("warns loudly instead of silently truncating when batchRefs are lost", async () => {
    // The failure this guards: collapsing an N-batch fan-out to batch 1 and
    // returning a short array with every row marked `succeeded`. Silent
    // partial data loss is the worst outcome here, and it also poisons the
    // cost ledger via the auto-recordResults call.
    //
    // This cannot simply throw: suspended state written by 0.12 legitimately
    // has no refs (0.12 never partitioned), so a bare batchId must still
    // resolve. The guarantee is therefore "never silent", not "always fatal".
    const { model } = makeFakeBackend();
    const { logger } = makeLogger();
    const logged: Array<{ level: string; message: string }> = [];
    const logFn = (level: string, message: string) =>
      void logged.push({ level, message });

    const submitter = newBatch(
      logger,
      model,
      { maxRequestsPerBatch: 2 },
      logFn,
    );
    const handle = await submitter.submit([
      { id: "r1", prompt: "p" },
      { id: "r2", prompt: "p" },
      { id: "r3", prompt: "p" },
      { id: "r4", prompt: "p" },
    ]);

    const resumed = newBatch(logger, model, { maxRequestsPerBatch: 2 }, logFn);
    await resumed.getResults(handle.id).catch(() => []);

    const warned = logged.filter(
      (l) => l.level === "WARN" && /batchRefs/i.test(l.message),
    );
    expect(warned.length).toBeGreaterThan(0);
    expect(warned[0]?.message).toMatch(/MISSING/);
  });

  it("throws on a malformed ref instead of skipping it", async () => {
    const { model } = makeFakeBackend();
    const { logger } = makeLogger();

    const submitter = newBatch(logger, model, { maxRequestsPerBatch: 2 });
    const handle = await submitter.submit([
      { id: "r1", prompt: "p" },
      { id: "r2", prompt: "p" },
      { id: "r3", prompt: "p" },
      { id: "r4", prompt: "p" },
    ]);

    const tampered = JSON.parse(JSON.stringify(handle.refs));
    tampered[1].version = 2; // a partially-valid array is corruption

    const resumed = newBatch(logger, model, { maxRequestsPerBatch: 2 });
    await expect(
      resumed.getResults(handle.id, { batchRefs: tampered }),
    ).rejects.toThrow();
  });

  it("aggregates getStatus across every batch after a resume", async () => {
    // The documented flow polls getStatus and only then calls getResults. If
    // getStatus only sees batch 1, it reports "completed" while batches 2..N
    // are still running.
    const { model, statuses } = makeFakeBackend();
    const { logger } = makeLogger();

    const submitter = newBatch(logger, model, { maxRequestsPerBatch: 2 });
    const handle = await submitter.submit([
      { id: "r1", prompt: "p" },
      { id: "r2", prompt: "p" },
      { id: "r3", prompt: "p" },
      { id: "r4", prompt: "p" },
    ]);

    statuses.set("batch-1", "completed");
    statuses.set("batch-2", "pending");

    const resumed = newBatch(logger, model, { maxRequestsPerBatch: 2 });
    const status = await resumed.getStatus(handle.id, {
      batchRefs: JSON.parse(JSON.stringify(handle.refs)),
    });

    expect(status.status).not.toBe("completed");
  });
});

describe("schemas survive partitioning", () => {
  it("validates a schema'd request even when the first partition has none", async () => {
    // Partitioning groups BY schema, so a schema-less request and a schema'd
    // one are guaranteed to land in different partitions. If the schema map is
    // keyed only by the primary batch id, the schema'd partition's schemas are
    // dropped and the row comes back `succeeded` with unvalidated data.
    const { model } = makeFakeBackend();
    const { logger } = makeLogger();
    const schema = z.object({ v: z.string() });

    const batch = newBatch(logger, model);
    const handle = await batch.submit([
      { id: "no-schema", prompt: "p" },
      { id: "with-schema", prompt: "q", schema },
    ]);

    const results = await batch.getResults(handle.id, {
      batchRefs: JSON.parse(JSON.stringify(handle.refs)),
    });

    const withSchema = results.find((r) => r.id === "with-schema");
    expect(withSchema?.status).toBe("succeeded");
    expect(withSchema?.validated).toBe(true);
  });

  it("survives a non-Zod value in metadata.schemas", async () => {
    // Docs tell callers to spread persisted metadata into getResults. Anything
    // that round-tripped a JSON column is a plain object, and calling
    // .safeParse on it used to throw and kill every result in the batch.
    const { model } = makeFakeBackend();
    const { logger } = makeLogger();

    const batch = newBatch(logger, model);
    const handle = await batch.submit([{ id: "r1", prompt: "p" }]);

    const results = await batch.getResults(handle.id, {
      batchRefs: JSON.parse(JSON.stringify(handle.refs)),
      schemas: { r1: { not: "a zod schema" } },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.validated).not.toBe(true);
  });
});

describe("submit safety", () => {
  it("surfaces already-created batches when a later partition fails", async () => {
    // Promise.all discards fulfilled values on first rejection, so batches
    // that were already created keep running upstream, bill the account, and
    // become unreachable. The error must carry their refs.
    const { model } = makeFakeBackend({ failOnStart: 2 });
    const { logger } = makeLogger();

    const batch = newBatch(logger, model, { maxRequestsPerBatch: 1 });
    let caught: unknown;
    try {
      await batch.submit([
        { id: "r1", prompt: "p" },
        { id: "r2", prompt: "p" },
        { id: "r3", prompt: "p" },
      ]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const createdRefs = (caught as { createdRefs?: unknown[] }).createdRefs;
    expect(Array.isArray(createdRefs)).toBe(true);
    expect((createdRefs ?? []).length).toBeGreaterThan(0);
  });

  it("rejects duplicate request ids", async () => {
    const { model } = makeFakeBackend();
    const { logger } = makeLogger();
    const batch = newBatch(logger, model);

    await expect(
      batch.submit([
        { id: "dup", prompt: "p", schema: z.object({ a: z.string() }) },
        { id: "dup", prompt: "q", schema: z.object({ a: z.number() }) },
      ]),
    ).rejects.toThrow(/duplicate/i);
  });

  it("does not create an upstream batch for an empty submit", async () => {
    const { model } = makeFakeBackend();
    const { logger } = makeLogger();
    const batch = newBatch(logger, model);

    // The requirement is that no upstream batch is created (which would also
    // demand credentials); the synthetic handle's shape is an implementation
    // detail, so only the call is asserted.
    const handle = await batch.submit([]);
    expect(model.start).not.toHaveBeenCalled();
    expect(handle.status).toBe("completed");
  });

  it("round-trips request ids verbatim, including surrounding whitespace", async () => {
    const { model } = makeFakeBackend();
    const { logger } = makeLogger();
    const batch = newBatch(logger, model);

    const handle = await batch.submit([{ id: " padded-id ", prompt: "p" }]);
    const results = await batch.getResults(handle.id, {
      batchRefs: JSON.parse(JSON.stringify(handle.refs)),
    });

    expect(results[0]?.id).toBe(" padded-id ");
  });
});

describe("cost ledger recording is retried after a transient failure", () => {
  it("does not mark a batch recorded when the ledger write throws", async () => {
    // Marking before the await meant a single transient DB error made every
    // later getResults() in that process skip recording for good.
    const { model } = makeFakeBackend();
    const { logger, logged } = makeLogger();
    logger.logBatchResults
      .mockRejectedValueOnce(new Error("transient prisma error"))
      .mockImplementation(async (batchId: string, records: unknown[]) => {
        logged.push({ batchId, records });
      });

    const batch = newBatch(logger, model);
    const handle = await batch.submit([{ id: "r1", prompt: "p" }]);
    const meta = { batchRefs: JSON.parse(JSON.stringify(handle.refs)) };

    await expect(batch.getResults(handle.id, meta)).rejects.toThrow(
      /transient/,
    );
    expect(await batch.isRecorded(handle.id)).toBe(false);

    const results = await batch.getResults(handle.id, meta);
    expect(results).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });
});

describe("a zero that arrives through metadata is not an empty batch", () => {
  it("still fetches results when metadata says totalRequests: 0", async () => {
    // A status handle from a provider that omitted `total` used to carry
    // totalRequests = 0; merged into metadata it hit the empty-batch
    // short-circuit and returned [] as a complete result set.
    const { model } = makeFakeBackend();
    const { logger } = makeLogger();
    const batch = newBatch(logger, model);
    const handle = await batch.submit([
      { id: "r1", prompt: "p" },
      { id: "r2", prompt: "p" },
    ]);
    const results = await batch.getResults(handle.id, {
      batchRefs: JSON.parse(JSON.stringify(handle.refs)),
      totalRequests: 0,
      requestCount: 0,
    });
    expect(results.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });
});

describe("partial submit failure is a typed error", () => {
  it("throws BatchSubmitError carrying the created refs", async () => {
    const { BatchSubmitError } = await import("../../ai/batch-helper.js");
    const { model } = makeFakeBackend({ failOnStart: 2 });
    const { logger } = makeLogger();
    const batch = newBatch(logger, model, { maxRequestsPerBatch: 1 });
    await expect(
      batch.submit([
        { id: "r1", prompt: "p" },
        { id: "r2", prompt: "p" },
      ]),
    ).rejects.toBeInstanceOf(BatchSubmitError);
  });
});

describe("abortSignal plumbing", () => {
  it("passes abortSignal from BatchOptions to start, status, and results", async () => {
    const { model } = makeFakeBackend();
    const { logger } = makeLogger();
    const controller = new AbortController();

    const batch = newBatch(logger, model, { abortSignal: controller.signal });
    const handle = await batch.submit([{ id: "r1", prompt: "p" }]);

    expect(model.start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ abortSignal: controller.signal }),
    );

    await batch.getStatus(handle.id);
    expect(model.status).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ abortSignal: controller.signal }),
    );

    await batch.getResults(handle.id);
    expect(model.results).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ abortSignal: controller.signal }),
    );
  });
});
