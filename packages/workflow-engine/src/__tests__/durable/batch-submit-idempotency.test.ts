/**
 * A reclaimed `${id}:submit` step must not create a second provider batch.
 *
 * The worker is killed the moment the ledger would have recorded the submit:
 * the provider has already created the batch, the row stays `running` with a
 * live lease, and the next worker finds the lease expired. Before the external
 * key existed that replay called `batch.submit` again and the first batch was
 * orphaned and still billed.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import type { StepLedger } from "../../kernel/ports.js";
import { createMockAIHelperFactory } from "../utils/index.js";
import {
  BATCH_MODEL,
  createAiMapHarness,
  createBatchAwareFactory,
  makeFakeBackend,
} from "./ai-map-harness.js";

const inputSchema = z.object({ count: z.number() });
const outputSchema = z.object({ done: z.number() });
const itemSchema = z.object({ v: z.string() });

/**
 * Emulate a worker that dies between the provider call and the ledger write.
 *
 * The provider has created the batch; the `complete()` that would record it
 * never returns, because the process is gone. The step row keeps its
 * `running` status and its original lease, which is exactly the state the
 * next worker meets after the lease reaper re-enqueues the job.
 */
function killWorkerOnSubmitCompletion(
  inner: StepLedger,
  stepId: string,
): StepLedger {
  let killed = false;
  return {
    claim: (record) => inner.claim(record),
    get: (stageRecordId, id) => inner.get(stageRecordId, id),
    update: (stageRecordId, id, patch) => {
      if (id === stepId && patch.status === "completed" && !killed) {
        killed = true;
        return new Promise<never>(() => {});
      }
      return inner.update(stageRecordId, id, patch);
    },
    compareAndSet: (stageRecordId, id, expected, patch) =>
      inner.compareAndSet(stageRecordId, id, expected, patch),
    list: (stageRecordId) => inner.list(stageRecordId),
    clear: (stageRecordId) => inner.clear(stageRecordId),
  };
}

async function setup(id: string, onReclaim?: "adopt" | "resubmit") {
  const mock = createMockAIHelperFactory();
  const backend = makeFakeBackend();
  const stage = defineStage({
    id,
    name: id,
    schemas: { input: inputSchema, output: outputSchema, config: z.object({}) },
    async execute(ctx) {
      const items = Array.from({ length: ctx.input.count }, (_, i) => i);
      const results = await ctx.step.ai.map("extract", items, {
        model: BATCH_MODEL,
        schema: itemSchema,
        policy: "batch",
        prompt: (item) => `Extract <<${item}>>`,
        batch: {
          pollEvery: "60s",
          timeout: "24h",
          ...(onReclaim ? { onReclaim } : {}),
        },
      });
      return { output: { done: results.length } };
    },
  });
  const harness = await createAiMapHarness({
    stage,
    inputSchema,
    outputSchema,
    input: { count: 3 },
    mock,
    wrapLedger: (ledger) =>
      killWorkerOnSubmitCompletion(ledger, "extract:submit"),
    aiFactory: createBatchAwareFactory(mock, backend.model),
  });
  return {
    ...harness,
    backend,
    /**
     * Start the stage and abandon it the moment the worker "dies": the
     * execute promise never settles, so it is dropped rather than awaited.
     */
    crash: async () => {
      void harness.execute().catch(() => {});
      // Let the submit reach the provider and the abandoned ledger write.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("reclaimed batch submit", () => {
  it("creates exactly one provider batch when the worker dies after submitting", async () => {
    const h = await setup("batch-submit-reclaim");

    // First worker: the provider creates the batch, then the worker dies
    // before the ledger records it.
    await h.crash();
    expect(h.backend.model.start).toHaveBeenCalledTimes(1);

    // The lease expires and the next worker replays the stage.
    await h.tick(6 * 60 * 1000);
    await h.execute();

    // Before the external key existed this was 2, and `batch-1` was orphaned
    // and still billed.
    expect(h.backend.model.start).toHaveBeenCalledTimes(1);
    expect([...h.backend.byBatch.keys()]).toEqual(["batch-1"]);
    expect(h.backend.adopted()).toHaveLength(1);
    expect(h.backend.adopted()[0]).toMatch(/^wfe-[0-9a-f]{32}-p0$/);
  });

  it("stamps the same external key on every replay of the submit", async () => {
    const h = await setup("batch-submit-key-stable");

    await h.crash();
    const firstKey = [...h.backend.byExternalKey.keys()][0];
    await h.tick(6 * 60 * 1000);
    await h.execute();

    expect(h.backend.adopted()).toEqual([firstKey]);
    const stage = await h.stage();
    const rows = await h.ledger.list(stage!.id);
    const submit = rows.find((r) => r.stepId === "extract:submit");
    expect(submit?.externalKey).toBe(`${firstKey}`.replace(/-p0$/, ""));
  });

  it("fails loudly rather than duplicating when the transport cannot adopt", async () => {
    const h = await setup("batch-submit-no-adopt");
    h.backend.setAdoptable(false);

    await h.crash();
    expect(h.backend.model.start).toHaveBeenCalledTimes(1);

    await h.tick(6 * 60 * 1000);
    await h.execute();
    expect(h.backend.model.start).toHaveBeenCalledTimes(1);
    const stage = await h.stage();
    expect(stage?.errorMessage).toMatch(
      /cannot be recovered after a worker crash/,
    );
  });

  it("resubmits (and bills twice) only when the caller opts in", async () => {
    const h = await setup("batch-submit-resubmit", "resubmit");
    h.backend.setAdoptable(false);

    await h.crash();
    expect(h.backend.model.start).toHaveBeenCalledTimes(1);

    await h.tick(6 * 60 * 1000);
    await h.execute();
    expect(h.backend.model.start).toHaveBeenCalledTimes(2);
  });
});
