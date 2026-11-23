import { runInNewContext } from "node:vm";
import { APICallError } from "@ai-sdk/provider";
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
import type { Stage } from "../core/stage.js";
import { defineAsyncBatchStage, defineStage } from "../core/stage-factory.js";
import { defineWorkflow } from "../core/workflow.js";
import { executeJobWithHeartbeat } from "../kernel/helpers/host-support.js";
import type { Kernel, KernelConfig } from "../kernel/kernel.js";
import { CollectingEventSink } from "../kernel/testing/index.js";
import type { CreateAICallInput } from "../persistence/interface.js";
import {
  type KernelDatabase,
  kernelDatabase,
  override,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";

// Vitest loads the published integration surfaces from their workspace sources.
const integration = {
  console: "../../../workflow-engine-console/src/prisma-read-port.js",
  node: "../../../workflow-engine-host-node/src/host.js",
  serverless: "../../../workflow-engine-host-serverless/src/host.js",
};
const schema = z.object({});

async function within<T>(work: Promise<T>, timeoutMs = 1_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("The operation did not finish within the test budget"),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
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
    ).rejects.toThrow("Provider generation failed");
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
  ] as const)("commits the %s outcome while attributed accounting is still pending", async (path) => {
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
      await started.promise;
      const finished = await within<unknown>(finish);
      expect(finished).toBeDefined();
      expect(factory.mock.calls[0]?.[4]?.attribution).toEqual({
        ...attribution,
        workflowRunId,
      });
      expect(await db.client.aICall.count({ where: { workflowRunId } })).toBe(
        0,
      );
      expect(
        await db.client.workflowStage.findFirst({ where: { workflowRunId } }),
      ).toMatchObject({ status: "COMPLETED" });
    } finally {
      release.resolve();
      await finish;
      await kernel.flush();
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

  async function queueJob(
    stage: Stage<typeof schema, typeof schema, typeof schema>,
    config: Partial<KernelConfig>,
  ) {
    const def = defineWorkflow({
      id: "diagnostics",
      name: "Diagnostics",
      description: "Exercises the accounting boundary",
      input: schema,
    })
      .pipe(stage)
      .build();
    const kernel = db.makeKernel({
      registry: { getWorkflow: () => def },
      ...config,
    });
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "diagnostics-run",
      workflowId: def.id,
      input: {},
      ...attribution,
    });
    await kernel.dispatch({
      type: "run.claimPending",
      workerId: "kernel-worker",
    });
    const job = await db.jobTransport.dequeue();
    if (!job) throw new Error("Expected a job");
    return { workflowRunId, kernel, job };
  }

  const diagnosticsStage = {
    id: "verify",
    name: "Verify",
    schemas: { input: schema, output: schema, config: schema },
  } as const;
  const sensitive = "private provider diagnostic marker";

  // A provider model whose stream fails in one of the ways the SDK reports.
  const failingStream = (path: string) =>
    new MockLanguageModelV4({
      async doStream() {
        if (path === "stream call") {
          throw new APICallError({
            message: sensitive,
            url: "https://provider.invalid/v1",
            requestBodyValues: { prompt: sensitive },
            statusCode: 400,
            responseBody: sensitive,
            isRetryable: false,
          });
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              if (path === "stream transport") {
                controller.error(new Error(sensitive));
                return;
              }
              controller.enqueue({
                type: "error",
                error: new Error(sensitive),
              });
              controller.close();
            },
          }),
        };
      },
    });

  it.each([
    ["batch", "none"],
    ["batch", "full"],
    ["durable", "none"],
    ["realtime", "full"],
    ["validation", "none"],
    ["batch accounting", "full"],
    ["stream transport", "none"],
    ["stream transport", "full"],
    ["stream part", "none"],
    ["stream call", "full"],
  ] as const)("keeps %s provider diagnostics out of host, console, events and traces with %s capture", async (path, store) => {
    vi.stubEnv("WORKFLOW_ENGINE_TRACE", "1");
    vi.stubEnv("WORKFLOW_ENGINE_TRACE_TEXT", "");
    const output = (["log", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const warnings = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => {});
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        if (path === "batch") {
          await ctx.ai
            .batch(modelKey, "openrouter", {
              apiKey: "fixture-key",
              fetch: async () => new Response(sensitive, { status: 400 }),
            })
            .submit([{ id: "item-1", prompt: "request marker" }]);
        } else if (path === "durable") {
          await ctx.step.ai.generateText("fetch", modelKey, "request marker");
        } else if (path === "validation") {
          await ctx.step.ai.map("fetch", ["item-1"], {
            model: modelKey,
            policy: "realtime",
            prompt: () => "request marker",
            stream: true,
            schema: z.object({}).transform(() => {
              throw new Error(sensitive);
            }),
          });
        } else if (path === "batch accounting") {
          await ctx.aiLogger.logBatchResults("batch-1", [
            {
              ...manual,
              topic: "scope",
              modelId: modelKey,
              requestId: "item-1",
            },
          ]);
        } else if (path.startsWith("stream")) {
          // No log call or explicit wrapping: the SDK's own surface propagates.
          await ctx.step.run("read", async () => {
            const { rawResult } = ctx.ai.streamText(modelKey, {
              prompt: "request marker",
            });
            for await (const part of rawResult!.fullStream) {
              if (part.type === "error") throw part.error;
            }
            return null;
          });
        } else {
          await ctx.ai.generateText(modelKey, "request marker");
        }
        return { output: {} };
      },
    });
    const eventSink = new CollectingEventSink();
    const { workflowRunId, kernel, job } = await queueJob(stage, {
      eventSink,
      services: {
        aiLogger: override(db.aiLogger, {
          async logBatchResults() {
            throw new Error(sensitive);
          },
        }),
        ai: (topic, logger, context, _resolver, options) =>
          createAIHelper(topic, logger, context, () => failingStream(path), {
            ...options,
            text: { store, ttlMs: 1 },
            adapter: {
              ...(path.startsWith("stream")
                ? {}
                : {
                    streamText() {
                      return {
                        stream: (async function* () {
                          yield "{}";
                        })(),
                        inputTokens: 1,
                        outputTokens: 1,
                      };
                    },
                  }),
              async generateText() {
                throw new Error(sensitive);
              },
            },
          }),
      },
    });
    try {
      const { createServerlessHost } = await import(integration.serverless);
      const host = createServerlessHost({
        kernel,
        jobTransport: db.jobTransport,
        workerId: "kernel-worker",
      });
      const result = await host.handleJob({ ...job, maxAttempts: 1 });
      expect(result.outcome).toBe(
        path === "validation" ? "completed" : "failed",
      );
      await kernel.dispatch({ type: "outbox.flush", maxEvents: 100 });
      const { createPrismaConsoleReadPort } = await import(integration.console);
      const reader = createPrismaConsoleReadPort(db.client, {
        databaseType: sqlite ? "sqlite" : "postgresql",
      });
      const reads = await Promise.all([
        reader.getRunDetail(workflowRunId),
        reader.listRunEvents(workflowRunId, 0),
        db.client.workflowStage.findMany({ where: { workflowRunId } }),
        db.client.workflowLog.findMany({ where: { workflowRunId } }),
        db.client.workflowStep.findMany({
          where: { stage: { workflowRunId } },
        }),
        db.client.jobQueue.findMany({ where: { workflowRunId } }),
        db.client.outboxEvent.findMany({ where: { workflowRunId } }),
        db.client.idempotencyKey.findMany({ where: { workflowRunId } }),
        db.client.aICall.findMany({ where: { workflowRunId } }),
      ]);
      expect(reads[0]).toBeTruthy();
      expect(reads[1]?.length).toBeGreaterThan(0);
      expect(eventSink.getByType("workflow:failed").length).toBe(
        path === "validation" ? 0 : 1,
      );
      if (path === "validation") {
        expect(JSON.stringify(reads[4])).toContain(
          "AI map response validation failed",
        );
      }
      expect(
        JSON.stringify([
          result,
          ...reads,
          eventSink.events,
          ...output.map((spy) => spy.mock.calls),
          warnings.mock.calls,
        ]),
      ).not.toContain(sensitive);
    } finally {
      for (const spy of [...output, warnings]) spy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    "none",
    "full",
  ] as const)("binds raw stage writes to %s capture and run attribution", async (store) => {
    const input = {
      ...manual,
      modelId: manual.modelKey,
      topic: "scope",
      metadata: { instructions: sensitive, details: { caller: sensitive } },
    };
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        // The logger is the first AI accessor touched by this stage.
        ctx.aiLogger.logCall(input);
        await ctx.aiLogger.logBatchResults("batch-2", [
          { ...input, requestId: "item-1", callType: "batch" },
        ]);
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, resolver, options) =>
          createAIHelper(topic, logger, context, resolver, {
            ...options,
            text: { store, ttlMs: 10 },
          }),
      },
    });
    expect(
      (
        await executeJobWithHeartbeat(kernel, {
          job,
          jobTransport: db.jobTransport,
        })
      ).outcome,
    ).toBe("completed");
    await kernel.flush();
    const rows = await db.client.aICall.findMany({ where: { workflowRunId } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ ...attribution, workflowRunId });
      // Opaque caller metadata is explicitly outside the text-retention policy.
      expect(row.metadata.details).toEqual({ caller: sensitive });
      if (store === "none") {
        expect(row).toMatchObject({
          prompt: "",
          response: "",
          textExpiresAt: null,
        });
        expect(row.metadata).not.toHaveProperty("instructions");
      } else {
        expect(row).toMatchObject({
          prompt: manual.prompt,
          response: manual.response,
          textExpiresAt: expect.any(Date),
        });
      }
    }
  });

  it("keeps a timely not-ready poll suspended as a successful accounting write crosses its deadline", async () => {
    let now = Date.now();
    const deadline = now + 1_000;
    const write = Promise.withResolvers<void>();
    const stage = defineAsyncBatchStage({
      ...diagnosticsStage,
      mode: "async-batch",
      async execute() {
        return {
          suspended: true,
          state: {
            batchId: "batch-1",
            submittedAt: new Date(now).toISOString(),
            pollInterval: 1,
            maxWaitTime: 1_000,
          },
          pollConfig: {
            nextPollAt: new Date(now),
            pollInterval: 1,
            maxWaitTime: 1_000,
          },
        };
      },
      async checkCompletion(_state, ctx) {
        expect(now).toBeLessThan(deadline);
        ctx.ai.recordCall(manual);
        return { ready: false };
      },
    });
    const logger = override(db.aiLogger, {
      async logCall(call) {
        await write.promise;
        now = deadline + 1;
        await db.aiLogger.logCall(call);
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      clock: { now: () => new Date(now) },
      services: { aiLogger: logger },
    });
    expect(
      (
        await executeJobWithHeartbeat(kernel, {
          job,
          jobTransport: db.jobTransport,
        })
      ).outcome,
    ).toBe("suspended");
    await db.client.workflowStage.updateMany({
      where: { workflowRunId },
      data: { maxWaitUntil: new Date(deadline) },
    });
    now += 100;
    const poll = kernel.dispatch({ type: "stage.pollSuspended" });
    try {
      await within(poll);
      expect(
        await db.client.workflowStage.findFirst({ where: { workflowRunId } }),
      ).toMatchObject({ status: "SUSPENDED" });
    } finally {
      write.resolve();
      await poll;
      await kernel.flush();
    }
    expect(now).toBeGreaterThan(deadline);
    expect(await db.client.aICall.count({ where: { workflowRunId } })).toBe(1);
  });

  it("preserves a committed serverless result when the logger flush rejects", async () => {
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        ctx.ai.recordCall(manual);
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        aiLogger: override(db.aiLogger, {
          flush: async () => {
            throw new Error(sensitive);
          },
        }),
      },
    });
    const { createServerlessHost } = await import(integration.serverless);
    const host = createServerlessHost({
      kernel,
      jobTransport: db.jobTransport,
      workerId: "kernel-worker",
    });
    expect((await host.handleJob(job)).outcome).toBe("completed");
    expect(
      await db.client.workflowStage.findFirst({ where: { workflowRunId } }),
    ).toMatchObject({ status: "COMPLETED" });
  });

  it("bounds both kernel flush and Node shutdown when the logger ignores the supplied timeout", async () => {
    const release = Promise.withResolvers<{
      failed: number;
      pending: number;
    }>();
    const kernel: Kernel = db.makeKernel({
      services: {
        aiLogger: override(db.aiLogger, { flush: () => release.promise }),
      },
    });
    const { createNodeHost } = await import(integration.node);
    const host = createNodeHost({
      kernel,
      jobTransport: db.jobTransport,
      workerId: "kernel-worker",
      shutdownTimeoutMs: 20,
      jobPollIntervalMs: 10,
      flushOutboxOnStop: false,
    });
    await host.start();
    try {
      expect(await within(kernel.flush({ timeoutMs: 20 }))).toEqual({
        failed: 0,
        pending: 1,
      });
      await within(host.stop());
    } finally {
      release.resolve({ failed: 0, pending: 0 });
      await host.stop();
    }
  });

  // An OpenRouter batch transport answering with two completed items.
  const batchTransport = {
    apiKey: "fixture-key",
    fetch: async () =>
      Response.json({
        id: "batch-1",
        status: "completed",
        results: ["first", "second"].map((custom_id) => ({
          custom_id,
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: "reply" } }],
              usage: { prompt_tokens: 2, completion_tokens: 3, cost: 1.25 },
            },
          },
        })),
      }),
  };

  it("rolls back a batch whose recording fails partway, so recordResults restores all of it", async () => {
    const refuse = sqlite
      ? [
          `CREATE TRIGGER refuse_second BEFORE INSERT ON "ai_calls" WHEN NEW."requestId" = 'second' BEGIN SELECT RAISE(ABORT, 'refused'); END`,
        ]
      : [
          `CREATE FUNCTION refuse_second() RETURNS trigger AS $$ BEGIN IF NEW."requestId" = 'second' THEN RAISE EXCEPTION 'refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
          `CREATE TRIGGER refuse_second BEFORE INSERT ON "ai_calls" FOR EACH ROW EXECUTE FUNCTION refuse_second()`,
        ];
    const allow = sqlite
      ? [`DROP TRIGGER IF EXISTS refuse_second`]
      : [
          `DROP TRIGGER IF EXISTS refuse_second ON "ai_calls"`,
          `DROP FUNCTION IF EXISTS refuse_second()`,
        ];
    const onLogError = vi.fn();
    const helper = () =>
      createAIHelper("accounting", db.aiLogger, undefined, undefined, {
        attribution,
        onLogError,
      }).batch(modelKey, "openrouter", batchTransport);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const sql of refuse) await db.client.$executeRawUnsafe(sql);
      // Recording is awaited by getResults, as in earlier releases.
      await expect(helper().getResults("batch-1")).rejects.toThrow(
        "AI call accounting write failed",
      );
      expect(onLogError).toHaveBeenCalledTimes(2);
      expect(await db.client.aICall.count()).toBe(0);
    } finally {
      for (const sql of allow) await db.client.$executeRawUnsafe(sql);
      warn.mockRestore();
    }
    const batch = helper();
    await batch.recordResults("batch-1", await batch.getResults("batch-1"));
    const rows = await db.client.aICall.findMany({
      orderBy: { requestId: "asc" },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        ...attribution,
        requestId: "first",
        cost: 1.25,
      }),
      expect.objectContaining({
        ...attribution,
        requestId: "second",
        cost: 1.25,
      }),
    ]);
  });

  it("counts batch accounting in the run total as soon as the stage completes", async () => {
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const batch = ctx.ai.batch(modelKey, "openrouter", batchTransport);
        expect(await batch.getResults("batch-1")).toHaveLength(2);
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        // A slow write: the stage still waits for it before completing.
        aiLogger: override(db.aiLogger, {
          async logBatchResults(batchId, rows) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            await db.aiLogger.logBatchResults(batchId, rows);
          },
        }),
      },
    });
    expect(
      (
        await executeJobWithHeartbeat(kernel, {
          job,
          jobTransport: db.jobTransport,
        })
      ).outcome,
    ).toBe("completed");
    await kernel.dispatch({ type: "run.transition", workflowRunId });
    expect(
      await db.client.workflowRun.findUnique({ where: { id: workflowRunId } }),
    ).toMatchObject({ status: "COMPLETED", totalCost: 2.5, totalTokens: 10 });
    expect(
      await db.client.aICall.findMany({ where: { workflowRunId } }),
    ).toEqual([
      expect.objectContaining({ ...attribution, workflowRunId }),
      expect.objectContaining({ ...attribution, workflowRunId }),
    ]);
  });

  it("rejects an awaited stage write that the database refuses and reports both failures", async () => {
    const onLogError = vi.fn();
    const call = {
      ...manual,
      modelId: manual.modelKey,
      topic: "external",
      batchId: "batch-1",
      requestId: "item-1",
    };
    const outcomes: string[] = [];
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        await ctx.aiLogger.logCall(call);
        outcomes.push(
          await Promise.resolve(ctx.aiLogger.logCall(call)).then(
            () => "resolved",
            (error: Error) => error.message,
          ),
        );
        // Ignored: handled by the logger, reported to the callback.
        void ctx.aiLogger.logCall(call);
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, resolver, options) =>
          createAIHelper(topic, logger, context, resolver, {
            ...options,
            onLogError,
          }),
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        (
          await executeJobWithHeartbeat(kernel, {
            job,
            jobTransport: db.jobTransport,
          })
        ).outcome,
      ).toBe("completed");
      await vi.waitFor(() => expect(onLogError).toHaveBeenCalledTimes(2));
    } finally {
      warn.mockRestore();
    }
    expect(outcomes).toEqual(["AI call accounting write failed"]);
    expect(onLogError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ...attribution, workflowRunId }),
    );
    expect(
      await db.client.aICall.findMany({ where: { workflowRunId } }),
    ).toEqual([expect.objectContaining({ ...attribution, workflowRunId })]);
  });

  it("fails a stage terminally on an adapter's Zod error, as earlier releases did", async () => {
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        await ctx.ai.generateText(modelKey, "request marker");
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, resolver, options) =>
          createAIHelper(topic, logger, context, resolver, {
            ...options,
            adapter: {
              async generateText() {
                z.string().min(1).parse("");
                return { text: "", inputTokens: 0, outputTokens: 0 };
              },
            },
          }),
      },
    });
    const { createServerlessHost } = await import(integration.serverless);
    const host = createServerlessHost({
      kernel,
      jobTransport: db.jobTransport,
      workerId: "kernel-worker",
    });
    expect((await host.handleJob({ ...job, maxAttempts: 3 })).outcome).toBe(
      "failed",
    );
    expect(
      await db.client.workflowStage.findFirst({ where: { workflowRunId } }),
    ).toMatchObject({ status: "FAILED" });
  });
});
