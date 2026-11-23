import { runInNewContext } from "node:vm";
import { MockLanguageModelV4 } from "ai/test";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import {
  createAIHelper,
  registerEvaluationProvider,
  registerTranscriptionProvider,
} from "../ai/ai-helper.js";
import { registerModels } from "../ai/model-helper.js";
import type { AIAdapter } from "../ai/types.js";
import { defineAsyncBatchStage, defineStage } from "../core/stage-factory.js";
import { defineWorkflow } from "../core/workflow.js";
import { executeJobWithHeartbeat } from "../kernel/helpers/host-support.js";
import type { CreateAICallInput } from "../persistence/interface.js";
import {
  type KernelDatabase,
  kernelDatabase,
  override,
  realDatabase,
} from "./sqlite8-kernel-utils.js";

const schema = z.object({});
const workflow = defineWorkflow({
  id: "tenant-attribution",
  name: "Tenant attribution",
  description: "Waits for a signal",
  input: schema,
})
  .pipe(
    defineStage({
      id: "wait",
      name: "Wait",
      schemas: { input: schema, output: schema, config: schema },
      async execute(ctx) {
        await ctx.step.waitForSignal("approval", { timeout: "10m" });
        return { output: {} };
      },
    }),
  )
  .build();

describe.skipIf(!realDatabase)("tenant and run attribution", () => {
  let db: KernelDatabase;
  let kernel: KernelDatabase["kernel"];

  beforeAll(async () => {
    db = await kernelDatabase();
    kernel = db.makeKernel({ registry: { getWorkflow: () => workflow } });
  }, 120_000);
  beforeEach(() => db.reset());
  afterAll(() => db?.close());

  const createRun = (labels: unknown = { queue: "batch", priority: "low" }) =>
    kernel.dispatch({
      type: "run.create",
      workflowId: workflow.id,
      idempotencyKey: "tenant-test",
      input: {},
      tenantId: "tenant-a",
      labels: labels as Record<string, string>,
    });

  async function enterSignalWait() {
    const { workflowRunId } = await createRun();
    await kernel.dispatch({
      type: "run.claimPending",
      workerId: "kernel-worker",
    });
    const job = await db.jobTransport.dequeue();
    if (!job) throw new Error("Expected the run's first job");
    await executeJobWithHeartbeat(kernel, {
      jobTransport: db.jobTransport,
      job,
    });
    return { workflowRunId, job };
  }

  it("stores tenantId and labels on the run created by the kernel", async () => {
    const { workflowRunId } = await createRun();
    const row = await db.client.workflowRun.findUnique({
      where: { id: workflowRunId },
    });
    expect(row).toMatchObject({
      tenantId: "tenant-a",
      labels: { queue: "batch", priority: "low" },
    });
  });

  it("attributes the run.create key to the new run", async () => {
    const { workflowRunId } = await createRun();
    const key = await db.client.idempotencyKey.findFirst({
      where: { key: "tenant-test", commandType: "run.create" },
    });
    expect(key?.workflowRunId).toBe(workflowRunId);
  });

  it("rejects labels outside the portable flat string-map contract before creating a run", async () => {
    const invalid = [
      null,
      ["value"],
      "value",
      1,
      true,
      new Date(0),
      { queue: null },
      { queue: 1 },
      { queue: {} },
      { queue: [] },
      { queue: ["value"] },
      { queue: undefined },
      {
        get queue() {
          return "value";
        },
      },
      { [Symbol("queue")]: "value" },
      JSON.parse('{"__proto__":"value"}'),
      { ["\0"]: "value" },
      { ["\uD800"]: "value" },
      { queue: "\0" },
      { queue: "\uD800" },
    ];
    for (const labels of invalid) {
      await expect(createRun(labels)).rejects.toThrow(/labels.*string values/i);
    }
    expect(await db.client.workflowRun.count()).toBe(0);
    expect(await db.client.idempotencyKey.count()).toBe(0);

    const labels = Object.assign(Object.create(null), {
      $type: "ordinary",
      constructor: "ordinary",
      set: "value",
      toJSON: "also ordinary",
      "queue-🔔": "ready-🔔",
    });
    const { workflowRunId } = await createRun(labels);
    expect(
      await db.client.workflowRun.findUnique({
        where: { id: workflowRunId },
      }),
    ).toMatchObject({ labels });
    // Replaying a completed key observes the original run.
    expect(await createRun({ queue: [] })).toMatchObject({ workflowRunId });
  });

  it("accepts a plain label map created in another realm", async () => {
    const { workflowRunId } = await createRun(
      runInNewContext('({ queue: "normal" })'),
    );
    expect(
      await db.client.workflowRun.findUnique({
        where: { id: workflowRunId },
      }),
    ).toMatchObject({ labels: { queue: "normal" } });
  });

  it("attributes the worker's job.execute attempt key to its run", async () => {
    const { workflowRunId, job } = await enterSignalWait();
    const key = await db.client.idempotencyKey.findFirst({
      where: {
        key: `job:${job.jobId}:attempt:${job.attempt}`,
        commandType: "job.execute",
      },
    });
    expect(key?.workflowRunId).toBe(workflowRunId);
  });

  it("attributes the signal wake key to the suspended run", async () => {
    const { workflowRunId } = await enterSignalWait();
    await kernel.dispatch({
      type: "step.signal",
      workflowRunId,
      stageId: "wait",
      stepId: "approval",
      payload: {},
    });
    const key = await db.client.idempotencyKey.findFirst({
      where: { commandType: "step.signal.wake" },
    });
    expect(key?.workflowRunId).toBe(workflowRunId);
  });
});

