/**
 * Claim-check spilling for durable step results.
 *
 * A result above the soft threshold lives in the blob store and the ledger
 * row keeps only a reference — transparently, so the stage that stored it
 * reads the whole value back on replay.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../../core/workflow.js";
import { SpilledPayloadUnavailableError } from "../../kernel/errors.js";
import {
  createPayloadSpill,
  isSpillRef,
  stepSpillPrefix,
  withStepResultSpill,
} from "../../kernel/spill.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryBlobStore } from "../../kernel/testing/in-memory-blob-store.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestHarness } from "../../testing/index.js";

function ledgerSetup() {
  const clock = new FakeClock();
  const blobStore = new InMemoryBlobStore();
  const ledger = new InMemoryStepLedger({ now: () => clock.now() });
  const spill = createPayloadSpill({ blobStore, thresholdBytes: 1000 });
  return { blobStore, ledger, spilled: withStepResultSpill(ledger, spill) };
}

const RUNNING_RUN_STEP = {
  stageRecordId: "stage-1",
  stepId: "big",
  seq: 1,
  kind: "run",
  status: "running",
  attempt: 1,
  leaseExpiresAt: null,
  deadlineAt: null,
} as const;

describe("payload spill: codec", () => {
  it("keeps a value at or below the threshold inline", async () => {
    const blobStore = new InMemoryBlobStore();
    const spill = createPayloadSpill({ blobStore, thresholdBytes: 1000 });
    const value = { a: "x".repeat(10) };

    const packed = await spill.pack("k", value);

    expect(packed).toEqual(value);
    expect(isSpillRef(packed)).toBe(false);
    expect(await blobStore.list("")).toEqual([]);
  });

  it("spills a value above the threshold and returns a claim check", async () => {
    const blobStore = new InMemoryBlobStore();
    const spill = createPayloadSpill({ blobStore, thresholdBytes: 1000 });
    const original = { a: "x".repeat(5000) };

    const ref = await spill.pack("k", original);

    expect(isSpillRef(ref)).toBe(true);
    if (isSpillRef(ref)) {
      expect(ref.key).toBe("k");
      expect(ref.bytes).toBeGreaterThan(5000);
    }
    expect(await blobStore.get("k")).toEqual(original);
    expect(await spill.unpack(ref)).toEqual(original);
  });

  it("passes null, undefined and a non-ref value through unpack unchanged", async () => {
    const blobStore = new InMemoryBlobStore();
    const spill = createPayloadSpill({ blobStore, thresholdBytes: 1000 });

    expect(await spill.unpack(null)).toBeNull();
    expect(await spill.unpack(undefined)).toBeUndefined();
    const nonRef = { hello: "world", count: 42 };
    expect(await spill.unpack(nonRef)).toEqual(nonRef);
  });

  it("an infinite threshold stops spilling but still resolves existing refs", async () => {
    const blobStore = new InMemoryBlobStore();
    const bounded = createPayloadSpill({ blobStore, thresholdBytes: 1000 });
    const big = { text: "x".repeat(5000) };
    const ref = await bounded.pack("k", big);
    expect(isSpillRef(ref)).toBe(true);

    const unbounded = createPayloadSpill({
      blobStore,
      thresholdBytes: Number.POSITIVE_INFINITY,
    });

    const notSpilled = await unbounded.pack("k2", big);
    expect(notSpilled).toEqual(big);
    expect(isSpillRef(notSpilled)).toBe(false);
    expect(await unbounded.unpack(ref)).toEqual(big);
  });

  it("throws SpilledPayloadUnavailableError naming the key when the blob is gone", async () => {
    const wrote = createPayloadSpill({
      blobStore: new InMemoryBlobStore(),
      thresholdBytes: 1000,
    });
    const ref = await wrote.pack("missing-blob-key", {
      text: "x".repeat(5000),
    });

    // Another process, pointed at a different store.
    const reads = createPayloadSpill({
      blobStore: new InMemoryBlobStore(),
      thresholdBytes: 1000,
    });

    await expect(reads.unpack(ref)).rejects.toBeInstanceOf(
      SpilledPayloadUnavailableError,
    );
    await expect(reads.unpack(ref)).rejects.toThrow(/share one BlobStore/);
    await expect(reads.unpack(ref)).rejects.toThrow("missing-blob-key");
  });
});

describe("payload spill: step ledger", () => {
  it("a large result is a reference in the row and the value to the reader", async () => {
    const { blobStore, ledger, spilled } = ledgerSetup();
    await spilled.claim({ ...RUNNING_RUN_STEP });

    const big = { text: "y".repeat(5000) };
    const updated = await spilled.update("stage-1", "big", {
      status: "completed",
      result: big,
      leaseExpiresAt: null,
    });

    expect(updated.result).toEqual(big);
    // The row itself holds only the claim check.
    const raw = await ledger.get("stage-1", "big");
    expect(isSpillRef(raw?.result)).toBe(true);
    expect(await blobStore.list(stepSpillPrefix("stage-1"))).toHaveLength(1);
    // Every read path resolves it.
    expect((await spilled.get("stage-1", "big"))?.result).toEqual(big);
    expect((await spilled.list("stage-1"))[0]?.result).toEqual(big);
  });

  it("a small result is untouched in the row", async () => {
    const { blobStore, ledger, spilled } = ledgerSetup();
    await spilled.claim({ ...RUNNING_RUN_STEP, stepId: "small" });

    const small = { text: "short" };
    await spilled.update("stage-1", "small", {
      status: "completed",
      result: small,
      leaseExpiresAt: null,
    });

    const raw = await ledger.get("stage-1", "small");
    expect(raw?.result).toEqual(small);
    expect(isSpillRef(raw?.result)).toBe(false);
    expect(await blobStore.list("")).toEqual([]);
  });

  it("clear removes the spilled blobs as well as the rows", async () => {
    const { blobStore, ledger, spilled } = ledgerSetup();
    await spilled.claim({ ...RUNNING_RUN_STEP });
    await spilled.update("stage-1", "big", {
      status: "completed",
      result: { text: "y".repeat(5000) },
      leaseExpiresAt: null,
    });
    expect(await blobStore.list(stepSpillPrefix("stage-1"))).toHaveLength(1);

    await spilled.clear("stage-1");

    expect(await ledger.list("stage-1")).toEqual([]);
    expect(await blobStore.list(stepSpillPrefix("stage-1"))).toEqual([]);
  });

  it("clearExcept keeps the spilled blob of a preserved row and drops the rest", async () => {
    // Re-running a terminally failed stage preserves the rows naming an
    // external effect and re-opens them, so a preserved row's last result
    // must stay readable — including when it was spilled.
    const { blobStore, ledger, spilled } = ledgerSetup();
    expect(spilled.clearExcept).toBeTypeOf("function");
    for (const stepId of ["keep", "drop"]) {
      await spilled.claim({ ...RUNNING_RUN_STEP, stepId });
      await spilled.update("stage-1", stepId, {
        status: "completed",
        result: { text: `${stepId}-${"y".repeat(5000)}` },
        leaseExpiresAt: null,
      });
    }
    expect(await blobStore.list(stepSpillPrefix("stage-1"))).toHaveLength(2);

    await spilled.clearExcept?.("stage-1", ["keep"]);

    expect((await ledger.list("stage-1")).map((r) => r.stepId)).toEqual([
      "keep",
    ]);
    expect(await blobStore.list(stepSpillPrefix("stage-1"))).toHaveLength(1);
    expect(await spilled.get("stage-1", "keep")).toMatchObject({
      result: { text: `keep-${"y".repeat(5000)}` },
    });
  });
});

describe("payload spill: end to end through the kernel", () => {
  it("a step result over the default threshold lives in the blob store and the stage still reads all of it", async () => {
    const In = z.object({});
    const workflow = defineWorkflow("step-spill-e2e", { input: In })
      .stage("stage-1", {
        schemas: {
          input: In,
          output: z.object({ length: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const big = await ctx.step.run("big", async () => ({
            text: "z".repeat(70_000),
          }));
          return { output: { length: big.text.length } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    const result = await harness.run<{ length: number }>("step-spill-e2e", {});

    expect(result.status).toBe("COMPLETED");
    expect(result.output?.length).toBe(70_000);

    const stages = await harness.persistence.getStagesByRun(
      result.workflowRunId,
    );
    expect(stages).toHaveLength(1);

    // The row the kernel wrote carries a reference, not 70 KB of text.
    const raw = await harness.stepLedger.get(stages[0]!.id, "big");
    expect(isSpillRef(raw?.result)).toBe(true);
    expect(
      await harness.blobStore.list("workflow-v2/spill/steps/"),
    ).toHaveLength(1);
  });

  it("a replay reads a spilled run result and a spilled waitFor result back from the ledger", async () => {
    const In = z.object({});
    let bodyRuns = 0;
    let polls = 0;
    const workflow = defineWorkflow("step-spill-replay", { input: In })
      .stage("stage-1", {
        schemas: {
          input: In,
          output: z.object({ runLength: z.number(), waitLength: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const big = await ctx.step.run("big", async () => {
            bodyRuns++;
            return { text: "r".repeat(2_000) };
          });
          // Not ready on the first poll, so the stage suspends and the
          // replay must answer `big` from the ledger — through the
          // reference, not the body.
          const status = await ctx.step.waitFor("poll", {
            poll: async () => ({ ready: ++polls > 1, text: "w".repeat(2_000) }),
            ready: (value) => value.ready,
            every: "1s",
            timeout: "1m",
          });
          return {
            output: {
              runLength: big.text.length,
              waitLength: status.text.length,
            },
          };
        },
      })
      .build();

    const harness = createTestHarness({
      workflows: [workflow],
      spillThresholdBytes: 1_000,
    });
    const result = await harness.run<{ runLength: number; waitLength: number }>(
      "step-spill-replay",
      {},
    );

    expect(result.status).toBe("COMPLETED");
    expect(bodyRuns).toBe(1);
    expect(polls).toBe(2);
    expect(result.output).toEqual({ runLength: 2_000, waitLength: 2_000 });
    const [stage] = await harness.persistence.getStagesByRun(
      result.workflowRunId,
    );
    expect(
      isSpillRef((await harness.stepLedger.get(stage!.id, "big"))?.result),
    ).toBe(true);
    expect(
      isSpillRef((await harness.stepLedger.get(stage!.id, "poll"))?.result),
    ).toBe(true);
    // Two rows, two blobs, under one prefix per stage record.
    expect(
      await harness.blobStore.list(stepSpillPrefix(stage!.id)),
    ).toHaveLength(2);
  });

  it("a redrive that clears the ledger removes the spilled blobs of the dropped rows", async () => {
    const In = z.object({});
    let failing = true;
    const workflow = defineWorkflow("step-spill-redrive", { input: In })
      .stage("stage-1", {
        schemas: {
          input: In,
          output: z.object({ length: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const big = await ctx.step.run("big", async () => ({
            text: "z".repeat(2_000),
          }));
          if (failing) throw new Error("not yet");
          return { output: { length: big.text.length } };
        },
      })
      .build();

    const harness = createTestHarness({
      workflows: [workflow],
      spillThresholdBytes: 1_000,
    });
    // Every job attempt replays `big` from the spilled blob; the run fails
    // once the transport's attempt budget is spent.
    const failed = await harness.run("step-spill-redrive", {});
    expect(failed.status).toBe("FAILED");
    const [before] = await harness.persistence.getStagesByRun(
      failed.workflowRunId,
    );
    expect(
      await harness.blobStore.list(stepSpillPrefix(before!.id)),
    ).toHaveLength(1);

    failing = false;
    await harness.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: failed.workflowRunId,
      from: { kind: "start" },
    });
    // The superseded stage record's rows are cleared, and its blobs with them.
    expect(
      await harness.blobStore.list(stepSpillPrefix(before!.id)),
    ).toHaveLength(0);

    await harness.tickUntil(async () => {
      const run = await harness.persistence.getRun(failed.workflowRunId);
      return run?.status === "COMPLETED";
    });
    const [second] = await harness.persistence.getStagesByRun(
      failed.workflowRunId,
    );
    expect(second!.id).not.toBe(before!.id);
    expect(
      await harness.blobStore.list(stepSpillPrefix(second!.id)),
    ).toHaveLength(1);
  });
});
