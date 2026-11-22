/**
 * The real-transport harness of `run.cancel` recovery tests: the real
 * `ctx.step.ai.map`, `AIBatchImpl` and the installed AI SDK Gemini, Anthropic
 * and OpenAI transports, with only provider HTTP faked (a `fetch` that tracks
 * every batch). Runs on the in-memory ports, or on a Prisma database
 * (`kernelDatabase()`, SQLite or Postgres) when `database` is given.
 */

import { z } from "zod";
import { resolveAiSdkBatchModel } from "../../ai/batch/ai-sdk.js";
import type { EngineBatchModel } from "../../ai/batch/model.js";
import { defineStage } from "../../core/stage-factory.js";
import { StageAbortedError } from "../../core/steps.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import {
  BATCH_MODEL,
  createAiMapHarness,
  createBatchAwareFactory,
} from "../durable/ai-map-harness.js";
import type { kernelDatabase } from "../sqlite8-kernel-utils.js";
import { createMockAIHelperFactory } from "./index.js";

export type KernelDb = Awaited<ReturnType<typeof kernelDatabase>>;

type HarnessOptions = Parameters<typeof createAiMapHarness>[0];
type MemoryHarness = Awaited<ReturnType<typeof createAiMapHarness>>;

/**
 * `createAiMapHarness` on `db` when given: the same shape, with the database's
 * ports (each wrapped per scenario, so a test can override a method).
 */
export async function createHarness(
  db: KernelDb | undefined,
  o: HarnessOptions,
): Promise<MemoryHarness> {
  if (!db) return createAiMapHarness(o);
  const workflowId = `wf-${o.stage.id}`;
  const workflow = new WorkflowBuilder(
    workflowId,
    workflowId,
    "test",
    o.inputSchema,
    o.outputSchema,
  )
    .pipe(o.stage)
    .build();
  const clock = new FakeClock(new Date());
  const ledger = Object.create(db.stepLedger);
  // Keep the per-transaction read binding of the shipped ledger.
  const reads = (db.stepLedger as { transactionReads?: () => unknown })
    .transactionReads;
  if (reads) ledger.transactionReads = reads.bind(db.stepLedger);
  const persistence = Object.create(db.persistence);
  const jobTransport = Object.create(db.jobTransport);
  const kernel = db.makeKernel({
    clock,
    persistence,
    jobTransport,
    stepLedger: ledger,
    registry: {
      getWorkflow: (id) => (id === workflowId ? workflow : undefined),
    },
    services: {
      aiLogger: db.aiLogger,
      ...(o.aiFactory ? { ai: o.aiFactory } : {}),
      ...(o.batchModels ? { batchModels: o.batchModels } : {}),
      ...(o.batchCancelTimeouts
        ? { batchCancelTimeouts: o.batchCancelTimeouts }
        : {}),
    },
  });
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    workflowId,
    idempotencyKey: crypto.randomUUID(),
    input: o.input,
  });
  await kernel.dispatch({ type: "run.claimPending", workerId: "test-worker" });
  return {
    kernel,
    workflowRunId,
    clock,
    ledger,
    jobTransport,
    persistence,
    blobStore: db.blobStore,
    stage: () => persistence.getStage(workflowRunId, o.stage.id),
    execute: () =>
      kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId,
        stageId: o.stage.id,
        config: {},
      }),
    tick: async (ms = 1) => {
      clock.advance(ms);
      await kernel.dispatch({ type: "stage.pollSuspended" });
    },
  } as unknown as MemoryHarness;
}

const schema = z.object({});

export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export type Vendor = "google" | "anthropic" | "openai";

/** Where the process dies in the crash matrix. */
export type Point = "hold" | "intent" | "read" | "cancel" | "final";

export interface SetupOptions {
  /**
   * Run on this Prisma database (`kernelDatabase()`) instead of the
   * in-memory ports.
   */
  database?: KernelDb;
  count?: number;
  batchMs?: number;
  sweepMs?: number;
  itemId?: string;
  collision?: string;
  onReclaim?: "resubmit";
}

const MODEL_IDS: Record<Vendor, string> = {
  google: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
};