const modelKey = "accounting-test/model";
const attribution = { tenantId: "tenant-a", labels: { task: "classify" } };
const manual = {
  modelKey: "external/realtime",
  callType: "realtime",
  prompt: "request marker",
  response: "response marker",
  inputTokens: 2,
  outputTokens: 3,
  cost: 0.25,
} as const;
const adapter: AIAdapter = {
  async generateObject() {
    return { object: {}, inputTokens: 3, outputTokens: 2 };
  },
  async embed() {
    return { embeddings: [[1]], inputTokens: 3 };
  },
  streamText() {
    return {
      stream: (async function* () {
        yield "response marker";
      })(),
      inputTokens: 3,
      outputTokens: 2,
    };
  },
};

registerModels({
  [modelKey]: {
    id: modelKey,
    name: "Accounting fixture",
    provider: "accounting-test",
    isEvaluationModel: true,
    isTranscriptionModel: true,
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
  },
});
registerEvaluationProvider("accounting-test", () => ({
  specificationVersion: "v4",
  provider: "accounting-test",
  modelId: modelKey,
  supportedQuestionTypes: ["boolean"],
  async doEvaluate() {
    return {
      answers: { flag: { type: "boolean", probability: 0.9 } },
      usage: { inputTokens: 3, outputTokens: 2 },
      warnings: [],
    };
  },
}));
registerTranscriptionProvider("accounting-test", () => ({
  specificationVersion: "v4",
  provider: "accounting-test",
  modelId: modelKey,
  async doGenerate() {
    return {
      text: "response marker",
      segments: [],
      language: "en",
      durationInSeconds: 1,
      warnings: [],
      response: { timestamp: new Date(), modelId: modelKey },
    };
  },
}));

