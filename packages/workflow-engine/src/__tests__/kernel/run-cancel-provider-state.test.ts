/**
 * run.cancel against a stateful provider.
 *
 * The real `ctx.step.ai.map`, `AIBatchImpl`, Gemini transport and installed AI
 * SDK run unchanged; only provider HTTP is replaced by a fake `fetch` that
 * tracks every batch (creation, listing, retrieval, cancellation) and can make
 * a cancel asynchronous (the batch keeps listing as running until settled), so
 * the races between a cancel sweep, a redrive and a submit are driven through
 * `kernel.dispatch` with barriers, not sleeps.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveAiSdkBatchModel } from "../../ai/batch/ai-sdk.js";
import { defineStage } from "../../core/stage-factory.js";
import { StageAbortedError } from "../../core/steps.js";
import {
  BATCH_MODEL,
  createAiMapHarness,
  createBatchAwareFactory,
} from "../durable/ai-map-harness.js";
import { createMockAIHelperFactory } from "../utils/index.js";

const schema = z.object({});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface FakeBatch {
  name: string;
  metadata: { state: string; displayName: string };
  done: boolean;
}

/** One stage mapping `count` items through Gemini batches of one request each. */
async function provider(id: string, count = 1) {
  const live = new Map<string, FakeBatch>();
  const calls: string[] = [];
  let created = 0;
  let beforeStart: (() => Promise<void>) | undefined;
  let beforeCancel: (() => Promise<void>) | undefined;
  let rejectStart = 0;
  let asyncCancel = false;
  const failCancels = new Set<string>();
  const unavailable = () =>
    Response.json(
      { error: { message: "unavailable", status: "UNAVAILABLE", code: 503 } },
      { status: 503 },
    );

  const model = await resolveAiSdkBatchModel("google", "gemini-2.5-flash", {
    apiKey: "test",
    fetch: (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      if (method === "POST" && url.pathname.endsWith(":batchGenerateContent")) {
        created += 1;
        await beforeStart?.();
        if (created === rejectStart) return unavailable();
        const batch: FakeBatch = {
          name: `batches/b${created}`,
          metadata: {
            state: "JOB_STATE_RUNNING",
            displayName: JSON.parse(String(init?.body)).batch.displayName,
          },
          done: false,
        };
        live.set(batch.name, batch);
        return Response.json(batch);
      }
      if (method === "POST" && url.pathname.endsWith(":cancel")) {
        if (failCancels.has(url.pathname)) return unavailable();
        await beforeCancel?.();
        if (!asyncCancel) {
          live.get(
            url.pathname.replace("/v1beta/", "").replace(":cancel", ""),
          )!.metadata.state = "JOB_STATE_CANCELLED";
        }
        return Response.json({});
      }
      if (url.pathname === "/v1beta/batches") {
        return Response.json({ operations: [...live.values()].reverse() });
      }
      const batch = live.get(url.pathname.replace("/v1beta/", ""));
      if (!batch) throw new Error(`Unexpected HTTP ${url.pathname}`);
      return Response.json(batch);
    }) as typeof fetch,
  });

  const stage = defineStage({
    id,
    name: id,
    schemas: { input: schema, output: schema, config: schema },
    async execute(ctx) {
      await ctx.step.ai.map(
        "x",
        Array.from({ length: count }, (_, i) => i),
        {
          model: BATCH_MODEL,
          policy: "batch",
          prompt: (i) => String(i),
          batch: { options: { maxRequestsPerBatch: 1 }, pollEvery: "1s" },
        },
      );
      return { output: {} };
    },
  });
  const mock = createMockAIHelperFactory();
  const h = await createAiMapHarness({
    stage,
    inputSchema: schema,
    outputSchema: schema,
    input: {},
    mock,
    aiFactory: createBatchAwareFactory(mock, model),
    batchModels: () => model,
  });
  const states = () => [...live.values()].map((b) => b.metadata.state);
  return {
    ...h,
    live,
    calls,
    cancelPosts: () => calls.filter((c) => c.endsWith(":cancel")).length,
    states,
    submitRow: async () => h.ledger.get((await h.stage())!.id, "x:submit"),
    cancel: () =>
      h.kernel.dispatch({
        type: "run.cancel",
        workflowRunId: h.workflowRunId,
      }),
    redrive: () =>
      h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
      }),
    run: () => h.persistence.getRun(h.workflowRunId),
    warnings: () =>
      h.persistence.getAllLogs().filter((l) => l.level === "WARN"),
    setBeforeStart: (fn: () => Promise<void>) => {
      beforeStart = fn;
    },
    setBeforeCancel: (fn: () => Promise<void>) => {
      beforeCancel = fn;
    },
    rejectStart: (n: number) => {
      rejectStart = n;
    },
    cancelAsynchronously: () => {
      asyncCancel = true;
    },
    failCancel: (path: string) => failCancels.add(path),
  };
}