const anthropicResult = (id: string) =>
  JSON.stringify({
    custom_id: id,
    result: {
      type: "succeeded",
      message: {
        id: "msg_result",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  });

const openaiResult = (id: string) =>
  JSON.stringify({
    id: `req_${id}`,
    custom_id: id,
    response: {
      status_code: 200,
      request_id: `r_${id}`,
      body: {
        id: `resp_${id}`,
        created_at: 1,
        model: "gpt-4o",
        output: [
          {
            type: "message",
            role: "assistant",
            id: `msg_${id}`,
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    error: null,
  });

export async function setup(
  id: string,
  vendor: Vendor = "google",
  opts: SetupOptions = {},
) {
  const batches = new Map<string, any>();
  const requests = new Map<string, string[]>();
  const files = new Map<string, string[]>();
  /** Batches a cancel request reached: never live again. */
  const cancelReached = new Set<string>();
  const calls: string[] = [];
  let resolver: undefined | (() => Promise<EngineBatchModel>);
  let n = 0;
  let rejectStart = 0;
  let die = false;
  let asyncCancel = false;
  let failStatus = false;
  let failCancel = false;
  let afterStart: undefined | (() => Promise<void>);
  let beforeStart: undefined | (() => Promise<void>);
  let beforeCancel: undefined | (() => Promise<void>);
  // The crash matrix: once `dead`, every ledger write and provider call of
  // this process fails, exactly as if it had stopped.
  let killAt: Point | undefined;
  let dead = false;

  const unavailable = () =>
    Response.json(
      {
        error: {
          message: "unavailable",
          type: "overloaded_error",
          status: "UNAVAILABLE",
          code: 503,
        },
      },
      { status: 503 },
    );
  const keyOf = (path: string) =>
    vendor === "google"
      ? path.replace("/v1beta/", "").replace(":cancel", "")
      : vendor === "anthropic"
        ? path.replace("/v1/messages/batches/", "").replace("/cancel", "")
        : path.replace("/v1/batches/", "").replace("/cancel", "");
  const isCreate = (method: string, path: string) =>
    method === "POST" &&
    (path.endsWith(":batchGenerateContent") ||
      path === "/v1/messages/batches" ||
      path === "/v1/batches");
  const isCancel = (method: string, path: string) =>
    method === "POST" && (path.endsWith(":cancel") || path.endsWith("/cancel"));
  const markCancelling = (b: any) => {
    if (vendor === "google") b.metadata.state = "JOB_STATE_CANCELLED";
    else if (vendor === "anthropic") {
      b.processing_status = "canceling";
      b.cancel_initiated_at = "2026-01-01T00:05:00Z";
    } else b.status = "cancelling";
  };

  const model = await resolveAiSdkBatchModel(vendor, MODEL_IDS[vendor], {
    apiKey: "test",
    fetch: (async (input: any, init: any) => {
      if (dead) throw new Error("the process is dead");
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = u.pathname;
      calls.push(`${method} ${path}`);
      if (method === "POST" && path === "/v1/files") {
        const text = await (init.body.get("file") as Blob).text();
        const fileId = `file-in-${files.size + 1}`;
        files.set(
          fileId,
          text
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line).custom_id),
        );
        return Response.json({ id: fileId, object: "file", purpose: "batch" });
      }
      if (isCreate(method, path)) {
        // Numbered when the request starts, so a held-up create keeps its own.
        const k = ++n;
        await beforeStart?.();
        if (k === rejectStart) return unavailable();
        const body = JSON.parse(init.body);
        let b: any;
        let ids: string[];
        if (vendor === "google") {
          b = {
            name: `batches/b${k}`,
            metadata: {
              state: "JOB_STATE_RUNNING",
              displayName: body.batch.displayName,
            },
            done: false,
          };
          ids = body.batch.inputConfig.requests.requests.map(
            (r: any) => r.metadata.key,
          );
        } else if (vendor === "anthropic") {
          b = {
            id: `msgbatch_${k}`,
            type: "message_batch",
            processing_status: "in_progress",
            request_counts: {
              processing: 1,
              succeeded: 0,
              errored: 0,
              canceled: 0,
              expired: 0,
            },
            created_at: "2026-01-01T00:00:00Z",
            expires_at: "2026-01-02T00:00:00Z",
          };
          ids = (body.requests ?? []).map((r: any) => r.custom_id);
        } else {
          b = {
            id: `batch_${k}`,
            object: "batch",
            status: "in_progress",
            input_file_id: body.input_file_id,
            metadata: body.metadata ?? {},
            created_at: k,
          };
          ids = files.get(body.input_file_id) ?? [];
        }
        batches.set(b.name ?? b.id, b);
        requests.set(b.name ?? b.id, ids);
        await afterStart?.();
        return Response.json(b);
      }
      if (isCancel(method, path)) {
        if (failCancel) return unavailable();
        await beforeCancel?.();
        const key = keyOf(path);
        const b = batches.get(key)!;
        cancelReached.add(key);
        if (!asyncCancel) markCancelling(b);
        if (killAt === "cancel") dead = true;
        return Response.json(vendor === "google" ? {} : b);
      }
      if (path.startsWith("/results/")) {
        const key = path.replace("/results/", "");
        return new Response(
          `${(requests.get(key) ?? []).map(anthropicResult).join("\n")}\n`,
          { headers: { "content-type": "application/x-jsonl" } },
        );
      }
      if (path.startsWith("/v1/files/") && path.endsWith("/content")) {
        const key = path.replace("/v1/files/out-", "").replace("/content", "");
        return new Response(
          `${(requests.get(key) ?? []).map(openaiResult).join("\n")}\n`,
          { headers: { "content-type": "application/jsonl" } },
        );
      }
      if (path === "/v1beta/batches") {
        return Response.json({ operations: [...batches.values()].reverse() });
      }
      if (path === "/v1/batches") {
        return Response.json({
          data: [...batches.values()].reverse(),
          has_more: false,
        });
      }
      if (failStatus) return unavailable();
      const b = batches.get(keyOf(path));
      if (!b) throw new Error(`Unexpected HTTP ${method} ${path}`);
      const response = Response.json(b);
      if (killAt === "read") dead = true;
      return response;
    }) as typeof fetch,
  });

  const stage = defineStage({
    id,
    name: id,
    schemas: { input: schema, output: schema, config: schema },
    async execute(ctx) {
      if (opts.collision) {
        await ctx.step.run(opts.collision, async () => ({ ordinary: true }));
      }
      await ctx.step.ai.map(
        "x",
        Array.from({ length: opts.count ?? 1 }, (_, i) => i),
        {
          model: BATCH_MODEL,
          policy: "batch",
          prompt: (i) => String(i),
          ...(opts.itemId ? { itemId: () => opts.itemId! } : {}),
          batch: {
            options: { maxRequestsPerBatch: 1 },
            pollEvery: "1s",
            ...(opts.onReclaim ? { onReclaim: opts.onReclaim } : {}),
          },
        },
      );
      return { output: {} };
    },
  });
  const mock = createMockAIHelperFactory();
  const h = await createHarness(opts.database, {
    stage,
    inputSchema: schema,
    outputSchema: schema,
    input: {},
    mock,
    aiFactory: createBatchAwareFactory(mock, model),
    batchModels: () => (resolver ? resolver() : model),
    ...(opts.batchMs
      ? {
          batchCancelTimeouts: {
            batchMs: opts.batchMs,
            sweepMs: opts.sweepMs ?? opts.batchMs * 2,
          },
        }
      : {}),
  });

  const original = h.ledger.compareAndSet.bind(h.ledger);
  h.ledger.compareAndSet = async (sid, key, expected, patch) => {
    if (dead) throw new Error("the process is dead");
    const result = patch.result as Record<string, unknown> | undefined;
    if (
      die &&
      key === "x:submit" &&
      expected.status === "running" &&
      patch.leaseExpiresAt === null &&
      patch.result !== undefined
    ) {
      throw new Error("process died before final write");
    }
    const outcome = await original(sid, key, expected, patch);
    if (outcome.applied && key === "x:submit" && killAt !== undefined) {
      const hold = patch.leaseExpiresAt instanceof Date && result?.cancelFence;
      const intent =
        !Object.hasOwn(patch, "leaseExpiresAt") &&
        result?.cancelFence &&
        result.cancelIntent;
      const final = patch.leaseExpiresAt === null && result !== undefined;
      if (
        (killAt === "hold" && hold) ||
        (killAt === "intent" && intent) ||
        (killAt === "final" && final)
      ) {
        dead = true;
      }
    }
    return outcome;
  };
  for (const method of ["update", "claim"] as const) {
    const inner = (h.ledger[method] as (...a: any[]) => Promise<any>).bind(
      h.ledger,
    );
    (h.ledger as any)[method] = async (...args: any[]) => {
      if (dead) throw new Error("the process is dead");
      return inner(...args);
    };
  }

  const cancel = () =>
    h.kernel.dispatch({ type: "run.cancel", workflowRunId: h.workflowRunId });
  return {
    ...h,
    batches,
    calls,
    model,
    cancelReached,
    setResolver: (f: () => Promise<EngineBatchModel>) => {
      resolver = f;
    },
    /** Every batch that still runs successfully, with its results. */
    finish: () => {
      for (const [key, b] of batches) {
        const ids = requests.get(key) ?? [];
        if (vendor === "google" && b.metadata.state === "JOB_STATE_RUNNING") {
          if (cancelReached.has(key)) continue;
          b.metadata.state = "JOB_STATE_SUCCEEDED";
          b.done = true;
          b.response = {
            inlinedResponses: {
              inlinedResponses: ids.map((rid) => ({
                metadata: { key: rid },
                response: {
                  candidates: [
                    {
                      content: { role: "model", parts: [{ text: "ok" }] },
                      finishReason: "STOP",
                    },
                  ],
                  usageMetadata: {
                    promptTokenCount: 1,
                    candidatesTokenCount: 1,
                    totalTokenCount: 2,
                  },
                },
              })),
            },
          };
        } else if (
          vendor === "anthropic" &&
          b.processing_status === "in_progress"
        ) {
          b.processing_status = "ended";
          b.results_url = `https://api.anthropic.com/results/${key}`;
          b.request_counts = {
            processing: 0,
            succeeded: ids.length,
            errored: 0,
            canceled: 0,
            expired: 0,
          };
        } else if (vendor === "openai" && b.status === "in_progress") {
          b.status = "completed";
          b.output_file_id = `out-${key}`;
          b.request_counts = {
            total: ids.length,
            completed: ids.length,
            failed: 0,
          };
        }
      }
    },
    /** Cancels the provider had accepted take effect. */
    settleCancels: () => {
      for (const key of cancelReached) {
        const b = batches.get(key);
        if (vendor === "google") b.metadata.state = "JOB_STATE_CANCELLED";
        else if (vendor === "anthropic") b.processing_status = "ended";
        else b.status = "cancelled";
      }
    },
    /** Batches that run and bill, and that no cancel request reached. */
    live: () =>
      [...batches.entries()]
        .filter(([key, b]) => {
          const state = b.metadata?.state ?? b.processing_status ?? b.status;
          return (
            !cancelReached.has(key) &&
            ["JOB_STATE_RUNNING", "in_progress"].includes(state)
          );
        })
        .map(([key]) => key),
    row: async () => h.ledger.get((await h.stage())!.id, "x:submit"),
    cancel,
    redrive: () =>
      h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
      }),
    states: () =>
      [...batches.values()].map(
        (b) => b.metadata?.state ?? b.processing_status ?? b.status,
      ),
    cancelPosts: () =>
      calls.filter(
        (c) =>
          c.startsWith("POST") &&
          (c.endsWith(":cancel") || c.endsWith("/cancel")),
      ).length,
    die: (v: boolean) => {
      die = v;
    },
    /** Kill the process right after `point`; `undefined` revives it. */
    dieAfter: (point: Point | undefined) => {
      killAt = point;
      if (point === undefined) dead = false;
    },
    /** Kill the process right after `point` during the next run.cancel. */
    cancelDyingAfter: async (point: Point) => {
      killAt = point;
      try {
        return await cancel();
      } finally {
        killAt = undefined;
        dead = false;
      }
    },
    asyncCancel: () => {
      asyncCancel = true;
    },
    failStatus: (v: boolean) => {
      failStatus = v;
    },
    failCancel: (v: boolean) => {
      failCancel = v;
    },
    rejectStart: (v: number) => {
      rejectStart = v;
    },
    setAfterStart: (f: typeof afterStart) => {
      afterStart = f;
    },
    setBeforeStart: (f: typeof beforeStart) => {
      beforeStart = f;
    },
    setBeforeCancel: (f: typeof beforeCancel) => {
      beforeCancel = f;
    },
  };
}

export type Harness = Awaited<ReturnType<typeof setup>>;

/** Every log of the harness's run, from the database or the memory store. */
export async function logsOf(
  h: Pick<Harness, "workflowRunId" | "persistence">,
  db?: KernelDb,
): Promise<Array<{ level: string; message: string }>> {
  return db
    ? db.client.workflowLog.findMany({
        where: { workflowRunId: h.workflowRunId },
      })
    : (
        h.persistence as unknown as {
          getAllLogs(): Array<{ level: string; message: string }>;
        }
      ).getAllLogs();
}

export { StageAbortedError };