describe.skipIf(!realDatabase)("AI call rows", () => {
  let db: KernelDatabase;
  beforeAll(async () => {
    db = await kernelDatabase();
  }, 120_000);
  beforeEach(() => db.reset());
  afterAll(() => db?.close());

  it.each([
    "none",
    "full",
  ] as const)("attributes every call and applies the %s text policy", async (store) => {
    let requests = 0;
    const model = new MockLanguageModelV4({
      async doGenerate() {
        if (requests++ > 0) throw new Error("error body marker");
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "inspect",
              input: '{"value":"tool input marker"}',
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: {
            inputTokens: {
              total: 3,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 2, text: undefined, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const ttlMs = 60_000;
    const before = Date.now();
    const ai = createAIHelper(
      "accounting",
      db.aiLogger,
      undefined,
      () => model,
      {
        adapter,
        attribution,
        text: { store, ttlMs },
      },
    );
    await ai.generateText(modelKey, "request marker", {
      tools: {
        inspect: {
          inputSchema: z.object({ value: z.string() }),
          execute: async () => "tool output marker",
        },
      },
    });
    await expect(
      ai.generateText(modelKey, "request marker", { maxRetries: 0 }),
    ).rejects.toThrow("error body marker");
    await ai.generateObject(modelKey, "request marker", schema);
    await ai.embed(modelKey, "request marker");
    await ai.evaluate(modelKey, {
      state: "request marker",
      questions: {
        flag: { type: "boolean", instructions: "instructions marker" },
      },
    });
    await ai.transcribe(modelKey, new Uint8Array([1, 2, 3, 4]));
    const stream = ai.streamText(modelKey, {
      prompt: "request marker",
      instructions: "instructions marker",
    });
    for await (const _ of stream.stream) {
      // Drain the stream so it writes a row.
    }
    await ai.batch(modelKey, "openrouter").recordResults("batch-1", [
      {
        id: "item-1",
        status: "succeeded",
        prompt: "request marker",
        result: "response marker",
        inputTokens: 3,
        outputTokens: 2,
      },
      {
        id: "item-2",
        status: "failed",
        prompt: "request marker",
        error: "error body marker",
        responseText: "response marker",
        inputTokens: 3,
        outputTokens: 2,
      },
    ]);
    ai.recordCall(manual);
    expect(await ai.flush()).toEqual({ failed: 0, pending: 0 });
    const rows = await db.client.aICall.findMany({
      where: { tenantId: attribution.tenantId },
    });
    expect(rows.map((row: CreateAICallInput) => row.callType).sort()).toEqual([
      "batch",
      "batch",
      "embed",
      "evaluate",
      "object",
      "realtime",
      "stream",
      "text",
      "text",
      "text",
      "transcribe",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ ...attribution, workflowRunId: null });
      if (store === "full") {
        expect(row.textExpiresAt.getTime()).toBeGreaterThanOrEqual(
          before + ttlMs,
        );
        expect(row.textExpiresAt.getTime()).toBeLessThanOrEqual(
          Date.now() + ttlMs,
        );
      } else {
        expect(row).toMatchObject({
          prompt: "",
          response: "",
          textExpiresAt: null,
        });
        expect(row.metadata ?? {}).not.toHaveProperty("instructions");
      }
      expect(JSON.stringify(row.metadata)).not.toContain("error body marker");
    }
    expect(
      rows.find((row: CreateAICallInput) => row.callType === "stream")
        ?.metadata,
    ).toMatchObject(
      store === "full"
        ? { instructions: "instructions marker" }
        : { streamChunks: 1 },
    );
    const tool = rows.find((row: CreateAICallInput) =>
      row.topic.endsWith(".tool.inspect"),
    );
    expect(tool).toMatchObject({ cost: 0 });
    if (store === "full") {
      expect(tool.prompt).toContain("tool input marker");
      expect(tool.response).toContain("tool output marker");
    }
    expect(
      rows.find((row: CreateAICallInput) => row.callType === "realtime"),
    ).toMatchObject({
      cost: 0.25,
      reportedCost: 0.25,
      estimatedCost: null,
      costSource: "reported",
    });
  });

  it("totals a half-open tenant period and groups by opaque label values", async () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-02-01T00:00:00Z");
    for (const [tenantId, labels, createdAt, cost] of [
      ["tenant-a", { queue: "__proto__" }, from, 3],
      ["tenant-a", { queue: "__proto__" }, from, 1],
      ["tenant-a", undefined, from, 2],
      ["tenant-a", { queue: "__proto__" }, to, 9],
      ["tenant-b", { queue: "__proto__" }, from, 8],
    ] as const) {
      await db.client.aICall.create({
        data: {
          ...manual,
          modelId: manual.modelKey,
          topic: "cost",
          tenantId,
          labels,
          createdAt,
          cost,
        },
      });
    }

    const period = { tenantId: "tenant-a", from, to };
    expect(await db.aiLogger.costByTenant(period)).toEqual({ totalCost: 6 });
    expect(
      await db.aiLogger.costByTenant({ ...period, groupBy: "queue" }),
    ).toEqual({
      totalCost: 6,
      groups: expect.arrayContaining([
        { label: "__proto__", cost: 4 },
        { label: null, cost: 2 },
      ]),
    });
    expect(
      await db.aiLogger.costByTenant({ ...period, tenantId: "unknown" }),
    ).toEqual({ totalCost: 0 });
  });

  it("returns a real insert rejection and drains ignored failures through kernel.flush", async () => {
    const call = {
      ...manual,
      modelId: manual.modelKey,
      topic: "external",
      batchId: "batch-1",
      requestId: "item-1",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await db.aiLogger.logCall(call);
      await expect(db.aiLogger.logCall(call)).rejects.toBeTruthy();
      const onLogError = vi.fn();
      const ai = createAIHelper(
        "accounting",
        {
          logCall: (input) =>
            db.aiLogger.logCall({
              ...input,
              batchId: call.batchId,
              requestId: call.requestId,
            }),
          getStats: db.aiLogger.getStats.bind(db.aiLogger),
          isRecorded: db.aiLogger.isRecorded.bind(db.aiLogger),
          logBatchResults: db.aiLogger.logBatchResults.bind(db.aiLogger),
        },
        undefined,
        undefined,
        { attribution, onLogError },
      );
      ai.recordCall(manual);
      void db.aiLogger.logCall(call);
      const kernel = db.makeKernel({ services: { aiLogger: db.aiLogger } });
      const before = await kernel.flush();
      expect(await ai.flush()).toEqual({ failed: 1, pending: 0 });
      expect(onLogError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining(attribution),
      );
      // The reused test logger counts failures for its lifetime.
      expect(before).toEqual({ failed: 3, pending: 0 });
      expect(warn.mock.calls).toHaveLength(3);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("response marker");
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    "execute",
    "replay",
    "checkCompletion",
  ] as const)("forwards run attribution and flushes writes before the %s outcome", async (path) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = async (call: CreateAICallInput) => {
      started.resolve();
      await release.promise;
      await db.aiLogger.logCall(call);
    };
    const logger = override(db.aiLogger, { logCall: write });
    const stageBase = {
      id: "classify",
      name: "Classify",
      schemas: { input: schema, output: schema, config: schema },
    };
    const stage =
      path === "checkCompletion"
        ? defineAsyncBatchStage({
            ...stageBase,
            mode: "async-batch",
            async execute() {
              return {
                suspended: true,
                state: {
                  batchId: "batch-1",
                  submittedAt: new Date().toISOString(),
                  pollInterval: 1,
                  maxWaitTime: 60_000,
                },
                pollConfig: {
                  pollInterval: 1,
                  maxWaitTime: 60_000,
                  nextPollAt: new Date(0),
                },
              };
            },
            async checkCompletion(_state, ctx) {
              ctx.ai.recordCall(manual);
              return { ready: true, output: {} };
            },
          })
        : defineStage({
            ...stageBase,
            async execute(ctx) {
              if (path === "replay") await ctx.step.sleep("pause", 1);
              ctx.ai.recordCall(manual);
              return { output: {} };
            },
          });
    const definition = defineWorkflow({
      id: "accounting-workflow",
      name: "Accounting workflow",
      description: "Records usage",
      input: schema,
    })
      .pipe(stage)
      .build();
    const factory = vi.fn<typeof createAIHelper>(
      (topic, callLogger, _logContext, resolver, options) =>
        createAIHelper(topic, callLogger, undefined, resolver, options),
    );
    let now = Date.now();
    const kernel = db.makeKernel({
      clock: { now: () => new Date(now) },
      registry: { getWorkflow: () => definition },
      services: { ai: factory, aiLogger: logger },
    });
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      workflowId: definition.id,
      idempotencyKey: "accounting-run",
      input: {},
      ...attribution,
    });
    await kernel.dispatch({
      type: "run.claimPending",
      workerId: "kernel-worker",
    });
    const job = await db.jobTransport.dequeue();
    if (!job) throw new Error("Expected a job");
    const execute = executeJobWithHeartbeat(kernel, {
      jobTransport: db.jobTransport,
      job,
    });
    if (path !== "execute") {
      expect((await execute).outcome).toBe("suspended");
      expect(factory).not.toHaveBeenCalled();
      now += 100;
    }
    const finish =
      path === "execute"
        ? execute
        : kernel.dispatch({ type: "stage.pollSuspended" });
    try {
      await Promise.race([
        started.promise,
        finish.then(() => {
          throw new Error("Stage finished before the write began");
        }),
      ]);
      expect(factory.mock.calls[0]?.[4]?.attribution).toEqual({
        ...attribution,
        workflowRunId,
      });
      const stageBefore = await db.client.workflowStage.findFirst({
        where: { workflowRunId },
      });
      expect(stageBefore.status).toBe(
        path === "execute" ? "RUNNING" : "SUSPENDED",
      );
      expect(await db.client.aICall.count({ where: { workflowRunId } })).toBe(
        0,
      );
    } finally {
      release.resolve();
      await finish;
    }
    const row = await db.client.aICall.findFirst({ where: { workflowRunId } });
    expect(row).toMatchObject({
      ...attribution,
      workflowRunId,
      cost: manual.cost,
    });
    const stageAfter = await db.client.workflowStage.findFirst({
      where: { workflowRunId },
    });
    expect(stageAfter.status).toBe("COMPLETED");
  });

  it("writes a count-only run warning when the stage drain has failures and an open stream", async () => {
    const definition = defineWorkflow({
      id: "logging-warning",
      name: "Logging warning",
      description: "Records usage",
      input: schema,
    })
      .pipe(
        defineStage({
          id: "classify",
          name: "Classify",
          schemas: { input: schema, output: schema, config: schema },
          async execute(ctx) {
            ctx.ai.recordCall(manual);
            ctx.ai.streamText(modelKey, { prompt: "request marker" });
            return { output: {} };
          },
        }),
      )
      .build();
    const kernel = db.makeKernel({
      registry: { getWorkflow: () => definition },
      aiFlushTimeoutMs: 10,
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, resolver, options) =>
          createAIHelper(
            topic,
            {
              logCall: () => {
                throw new Error("write error marker");
              },
              getStats: logger.getStats.bind(logger),
              isRecorded: logger.isRecorded.bind(logger),
              logBatchResults: logger.logBatchResults.bind(logger),
            },
            context,
            resolver,
            { ...options, adapter },
          ),
      },
    });
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      workflowId: definition.id,
      idempotencyKey: "warning",
      input: {},
    });
    await kernel.dispatch({
      type: "run.claimPending",
      workerId: "kernel-worker",
    });
    const job = await db.jobTransport.dequeue();
    if (!job) throw new Error("Expected a job");
    const result = await executeJobWithHeartbeat(kernel, {
      jobTransport: db.jobTransport,
      job,
    });
    expect(result.outcome).toBe("completed");
    expect(
      await db.client.workflowLog.findMany({
        where: { workflowRunId, level: "WARN" },
      }),
    ).toEqual([
      expect.objectContaining({
        workflowStageId: null,
        message: "AI call logging did not finish successfully",
        metadata: { failed: 1, pending: 1 },
      }),
    ]);
  });
});