describe("a cancel sweep held up past a redrive", () => {
  it("does not cancel the batch of the run that is RUNNING again", async () => {
    const h = await provider("sweep-race");
    await h.execute();
    // Hold the first cancel after the job purge and before it reads the ledger.
    const entered = barrier();
    const go = barrier();
    const purge = h.jobTransport.cancelByRun.bind(h.jobTransport);
    h.jobTransport.cancelByRun = async (id) => {
      await purge(id);
      entered.release();
      await go.promise;
      return 0;
    };
    const cancelling = h.cancel();
    await entered.promise;
    await h.redrive();
    await h.execute();
    expect((await h.run())?.status).toBe("RUNNING");

    go.release();
    const result = await cancelling;

    expect(result.batches).toEqual([]);
    expect(h.states()).toEqual(["JOB_STATE_RUNNING"]);
    expect(h.cancelPosts()).toBe(0);
    // The redriven run keeps waiting on its live batch.
    expect((await h.submitRow())?.status).toBe("completed");
  });

  it("holds the submit step while it calls the provider, so a redrive made in between waits instead of proceeding with the handle", async () => {
    const h = await provider("sweep-lease");
    await h.execute();
    const sending = barrier();
    const go = barrier();
    h.setBeforeCancel(async () => {
      sending.release();
      await go.promise;
    });
    const cancelling = h.cancel();
    await sending.promise;
    // The sweep holds the row (leased, fenced) and has checked the run: the
    // redrive and its replay come after that check and before the call lands.
    expect((await h.submitRow())?.status).toBe("running");
    await h.redrive();
    // The reset leaves the sweep's lease alone.
    expect((await h.submitRow())?.leaseExpiresAt).not.toBeNull();
    const before = h.calls.length;
    const outcome = await h.execute();

    // The replay met an executing step: it neither polled nor adopted the
    // batch the sweep is cancelling.
    expect(outcome).toMatchObject({ outcome: "suspended" });
    expect(h.calls.slice(before)).toEqual([]);
    go.release();
    const result = await cancelling;
    expect(result.batches).toEqual([
      expect.objectContaining({ status: "cancelled" }),
    ]);

    // Released with the tombstone: the next replay creates a new batch.
    await h.tick(6000);
    expect(h.states()).toEqual(["JOB_STATE_CANCELLED", "JOB_STATE_RUNNING"]);
    expect((await h.submitRow())?.result).toMatchObject({
      handleId: "batches/b2",
      generation: 1,
      cancelledBatchIds: ["batches/b1"],
    });
    expect((await h.stage())?.status).toBe("SUSPENDED");
  });

  it("restores the row untouched when the run moved on before the provider call", async () => {
    const h = await provider("sweep-restore");
    await h.execute();
    const original = await h.submitRow();
    // The redrive lands after the sweep took hold of the row and before its
    // generation check: the check sees it and the row goes back as it was.
    const real = h.persistence.getRun.bind(h.persistence);
    let reads = 0;
    h.persistence.getRun = async (id) => {
      const run = await real(id);
      reads += 1;
      // Read 1: handler. Read 2: sweep start. Read 3: before taking hold.
      // Read 4: after taking hold. Redrive just before it.
      if (reads === 4) await h.redrive();
      return reads === 4 ? await real(id) : run;
    };

    const result = await h.cancel();

    expect(result.batches).toEqual([]);
    expect(h.cancelPosts()).toBe(0);
    expect(h.states()).toEqual(["JOB_STATE_RUNNING"]);
    const row = await h.submitRow();
    expect(row?.status).toBe("completed");
    expect(row?.leaseExpiresAt).toBeNull();
    expect(row?.result).toEqual(original?.result);
  });
});

describe("a submit that is rejected after some partitions were accepted", () => {
  it("cancels the accepted partitions when the run was cancelled meanwhile", async () => {
    const h = await provider("partial-cancel", 2);
    const abort = new AbortController();
    h.rejectStart(2);
    let starts = 0;
    h.setBeforeStart(async () => {
      starts += 1;
      if (starts === 2) {
        await h.cancel();
        abort.abort(new StageAbortedError("cancelled", h.workflowRunId));
      }
    });

    await h.kernel.dispatch({
      type: "job.execute",
      workflowId: "wf-partial-cancel",
      workflowRunId: h.workflowRunId,
      stageId: "partial-cancel",
      config: {},
      abortSignal: abort.signal,
    });

    expect(h.states()).toEqual(["JOB_STATE_CANCELLED"]);
    // The row keeps the accepted partition, cancelled, so a redrive replaces it.
    const row = await h.submitRow();
    expect(row?.status).toBe("failed");
    expect(row?.result).toMatchObject({
      partial: true,
      refs: [expect.objectContaining({ id: "batches/b1" })],
      cancelledBatchIds: ["batches/b1"],
      engineCancelled: { attempt: row?.attempt, generation: 1 },
    });
    // Repeating the cancel finds nothing outstanding and sends nothing.
    const posts = h.cancelPosts();
    const again = await h.cancel();
    expect(again.batches.map((b) => b.status)).toEqual(["cancelled"]);
    expect(h.cancelPosts()).toBe(posts);
  });

  it("records them when the run was not cancelled, and a later run.cancel cancels them", async () => {
    const h = await provider("partial-record", 2);
    h.rejectStart(2);

    await h.execute();

    expect((await h.stage())?.status).toBe("FAILED");
    const row = await h.submitRow();
    expect(row?.status).toBe("failed");
    expect(row?.result).toMatchObject({
      partial: true,
      refs: [expect.objectContaining({ id: "batches/b1" })],
    });

    const result = await h.cancel();

    expect(result.batches).toEqual([
      expect.objectContaining({
        stepId: "x:submit",
        status: "cancelled",
        ref: expect.objectContaining({ id: "batches/b1" }),
      }),
    ]);
    expect(h.states()).toEqual(["JOB_STATE_CANCELLED"]);
  });

  it("resumes after the accepted partitions instead of creating them twice", async () => {
    const h = await provider("partial-resume", 2);
    h.rejectStart(2);
    await h.execute();
    expect(h.states()).toEqual(["JOB_STATE_RUNNING"]);

    // The retry: the reopened step finds its record and creates partition 2 only.
    await h.execute();

    // (Batch 2 is the rejected creation, which the provider never kept.)
    expect(h.live.size).toBe(2);
    expect(h.states()).toEqual(["JOB_STATE_RUNNING", "JOB_STATE_RUNNING"]);
    expect((await h.submitRow())?.result).toMatchObject({
      refs: [
        expect.objectContaining({ id: "batches/b1" }),
        expect.objectContaining({ id: "batches/b3" }),
      ],
    });
    expect((await h.submitRow())?.result).not.toHaveProperty("partial");
  });
});

describe("a submit step that holds no batch handle", () => {
  it("is reported by run.cancel with its external key, not skipped", async () => {
    const h = await provider("unrecorded");
    h.rejectStart(1);
    await h.execute();
    const row = await h.submitRow();
    // Failed with no submit record, no handle.
    expect(row).toMatchObject({ status: "failed" });
    expect(row?.result ?? {}).not.toHaveProperty("handleId");

    const result = await h.cancel();

    expect(result.batches).toEqual([
      {
        stageId: "unrecorded",
        stepId: "x:submit",
        externalKey: row?.externalKey,
        status: "unrecorded",
      },
    ]);
    const warning = h
      .warnings()
      .find((w) => /holds no batch handle/.test(w.message));
    expect(warning?.message).toContain(row!.externalKey!);
  });
});

describe("a batch listed by more than one owner", () => {
  it("is cancelled once and every owning row is still finalised", async () => {
    const h = await provider("dedup");
    await h.execute();
    const stage = (await h.stage())!;
    const row = (await h.ledger.get(stage.id, "x:submit"))!;
    // The same batch, also declared in the stage's suspendedState.
    await h.persistence.updateStage(stage.id, {
      suspendedState: {
        ...(stage.suspendedState as object),
        metadata: {
          ...(stage.suspendedState as { metadata?: object })?.metadata,
          batchRefs: (row.result as { refs: unknown[] }).refs,
        },
      },
    });

    const result = await h.cancel();

    // One entry per owner: the stage's suspendedState, then the submit row.
    expect(result.batches.map((b) => [b.stepId, b.status])).toEqual([
      [undefined, "cancelled"],
      ["x:submit", "cancelled"],
    ]);
    expect(h.cancelPosts()).toBe(1);
    // The durable row was not dropped by the de-duplication: it carries the
    // tombstone, so the redrive creates a new batch.
    expect((await h.submitRow())?.result).toMatchObject({
      engineCancelled: { generation: 1 },
    });
    await h.redrive();
    await h.execute();
    expect(h.live.size).toBe(2);
    expect((await h.stage())?.status).toBe("SUSPENDED");
  });
});

describe("a step that is not the engine's batch submit", () => {
  it("is not cancelled just because its result looks like a submit record", async () => {
    const ref = {
      version: 1 as const,
      type: "text" as const,
      id: "batches/b9",
      provider: "google.generative-ai",
      modelId: "gemini-2.5-flash",
    };
    const stage = defineStage({
      id: "ordinary-handle",
      name: "ordinary-handle",
      schemas: { input: schema, output: schema, config: schema },
      async execute(ctx) {
        await ctx.step.run("x:submit", async () => ({
          handleId: ref.id,
          refs: [ref],
          requestIds: ["r"],
          totalRequests: 1,
        }));
        await ctx.step.sleep("wait", "1h");
        return { output: {} };
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema: schema,
      outputSchema: schema,
      input: {},
      batchModels: () => {
        throw new Error("no provider call may be made");
      },
    });
    await h.execute();

    const result = await h.kernel.dispatch({
      type: "run.cancel",
      workflowRunId: h.workflowRunId,
    });

    expect(result.batches).toEqual([
      expect.objectContaining({
        stepId: "x:submit",
        status: "unverified",
        ref,
      }),
    ]);
    // Untouched: still completed, still its own result, not re-opened.
    const row = await h.ledger.get((await h.stage())!.id, "x:submit");
    expect(row?.status).toBe("completed");
    expect(
      h.persistence
        .getAllLogs()
        .some(
          (l) =>
            l.level === "WARN" && /cannot prove it created/.test(l.message),
        ),
    ).toBe(true);
  });

  it("is not cancelled when the record carries another step's ownership marker", async () => {
    const h = await provider("copied-marker");
    await h.execute();
    const stage = (await h.stage())!;
    const row = (await h.ledger.get(stage.id, "x:submit"))!;
    // A record copied from another step: its marker is not this row's key.
    await h.ledger.update(stage.id, "x:submit", {
      result: { ...(row.result as object), externalKey: "wfe-someone-else" },
    });

    const result = await h.cancel();

    expect(result.batches.map((b) => b.status)).toEqual(["unverified"]);
    expect(h.cancelPosts()).toBe(0);
    expect(h.states()).toEqual(["JOB_STATE_RUNNING"]);
  });

  it("is not cancelled when the record predates the ownership marker", async () => {
    const h = await provider("pre-release-record");
    await h.execute();
    const stage = (await h.stage())!;
    const row = (await h.ledger.get(stage.id, "x:submit"))!;
    const { externalKey: _key, ...older } = row.result as Record<
      string,
      unknown
    >;
    await h.ledger.update(stage.id, "x:submit", { result: older });

    const result = await h.cancel();

    expect(result.batches.map((b) => b.status)).toEqual(["unverified"]);
    expect(h.cancelPosts()).toBe(0);
  });
});

describe("a provider that cancels asynchronously", () => {
  it("never lets a redrive adopt a batch the engine cancelled", async () => {
    const h = await provider("async-cancel", 2);
    await h.execute();
    h.cancelAsynchronously();
    // Partition 2 ended on its own, so the row is not replaced wholesale and
    // the redrive searches the provider, where batch 1 still lists as running.
    h.live.get("batches/b2")!.metadata.state = "JOB_STATE_SUCCEEDED";

    const result = await h.cancel();
    expect(result.batches.map((b) => b.status)).toEqual([
      "cancelled",
      "already-terminal",
    ]);
    expect(h.states()).toEqual(["JOB_STATE_RUNNING", "JOB_STATE_SUCCEEDED"]);
    await h.redrive();
    await h.execute();

    // Partition 1 got a new batch (3); partition 2's ended batch was adopted.
    expect(h.live.size).toBe(3);
    const refs = (
      (await h.submitRow())?.result as { refs: Array<{ id: string }> }
    ).refs.map((r) => r.id);
    expect(refs).toEqual(["batches/b3", "batches/b2"]);
    expect((await h.submitRow())?.result).toMatchObject({
      cancelledBatchIds: ["batches/b1"],
    });
  });
});
