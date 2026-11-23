import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { APICallError } from "@ai-sdk/provider";
import { stepCountIs } from "ai";
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
import type { AIAdapter, AIHelper } from "../ai/types.js";
import type { Stage } from "../core/stage.js";
import { defineAsyncBatchStage, defineStage } from "../core/stage-factory.js";
import { defineWorkflow } from "../core/workflow.js";
import { executeJobWithHeartbeat } from "../kernel/helpers/host-support.js";
import type { Kernel, KernelConfig } from "../kernel/kernel.js";
import { CollectingEventSink } from "../kernel/testing/index.js";
import type {
  AICallLogger,
  CreateAICallInput,
} from "../persistence/interface.js";
import { createPrismaAICallLogger } from "../persistence/prisma/index.js";
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
    // The retention indexes and eligibility a production installation adds.
    const dialect = sqlite ? "sqlite" : "postgresql";
    for (const [file, separator] of [
      ["retention-indexes", ";"],
      ["retention-eligibility", "-- statement-breakpoint"],
    ] as const) {
      const ddl = await readFile(
        new URL(`../../sql/${file}.${dialect}.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of ddl.split(separator)) {
        if (statement.trim()) await db.client.$executeRawUnsafe(statement);
      }
    }
  }, 120_000);
  beforeEach(() => db.reset());
  afterAll(() => db?.close());

  // One call through every path that writes a row, with text in each.
  const everyPathModel = () => {
    let requests = 0;
    return new MockLanguageModelV4({
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
  };
  const writeEveryPath = async (ai: AIHelper) => {
    await ai.generateText(modelKey, "request marker", {
      tools: {
        inspect: {
          inputSchema: z.object({ value: z.string() }),
          execute: async () => "tool output marker",
        },
      },
    });
    // The caller gets the provider's error unchanged.
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
  };

  it.each([
    "none",
    "full",
  ] as const)("attributes every call and applies the %s text policy", async (store) => {
    const model = everyPathModel();
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
    await writeEveryPath(ai);
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

  const markers = [
    "request marker",
    "response marker",
    "tool input marker",
    "tool output marker",
    "instructions marker",
    "error body marker",
  ];

  it("clears every text field a TTL covers when engine.prune runs", async () => {
    const model = everyPathModel();
    const ai = createAIHelper(
      "accounting",
      db.aiLogger,
      undefined,
      () => model,
      { adapter, attribution, text: { store: "full", ttlMs: 60_000 } },
    );
    await writeEveryPath(ai);
    expect(await ai.flush()).toEqual({ failed: 0, pending: 0 });
    const where = { tenantId: attribution.tenantId };
    const kernel = db.makeKernel({ services: { aiLogger: db.aiLogger } });
    expect(
      await kernel.dispatch({
        type: "engine.prune",
        aiCallText: { now: new Date() },
      }),
    ).toMatchObject({ aiCallText: 0 });
    expect(
      await kernel.dispatch({
        type: "engine.prune",
        aiCallText: { now: new Date(Date.now() + 120_000) },
      }),
    ).toMatchObject({ aiCallText: 11 });
    const rows = await db.client.aICall.findMany({ where });
    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row).toMatchObject({
        prompt: "",
        response: "",
        textExpiresAt: null,
      });
      expect(row.metadata ?? {}).not.toHaveProperty("instructions");
      for (const marker of markers) {
        expect(JSON.stringify(row)).not.toContain(marker);
      }
    }
  });

  it.each([
    "calls",
    "checks for",
  ] as const)("keeps a custom logger read on ctx.aiLogger when a stage %s it", async (use) => {
    type Budget = { budgetRemaining?(topic: string): Promise<number> };
    const decisions: string[] = [];
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const logger = ctx.aiLogger as typeof ctx.aiLogger & Budget;
        const remaining =
          use === "calls" || typeof logger.budgetRemaining === "function"
            ? await logger.budgetRemaining!(ctx.ai.topic)
            : 0;
        decisions.push(remaining > 0 ? "approve" : "hold");
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        aiLogger: override(db.aiLogger as typeof db.aiLogger & Budget, {
          async budgetRemaining(topic: string) {
            return 10 - (await db.aiLogger.getStats(topic)).totalCost;
          },
        }),
        ai: createAIHelper,
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
    expect(decisions).toEqual(["approve"]);
    expect(
      await db.client.workflowStage.findFirst({ where: { workflowRunId } }),
    ).toMatchObject({ status: "COMPLETED" });
  });

  it("stamps the stage's run on rows written through ctx.aiLogger that name another run, so purging the run erases them", async () => {
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        await ctx.aiLogger.logCall({
          ...manual,
          modelId: manual.modelKey,
          topic: "direct",
          workflowRunId: "other-run",
        });
        const library = createAIHelper(
          "library",
          ctx.aiLogger,
          undefined,
          undefined,
          { attribution: { workflowRunId: "other-run" } },
        );
        library.recordCall(manual);
        await library.flush();
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: { aiLogger: db.aiLogger, ai: createAIHelper },
    });
    expect(
      (
        await executeJobWithHeartbeat(kernel, {
          job,
          jobTransport: db.jobTransport,
        })
      ).outcome,
    ).toBe("completed");
    expect(
      (await db.client.aICall.findMany()).map(
        (row: CreateAICallInput) => row.workflowRunId,
      ),
    ).toEqual([workflowRunId, workflowRunId]);
    await kernel.dispatch({ type: "run.transition", workflowRunId });
    expect(
      await kernel.dispatch({
        type: "run.purge",
        workflowRunIds: [workflowRunId],
      }),
    ).toMatchObject({ removed: { runs: 1, aiCalls: 2 } });
    expect(await db.client.aICall.count()).toBe(0);
  });

  it("erases every row a run's stage helpers wrote when the run is purged", async () => {
    const model = everyPathModel();
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        await writeEveryPath(ctx.ai);
        // A library given the stage logger, and a direct write.
        await createAIHelper("library", ctx.aiLogger, undefined, () => model)
          .batch(modelKey, "openrouter")
          .recordResults("batch-2", [
            {
              id: "item-3",
              status: "succeeded",
              prompt: "request marker",
              result: "response marker",
              inputTokens: 1,
              outputTokens: 1,
            },
          ]);
        await ctx.aiLogger.logCall({
          ...manual,
          modelId: manual.modelKey,
          topic: "direct",
        });
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, _resolver, options) =>
          createAIHelper(topic, logger, context, () => model, {
            ...options,
            adapter,
            text: { store: "full", ttlMs: 60_000 },
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
    await kernel.dispatch({ type: "run.transition", workflowRunId });
    expect(await db.client.aICall.count({ where: { workflowRunId } })).toBe(13);
    const purged = await kernel.dispatch({
      type: "run.purge",
      workflowRunIds: [workflowRunId],
    });
    expect(purged).toMatchObject({
      removed: { runs: 1, aiCalls: 13 },
      skipped: [],
      incomplete: [],
    });
    expect(await db.client.aICall.count()).toBe(0);
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
  // A logger of its own, so its flush counts only this test's writes.
  const freshLogger = () =>
    createPrismaAICallLogger(db.client, {
      databaseType: sqlite ? "sqlite" : "postgresql",
    });

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
              if (path === "stream abort") {
                controller.error(
                  Object.assign(new Error(sensitive), { name: "AbortError" }),
                );
                return;
              }
              if (path === "stream tool") {
                // Model-written arguments that fail the tool's schema.
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "count",
                  input: JSON.stringify({ n: sensitive }),
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage: {
                    inputTokens: {
                      total: 1,
                      noCache: undefined,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: {
                      total: 1,
                      text: undefined,
                      reasoning: undefined,
                    },
                  },
                });
                controller.close();
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
    ["stream abort", "none"],
    ["stream tool", "full"],
    ["zod adapter", "none"],
  ] as const)("keeps %s provider diagnostics out of AI call rows, console and trace output with %s capture", async (path, store) => {
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
            const { rawResult } = ctx.ai.streamText(
              modelKey,
              { prompt: "request marker" },
              {
                tools: {
                  count: {
                    inputSchema: z.object({ n: z.number() }),
                    execute: async () => 1,
                  },
                },
              },
            );
            for await (const part of rawResult!.fullStream) {
              if (part.type === "error" || part.type === "tool-error")
                throw part.error;
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
                // Zod's unrecognized-key message names the model's key.
                if (path === "zod adapter")
                  z.strictObject({}).parse({ [sensitive]: 1 });
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
      const rows = await db.client.aICall.findMany({
        where: { workflowRunId },
      });
      expect(eventSink.getByType("workflow:failed").length).toBe(
        path === "validation" ? 0 : 1,
      );
      expect(
        JSON.stringify([
          rows,
          ...output.map((spy) => spy.mock.calls),
          warnings.mock.calls,
        ]),
      ).not.toContain(sensitive);
      if (path === "realtime" || path === "durable") {
        // Workflow history keeps the provider's message, as earlier releases did.
        const stages = await db.client.workflowStage.findMany({
          where: { workflowRunId },
        });
        expect(JSON.stringify(stages)).toContain(sensitive);
      }
    } finally {
      for (const spy of [...output, warnings]) spy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    "none",
    "full",
  ] as const)("stores raw stage writes as given, with the run's attribution, under %s helper capture", async (store) => {
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
      // The helper's text policy covers the rows it builds, not these.
      expect(row).toMatchObject({
        ...attribution,
        workflowRunId,
        prompt: manual.prompt,
        response: manual.response,
        textExpiresAt: null,
        metadata: input.metadata,
      });
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

  // SQLite writes a batch row by row, as in earlier releases.
  it.skipIf(sqlite)(
    "rolls back a batch whose recording fails partway, so recordResults restores all of it",
    async () => {
      const refuse = [
        `CREATE FUNCTION refuse_second() RETURNS trigger AS $$ BEGIN IF NEW."requestId" = 'second' THEN RAISE EXCEPTION 'refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
        `CREATE TRIGGER refuse_second BEFORE INSERT ON "ai_calls" FOR EACH ROW EXECUTE FUNCTION refuse_second()`,
      ];
      const allow = [
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
    },
  );

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

  it("rejects an awaited stage write that the database refuses and counts both failures in ctx.aiLogger.flush", async () => {
    const call = {
      ...manual,
      modelId: manual.modelKey,
      topic: "external",
      batchId: "batch-1",
      requestId: "item-1",
    };
    const outcomes: unknown[] = [];
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
        // Ignored: handled and counted.
        void ctx.aiLogger.logCall(call);
        outcomes.push(await ctx.aiLogger.flush?.());
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: { aiLogger: freshLogger(), ai: createAIHelper },
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
    } finally {
      warn.mockRestore();
    }
    expect(outcomes).toEqual([
      "AI call accounting write failed",
      { failed: 2, pending: 0 },
    ]);
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

  it("hands a durable step's retryIf the provider's retryable error, as earlier releases did", async () => {
    const seen: unknown[] = [];
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        await ctx.step.run(
          "call",
          () => ctx.ai.generateText(modelKey, "request marker"),
          {
            retries: 1,
            retryIf: (error) => {
              seen.push(error);
              return APICallError.isInstance(error) && error.isRetryable;
            },
          },
        );
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, resolver, options) =>
          createAIHelper(topic, logger, context, resolver, {
            ...options,
            text: { store: "none" },
            adapter: {
              async generateText() {
                throw new APICallError({
                  message: sensitive,
                  url: "https://provider.invalid/v1",
                  requestBodyValues: {},
                  statusCode: 503,
                  isRetryable: true,
                });
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
    await host.handleJob({ ...job, maxAttempts: 3 });
    expect(seen).toHaveLength(1);
    expect(APICallError.isInstance(seen[0])).toBe(true);
    expect(
      await db.client.workflowStage.findFirst({ where: { workflowRunId } }),
    ).toMatchObject({ status: "SUSPENDED" });
    const rows = await db.client.aICall.findMany({ where: { workflowRunId } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(sensitive);
  });

  it.each([
    "none",
    "full",
  ] as const)("applies a child helper's %s capture and labels to its own rows, not to direct stage writes", async (store) => {
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        ctx.ai.recordCall({ ...manual, response: sensitive });
        await ctx.aiLogger.logCall({
          ...manual,
          response: sensitive,
          modelId: manual.modelKey,
          topic: "scope",
          metadata: { instructions: sensitive },
        });
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        // The documented factory shape, returning a child helper.
        ai: (topic, logger, context, resolver, options) =>
          createAIHelper(topic, logger, context, resolver, options).createChild(
            "private",
            undefined,
            {
              text: { store, ttlMs: 60_000 },
              attribution: { labels: { scope: "child" } },
            },
          ),
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
      if (row.topic === "scope") {
        expect(row).toMatchObject({
          ...attribution,
          workflowRunId,
          response: sensitive,
          textExpiresAt: null,
        });
        continue;
      }
      expect(row).toMatchObject({
        tenantId: attribution.tenantId,
        labels: { ...attribution.labels, scope: "child" },
        workflowRunId,
      });
      if (store === "none") {
        expect(row).toMatchObject({ response: "", textExpiresAt: null });
        expect(JSON.stringify(row)).not.toContain(sensitive);
      } else {
        expect(row.response).toBe(sensitive);
        expect(row.textExpiresAt).toBeInstanceOf(Date);
      }
    }
  });

  it("charges a stream's usage after an error part and counts it in the run total", async () => {
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const { rawResult } = ctx.ai.streamText(modelKey, {
          prompt: "request marker",
        });
        for await (const _ of rawResult!.fullStream) {
          // Consume every part, including the error.
        }
        await ctx.ai.flush();
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, _resolver, options) =>
          createAIHelper(
            topic,
            logger,
            context,
            () =>
              new MockLanguageModelV4({
                async doStream() {
                  return {
                    stream: new ReadableStream({
                      start(controller) {
                        controller.enqueue({
                          type: "stream-start",
                          warnings: [],
                        });
                        controller.enqueue({
                          type: "error",
                          error: new Error("stream error"),
                        });
                        controller.enqueue({
                          type: "finish",
                          finishReason: { unified: "stop", raw: "stop" },
                          usage: {
                            inputTokens: {
                              total: 2,
                              noCache: undefined,
                              cacheRead: undefined,
                              cacheWrite: undefined,
                            },
                            outputTokens: {
                              total: 3,
                              text: undefined,
                              reasoning: undefined,
                            },
                          },
                        });
                        controller.close();
                      },
                    }),
                  };
                },
              }),
            options,
          ),
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
    const rows = await db.client.aICall.findMany({ where: { workflowRunId } });
    expect(
      rows.map((row: CreateAICallInput) => row.inputTokens + row.outputTokens),
    ).toContain(5);
    expect(
      await db.client.workflowRun.findUnique({ where: { id: workflowRunId } }),
    ).toMatchObject({ status: "COMPLETED", totalTokens: 5 });
  });

  // V4 usage for a stream finish or a generation.
  const v4Usage = (input: number, output: number) => ({
    inputTokens: {
      total: input,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  });

  const succeeded = {
    id: "item-1",
    status: "succeeded",
    prompt: "request marker",
    result: "response marker",
    inputTokens: 1,
    outputTokens: 1,
  } as const;

  it("keeps a library helper's own TTL on rows it writes through ctx.aiLogger", async () => {
    const start = Date.now();
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const library = createAIHelper(
          "library",
          ctx.aiLogger,
          undefined,
          undefined,
          { text: { store: "full", ttlMs: 60_000 } },
        );
        library.recordCall(manual);
        await library
          .batch(modelKey, "openrouter")
          .recordResults("batch-1", [succeeded]);
        ctx.ai.recordCall(manual);
        await library.flush();
        await ctx.ai.flush();
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, resolver, options) =>
          createAIHelper(topic, logger, context, resolver, {
            ...options,
            text: { store: "full", ttlMs: 86_400_000 },
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
    const rows = await db.client.aICall.findMany({ where: { workflowRunId } });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const ttlMs = row.topic.startsWith("library") ? 60_000 : 86_400_000;
      expect(row.textExpiresAt.getTime()).toBeGreaterThanOrEqual(start + ttlMs);
      expect(row.textExpiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + ttlMs,
      );
    }
    expect(
      await kernel.dispatch({
        type: "engine.prune",
        aiCallText: { now: new Date(Date.now() + 120_000) },
      }),
    ).toMatchObject({ aiCallText: 2 });
    for (const row of await db.client.aICall.findMany({
      where: { workflowRunId },
    })) {
      expect(row.response).toBe(
        row.topic.startsWith("library") ? "" : manual.response,
      );
    }
  });

  it("keeps a library child's labels alongside the run's on rows it writes through ctx.aiLogger", async () => {
    const queue = { attribution: { labels: { queue: "background" } } };
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const library = createAIHelper("library", ctx.aiLogger).createChild(
          "worker",
          undefined,
          queue,
        );
        library.recordCall(manual);
        await library
          .batch(modelKey, "openrouter")
          .recordResults("batch-1", [succeeded]);
        const native = ctx.ai.createChild("worker", undefined, queue);
        native.recordCall(manual);
        await library.flush();
        await native.flush();
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: { aiLogger: db.aiLogger, ai: createAIHelper },
    });
    expect(
      (
        await executeJobWithHeartbeat(kernel, {
          job,
          jobTransport: db.jobTransport,
        })
      ).outcome,
    ).toBe("completed");
    const rows = await db.client.aICall.findMany({ where: { workflowRunId } });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        tenantId: attribution.tenantId,
        workflowRunId,
        labels: { ...attribution.labels, queue: "background" },
      });
    }
  });

  it.each([
    "stored",
    "refused",
  ] as const)("counts a held direct write that is %s in ctx.aiLogger.flush when the configured logger has no flush", async (result) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const observed: Record<string, unknown> = {};
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const write = Promise.resolve(
          ctx.aiLogger.logCall({
            ...manual,
            modelId: manual.modelKey,
            topic: "direct",
          }),
        ).then(
          () => "stored",
          (error: Error) => error.message,
        );
        await entered.promise;
        observed.held = await ctx.aiLogger.flush?.({ timeoutMs: 15 });
        observed.rowsWhileHeld = await db.client.aICall.count({
          where: { topic: "direct" },
        });
        release.resolve();
        observed.awaited = await write;
        observed.settled = await ctx.aiLogger.flush?.();
        return { output: {} };
      },
    });
    const configured = freshLogger();
    const aiLogger: AICallLogger & Pick<typeof configured, "transactionReads"> =
      {
        async logCall(call: CreateAICallInput) {
          entered.resolve();
          await release.promise;
          if (result === "refused") throw new Error(`refused ${sensitive}`);
          await configured.logCall(call);
        },
        logBatchResults: (batchId, calls) =>
          configured.logBatchResults(batchId, calls),
        getStats: (topic) => configured.getStats(topic),
        isRecorded: (batchId) => configured.isRecorded(batchId),
        transactionReads: (persistence) =>
          configured.transactionReads(persistence),
      };
    const { kernel, job } = await queueJob(stage, {
      services: { aiLogger, ai: createAIHelper },
    });
    expect(
      (
        await executeJobWithHeartbeat(kernel, {
          job,
          jobTransport: db.jobTransport,
        })
      ).outcome,
    ).toBe("completed");
    expect(observed).toEqual({
      held: { failed: 0, pending: 1 },
      rowsWhileHeld: 0,
      awaited:
        result === "stored" ? "stored" : "AI call accounting write failed",
      settled: { failed: result === "refused" ? 1 : 0, pending: 0 },
    });
    expect(await db.client.aICall.count({ where: { topic: "direct" } })).toBe(
      result === "stored" ? 1 : 0,
    );
  });

  it("counts a direct write the run's write fence refuses once, in ctx.aiLogger.flush", async () => {
    const configured = freshLogger();
    // The job's own registration is refused, so each write registers alone;
    // the stage's write is refused with a database error.
    let registration: "allow" | "refuse job" | "fail" = "allow";
    const persistence = override(db.persistence, {
      async beginRunWrite(workflowRunId: string, id: string) {
        if (registration === "refuse job") return false;
        if (registration === "fail") throw new Error(`refused ${sensitive}`);
        return db.persistence.beginRunWrite!(workflowRunId, id);
      },
    });
    const observed: Record<string, unknown> = {};
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        registration = "fail";
        observed.write = await Promise.resolve(
          ctx.aiLogger.logCall({
            ...manual,
            modelId: manual.modelKey,
            topic: "direct",
          }),
        ).then(
          () => "stored",
          (error: Error) => error.message,
        );
        registration = "allow";
        observed.stage = await ctx.aiLogger.flush?.();
        observed.configured = await configured.flush();
        return { output: {} };
      },
    });
    const { kernel, job } = await queueJob(stage, {
      persistence,
      services: { aiLogger: configured, ai: createAIHelper },
    });
    registration = "refuse job";
    expect(
      (
        await executeJobWithHeartbeat(kernel, {
          job,
          jobTransport: db.jobTransport,
        })
      ).outcome,
    ).toBe("completed");
    expect(observed).toEqual({
      write: "AI call accounting write failed",
      stage: { failed: 1, pending: 0 },
      configured: { failed: 0, pending: 0 },
    });
    expect(await db.client.aICall.count({ where: { topic: "direct" } })).toBe(
      0,
    );
  });

  it("leaves a direct write the configured logger rejects to that logger's flush, counted once", async () => {
    const configured = freshLogger();
    const call = {
      ...manual,
      modelId: manual.modelKey,
      topic: "external",
      batchId: "batch-1",
      requestId: "item-1",
    };
    const observed: Record<string, unknown> = {};
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        await ctx.aiLogger.logCall(call);
        observed.write = await Promise.resolve(ctx.aiLogger.logCall(call)).then(
          () => "stored",
          (error: Error) => error.message,
        );
        observed.stage = await ctx.aiLogger.flush?.();
        observed.configured = await configured.flush();
        return { output: {} };
      },
    });
    const { kernel, job } = await queueJob(stage, {
      services: { aiLogger: configured, ai: createAIHelper },
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
    } finally {
      warn.mockRestore();
    }
    expect(observed).toEqual({
      write: "AI call accounting write failed",
      stage: { failed: 1, pending: 0 },
      configured: { failed: 1, pending: 0 },
    });
  });

  // Rows wait in the logger until its flush inserts them; a write settles
  // once its row is inserted. Its methods rely on `this`.
  class BufferedLogger implements AICallLogger {
    readonly queue: [CreateAICallInput, PromiseWithResolvers<void>][] = [];
    constructor(readonly inner: ReturnType<typeof createPrismaAICallLogger>) {}
    logCall(call: CreateAICallInput) {
      const written = Promise.withResolvers<void>();
      this.queue.push([call, written]);
      return written.promise;
    }
    logBatchResults(batchId: string, calls: CreateAICallInput[]) {
      return this.inner.logBatchResults(batchId, calls);
    }
    getStats(topic: string) {
      return this.inner.getStats(topic);
    }
    isRecorded(batchId: string) {
      return this.inner.isRecorded(batchId);
    }
    transactionReads(
      persistence: Parameters<typeof this.inner.transactionReads>[0],
    ) {
      return this.inner.transactionReads(persistence);
    }
    async flush() {
      for (const [call, written] of this.queue.splice(0)) {
        await this.inner.logCall(call).then(written.resolve, written.reject);
      }
      return { failed: 0, pending: this.queue.length };
    }
  }

  it.each([
    "with",
    "without",
  ] as const)("sends a class-based buffered logger's direct write when the stage flushes ctx.aiLogger %s the run's write fence, so the run total and completion event count it", async (fence) => {
    const buffered = new BufferedLogger(freshLogger());
    const observed: Record<string, unknown> = {};
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        observed.idle = await ctx.aiLogger.flush?.();
        void ctx.aiLogger.logCall({
          ...manual,
          modelId: manual.modelKey,
          topic: `workflow.${ctx.workflowRunId}.stage.direct`,
          cost: 1.25,
        });
        observed.flushed = await ctx.aiLogger.flush?.();
        observed.rows = await db.client.aICall.count({
          where: { workflowRunId: ctx.workflowRunId },
        });
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      // Persistence without run write registration has no write fence.
      ...(fence === "without" && {
        persistence: override(db.persistence, { beginRunWrite: undefined }),
      }),
      services: { aiLogger: buffered, ai: createAIHelper },
    });
    try {
      expect(
        (
          await executeJobWithHeartbeat(kernel, {
            job,
            jobTransport: db.jobTransport,
          })
        ).outcome,
      ).toBe("completed");
      await kernel.dispatch({ type: "run.transition", workflowRunId });
    } finally {
      await buffered.flush();
    }
    expect(observed).toEqual({
      idle: { failed: 0, pending: 0 },
      flushed: { failed: 0, pending: 0 },
      rows: 1,
    });
    expect(
      await db.client.workflowRun.findUnique({ where: { id: workflowRunId } }),
    ).toMatchObject({ status: "COMPLETED", totalCost: 1.25, totalTokens: 5 });
    const [completed] = await db.client.outboxEvent.findMany({
      where: { workflowRunId, eventType: "workflow:completed" },
    });
    expect(completed.payload).toMatchObject({
      totalCost: 1.25,
      totalTokens: 5,
    });
  });

  it.each([
    ["the run's write fence", 1],
    ["the run's write fence", 2],
    ["the configured logger", 1],
    ["the configured logger", 2],
  ] as const)("counts each direct write held by %s once in ctx.aiLogger.flush (%i writes)", async (holder, count) => {
    const configured = freshLogger();
    const held = Promise.withResolvers<void>();
    // The job's own registration is refused, so each write registers alone
    // and waits while registration is held.
    let registration: "allow" | "refuse job" | "hold" = "allow";
    const persistence = override(db.persistence, {
      async beginRunWrite(workflowRunId: string, id: string) {
        if (registration === "refuse job") return false;
        if (registration === "hold") await held.promise;
        return db.persistence.beginRunWrite!(workflowRunId, id);
      },
    });
    // Restores the logger's own client, which its transaction reads match.
    let restore = () => {};
    if (holder === "the configured logger") {
      // The stock logger's inserts wait; it counts them as pending.
      const port = configured as unknown as { prisma: any };
      const client = port.prisma;
      restore = () => {
        port.prisma = client;
      };
      const bind = (target: any, key: PropertyKey) => {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      };
      const aICall = new Proxy(port.prisma.aICall, {
        get: (delegate, key) =>
          key === "create" || key === "createMany"
            ? async (...args: unknown[]) => {
                await held.promise;
                return delegate[key](...args);
              }
            : bind(delegate, key),
      });
      port.prisma = new Proxy(port.prisma, {
        get: (client, key) => (key === "aICall" ? aICall : bind(client, key)),
      });
    }
    const row = { ...manual, modelId: manual.modelKey, topic: "direct" };
    const observed: Record<string, unknown> = {};
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        if (holder === "the run's write fence") registration = "hold";
        const writes = [ctx.aiLogger.logCall(row)];
        if (count === 2) {
          writes.push(
            ctx.aiLogger.logBatchResults("batch-1", [
              { ...row, requestId: "item-1" },
            ]),
          );
        }
        observed.stage = await ctx.aiLogger.flush?.({ timeoutMs: 50 });
        observed.configured = await configured.flush({ timeoutMs: 0 });
        observed.again = await ctx.aiLogger.flush?.({ timeoutMs: 0 });
        registration = "allow";
        held.resolve();
        await Promise.all(writes);
        restore();
        observed.settled = await ctx.aiLogger.flush?.();
        return { output: {} };
      },
    });
    const { kernel, job } = await queueJob(stage, {
      persistence,
      services: { aiLogger: configured, ai: createAIHelper },
    });
    if (holder === "the run's write fence") registration = "refuse job";
    expect(
      (
        await executeJobWithHeartbeat(kernel, {
          job,
          jobTransport: db.jobTransport,
        })
      ).outcome,
    ).toBe("completed");
    const inLogger = holder === "the configured logger" ? count : 0;
    expect(observed).toEqual({
      stage: { failed: 0, pending: count },
      configured: { failed: 0, pending: inLogger },
      again: { failed: 0, pending: count },
      settled: { failed: 0, pending: 0 },
    });
    expect(await db.client.aICall.count({ where: { topic: "direct" } })).toBe(
      count,
    );
  });

  it.each([
    "a plain object",
    "a class instance",
  ] as const)("keeps every member of a configured logger that is %s when a stage spreads ctx.aiLogger into a decorator", async (shape) => {
    const configured = freshLogger();
    const aiLogger: AICallLogger & Pick<typeof configured, "transactionReads"> =
      shape === "a class instance"
        ? configured
        : {
            logCall: (call) => configured.logCall(call),
            logBatchResults: (batchId, calls) =>
              configured.logBatchResults(batchId, calls),
            getStats: (topic) => configured.getStats(topic),
            listCalls: (options) => configured.listCalls(options),
            isRecorded: (batchId) => configured.isRecorded(batchId),
            transactionReads: (persistence) =>
              configured.transactionReads(persistence),
          };
    let metered = 0;
    const observed: Record<string, unknown> = {};
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const source = ctx.aiLogger;
        const decorated = {
          ...source,
          logCall(call: CreateAICallInput) {
            metered++;
            return source.logCall(call);
          },
        };
        await decorated.logCall({
          ...manual,
          modelId: manual.modelKey,
          topic: `workflow.${ctx.workflowRunId}.stage.direct`,
        });
        observed.cost = (
          await decorated.getStats(`workflow.${ctx.workflowRunId}`)
        ).totalCost;
        observed.recorded = await decorated.isRecorded("no-such-batch");
        observed.flushed = await decorated.flush?.();
        return { output: {} };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: { aiLogger, ai: createAIHelper },
    });
    expect(
      (
        await executeJobWithHeartbeat(kernel, {
          job,
          jobTransport: db.jobTransport,
        })
      ).outcome,
    ).toBe("completed");
    expect({ metered, ...observed }).toEqual({
      metered: 1,
      cost: manual.cost,
      recorded: false,
      flushed: { failed: 0, pending: 0 },
    });
    expect(await db.client.aICall.count({ where: { workflowRunId } })).toBe(1);
  });

  it.each([
    "",
    "1",
  ])("hands provider warnings to the stage unchanged with WORKFLOW_ENGINE_TRACE=%j", async (trace) => {
    vi.stubEnv("WORKFLOW_ENGINE_TRACE", trace);
    vi.stubEnv("WORKFLOW_ENGINE_TRACE_TEXT", "");
    const ignored = [{ type: "unsupported", feature: "temperature" }] as const;
    const seen: unknown[] = [];
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        await ctx.ai.generateText(modelKey, "request marker", {
          temperature: 0.3,
          // The step callback is available with tools.
          tools: {
            inspect: {
              inputSchema: z.object({}),
              execute: async () => "unused",
            },
          },
          onStepEnd: (step) => {
            seen.push(step.warnings);
          },
        });
        const { rawResult } = ctx.ai.streamText(
          modelKey,
          { prompt: "request marker" },
          { temperature: 0.3 },
        );
        for await (const _ of rawResult!.fullStream) {
          // Consume the stream.
        }
        seen.push(await rawResult!.warnings);
        return { output: {} };
      },
    });
    const model = new MockLanguageModelV4({
      async doGenerate() {
        return {
          content: [{ type: "text", text: "reply" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: v4Usage(1, 1),
          warnings: [...ignored],
        };
      },
      async doStream() {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "stream-start",
                warnings: [...ignored],
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: v4Usage(1, 1),
              });
              controller.close();
            },
          }),
        };
      },
    });
    const { kernel, job } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, _resolver, options) =>
          createAIHelper(topic, logger, context, () => model, options),
      },
    });
    const output = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(process, "emitWarning").mockImplementation(() => {}),
    ];
    try {
      expect(
        (
          await executeJobWithHeartbeat(kernel, {
            job,
            jobTransport: db.jobTransport,
          })
        ).outcome,
      ).toBe("completed");
    } finally {
      for (const spy of output) spy.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(seen).toEqual([ignored, ignored]);
  });

  it.each([
    [false, [], "completed", "COMPLETED"],
    [true, ["text", "object", "stream"], "suspended", "SUSPENDED"],
  ] as const)("calls the caller's onStepEnd with tools=%s only when tools are set", async (withTools, calls, outcome, status) => {
    const seen: string[] = [];
    const tools = {
      inspect: { inputSchema: z.object({}), execute: async () => "unused" },
    };
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const options = (call: string) => ({
          ...(withTools && { tools }),
          onStepEnd: () => {
            seen.push(call);
          },
        });
        await ctx.ai.generateText(modelKey, "request marker", options("text"));
        await ctx.ai.generateObject(
          modelKey,
          "request marker",
          z.object({}),
          options("object"),
        );
        const { rawResult } = ctx.ai.streamText(
          modelKey,
          { prompt: "request marker" },
          options("stream"),
        );
        for await (const _ of rawResult!.fullStream) {
          // Consume the stream.
        }
        // A step callback decides whether the stage waits for review.
        if (seen.length > 0) await ctx.step.sleep("review-delay", "30s");
        return { output: {} };
      },
    });
    const model = new MockLanguageModelV4({
      async doGenerate() {
        return {
          content: [{ type: "text", text: "{}" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: v4Usage(1, 1),
          warnings: [],
        };
      },
      async doStream() {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: v4Usage(1, 1),
              });
              controller.close();
            },
          }),
        };
      },
    });
    const { kernel, job, workflowRunId } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, _resolver, options) =>
          createAIHelper(topic, logger, context, () => model, options),
      },
    });
    expect(
      (
        await executeJobWithHeartbeat(kernel, {
          job,
          jobTransport: db.jobTransport,
        })
      ).outcome,
    ).toBe(outcome);
    await kernel.flush();
    expect(seen).toEqual(calls);
    expect(
      await db.client.workflowStage.findFirst({ where: { workflowRunId } }),
    ).toMatchObject({ status });
  });

  it("keeps a child's stream pending until the charge after an error part is written", async () => {
    const finish = Promise.withResolvers<void>();
    const observed: {
      childPending?: number;
      parentFlush?: unknown;
      rowsAtFlush?: unknown[];
    } = {};
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const child = ctx.ai.createChild("chat");
        const { rawResult } = child.streamText(modelKey, {
          prompt: "request marker",
        });
        const sawError = Promise.withResolvers<void>();
        const consumed = (async () => {
          for await (const part of rawResult!.fullStream) {
            if (part.type === "error") sawError.resolve();
          }
        })();
        await sawError.promise;
        // The error row settles; the stream is still open.
        observed.childPending = (await child.flush({ timeoutMs: 200 })).pending;
        const parentFlush = ctx.ai.flush({ timeoutMs: 2_000 });
        setTimeout(() => finish.resolve(), 150);
        observed.parentFlush = await parentFlush;
        observed.rowsAtFlush = await db.client.aICall.findMany({
          where: { workflowRunId: ctx.workflowRunId },
        });
        await consumed;
        return { output: {} };
      },
    });
    const model = new MockLanguageModelV4({
      async doStream() {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "error",
                error: new Error("stream error"),
              });
              void finish.promise.then(() => {
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: v4Usage(2, 3),
                });
                controller.close();
              });
            },
          }),
        };
      },
    });
    const { kernel, job } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, _resolver, options) =>
          createAIHelper(topic, logger, context, () => model, options),
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
    // The request and the usage read that writes its charge.
    expect(observed.childPending).toBeGreaterThan(0);
    expect(observed.parentFlush).toEqual({ failed: 0, pending: 0 });
    expect(
      (observed.rowsAtFlush as CreateAICallInput[]).map((row) => [
        row.inputTokens,
        row.outputTokens,
      ]),
    ).toContainEqual([2, 3]);
  });

  // A provider stream of the given parts; `held` delays the rest, and an
  // abort fails the held request as a transport would.
  const partsStream = (
    parts: object[],
    held?: Promise<object[]>,
    signal?: AbortSignal,
  ) =>
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        if (!held) return controller.close();
        signal?.addEventListener("abort", () =>
          controller.error(signal.reason),
        );
        void held.then((rest) => {
          for (const part of rest) controller.enqueue(part);
          controller.close();
        });
      },
    });

  it.each([
    ["resumed", false, [[3, 4]]],
    ["aborted", false, []],
    // The usage reader writes its failure row after the abort.
    ["aborted", true, [[0, 0]]],
  ] as const)("keeps a paused stream pending until its request is %s (usage reader: %s)", async (end, usageReader, charges) => {
    const finish = Promise.withResolvers<object[]>();
    const abort = new AbortController();
    const observed: {
      paused?: number;
      parentFlush?: unknown;
      rowsAtFlush?: CreateAICallInput[];
    } = {};
    let calls = 0;
    const model = new MockLanguageModelV4({
      async doStream({ abortSignal }) {
        calls++;
        return {
          stream:
            calls === 1
              ? partsStream([
                  { type: "stream-start", warnings: [] },
                  {
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName: "lookup",
                    input: "{}",
                  },
                  {
                    type: "finish",
                    finishReason: { unified: "tool-calls", raw: "tool_calls" },
                    usage: v4Usage(1, 1),
                  },
                ])
              : partsStream(
                  [
                    { type: "stream-start", warnings: [] },
                    { type: "text-start", id: "1" },
                    { type: "text-delta", id: "1", delta: "a" },
                  ],
                  finish.promise,
                  abortSignal,
                ),
        };
      },
    });
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const child = ctx.ai.createChild("chat");
        const result = child.streamText(
          modelKey,
          { prompt: "request marker" },
          {
            abortSignal: abort.signal,
            stopWhen: stepCountIs(2),
            tools: {
              lookup: { inputSchema: z.object({}), execute: async () => "ok" },
            },
          },
        );
        // The consumer reads one chunk and stops.
        const reader = result.stream[Symbol.asyncIterator]();
        await reader.next();
        observed.paused = (await child.flush({ timeoutMs: 50 })).pending;
        const reading = usageReader
          ? result.getUsage()
          : (async () => {
              while (!(await reader.next()).done);
            })();
        if (end === "aborted") abort.abort();
        else
          finish.resolve([
            { type: "text-end", id: "1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: v4Usage(2, 3),
            },
          ]);
        observed.parentFlush = await ctx.ai.flush({ timeoutMs: 2_000 });
        observed.rowsAtFlush = await db.client.aICall.findMany({
          where: { workflowRunId: ctx.workflowRunId },
        });
        await reading;
        return { output: {} };
      },
    });
    // Slow inserts, so a flush that returns early cannot see the row.
    const aiLogger = Object.assign(Object.create(db.aiLogger), {
      async logCall(call: CreateAICallInput) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return db.aiLogger.logCall(call);
      },
    });
    const { kernel, job } = await queueJob(stage, {
      services: {
        aiLogger,
        ai: (topic, logger, context, _resolver, options) =>
          createAIHelper(topic, logger, context, () => model, options),
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
    expect(observed.paused).toBe(1);
    expect(observed.parentFlush).toEqual({ failed: 0, pending: 0 });
    expect(
      observed.rowsAtFlush!.map((row) => [row.inputTokens, row.outputTokens]),
    ).toEqual(charges);
  });

  it.each([
    "tool output",
    "unfinished step",
  ] as const)("ends a child's tool stream when the %s ends the request without a row", async (path) => {
    const observed: { flushes?: unknown[]; failed: boolean } = {
      failed: false,
    };
    let calls = 0;
    const model = new MockLanguageModelV4({
      async doStream() {
        calls++;
        return {
          stream: partsStream(
            calls === 1
              ? [
                  { type: "stream-start", warnings: [] },
                  {
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName: "lookup",
                    input: "{}",
                  },
                  {
                    type: "finish",
                    finishReason: { unified: "tool-calls", raw: "tool_calls" },
                    usage: v4Usage(1, 1),
                  },
                ]
              : // The second step closes without a finish.
                [{ type: "stream-start", warnings: [] }],
          ),
        };
      },
    });
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const child = ctx.ai.createChild("item");
        const { rawResult } = child.streamText(
          modelKey,
          { prompt: "request marker" },
          {
            maxRetries: 0,
            stopWhen: stepCountIs(2),
            tools: {
              lookup: {
                inputSchema: z.object({}),
                execute: async () => "result-1",
                // Fetching the referenced result for the next step fails.
                ...(path === "tool output" && {
                  toModelOutput: async () => {
                    throw new TypeError("fetch failed");
                  },
                }),
              },
            },
          },
        );
        try {
          for await (const _ of rawResult!.fullStream) {
            // Drain the stream.
          }
        } catch {
          observed.failed = true;
        }
        observed.flushes = [
          await child.flush({ timeoutMs: 2_000 }),
          await ctx.ai.flush({ timeoutMs: 2_000 }),
        ];
        return { output: {} };
      },
    });
    const { kernel, job } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, _resolver, options) =>
          createAIHelper(topic, logger, context, () => model, options),
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
    expect(observed.failed).toBe(path === "tool output");
    expect(observed.flushes).toEqual([
      { failed: 0, pending: 0 },
      { failed: 0, pending: 0 },
    ]);
  });

  it("keeps a stream pending after its client disconnects until the usage reader's charge is written", async () => {
    const finish = Promise.withResolvers<object[]>();
    const observed: {
      childPending?: number;
      parentFlush?: unknown;
      rowsAtFlush?: CreateAICallInput[];
    } = {};
    const model = new MockLanguageModelV4({
      async doStream() {
        return {
          stream: partsStream(
            [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "a" },
              { type: "text-delta", id: "1", delta: "b" },
            ],
            finish.promise,
          ),
        };
      },
    });
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const child = ctx.ai.createChild("chat");
        let delivered = 0;
        const result = child.streamText(
          modelKey,
          { prompt: "request marker" },
          {
            // The client's response body is cancelled after one chunk.
            onChunk: () => {
              if (++delivered > 1)
                throw new TypeError(
                  "Invalid state: Controller is already closed",
                );
            },
          },
        );
        const usage = result.getUsage();
        try {
          for await (const _ of result.stream) {
            // Deliver to the client.
          }
        } catch {
          // The delivery ended; the usage reader continues.
        }
        // The delivery error's row settles; the request is still open.
        observed.childPending = (await child.flush({ timeoutMs: 200 })).pending;
        const parentFlush = ctx.ai.flush({ timeoutMs: 2_000 });
        setTimeout(
          () =>
            finish.resolve([
              { type: "text-end", id: "1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: v4Usage(2, 3),
              },
            ]),
          150,
        );
        observed.parentFlush = await parentFlush;
        observed.rowsAtFlush = await db.client.aICall.findMany({
          where: { workflowRunId: ctx.workflowRunId },
        });
        await usage;
        return { output: {} };
      },
    });
    const { kernel, job } = await queueJob(stage, {
      services: {
        aiLogger: db.aiLogger,
        ai: (topic, logger, context, _resolver, options) =>
          createAIHelper(topic, logger, context, () => model, options),
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
    // The open request and the usage readers still writing its row.
    expect(observed.childPending).toBeGreaterThan(0);
    expect(observed.parentFlush).toEqual({ failed: 0, pending: 0 });
    expect(
      observed.rowsAtFlush!.map((row) => [row.inputTokens, row.outputTokens]),
    ).toContainEqual([2, 3]);
  });

  it.each([
    // Only the usage reader writes a row after an abort.
    ["getUsage", "after abort", "abort", true],
    ["getText", "after abort", "abort", false],
    ["getReasoning", "after abort", "abort", false],
    ["getUsage", "before flush", "tool failure", true],
    ["getText", "before flush", "tool failure", true],
    ["getReasoning", "before flush", "tool failure", true],
    ["stream", "before flush", "tool failure", true],
    ["getText", "during flush", "tool failure", true],
    ["getUsage", "during flush", "finish", true],
    ["getText", "before flush", "error part then finish", true],
  ] as const)("waits for a %s reader started %s when the request ends by %s", async (reader, start, end, writes) => {
    const release = Promise.withResolvers<void>();
    const secondStep = Promise.withResolvers<void>();
    const abort = new AbortController();
    const observed: { flush?: unknown; atFlush?: unknown[]; rows?: unknown[] } =
      {};
    let calls = 0;
    const model = new MockLanguageModelV4({
      async doStream({ abortSignal }) {
        if (++calls === 1)
          return {
            stream: partsStream([
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "lookup",
                input: "{}",
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: v4Usage(1, 1),
              },
            ]),
          };
        secondStep.resolve();
        const finish = [
          { type: "text-end", id: "1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: v4Usage(2, 3),
          },
        ];
        return {
          stream: partsStream(
            [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "a" },
            ],
            release.promise.then(() =>
              end === "error part then finish"
                ? [{ type: "error", error: new Error("overloaded") }, ...finish]
                : finish,
            ),
            abortSignal,
          ),
        };
      },
    });
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const result = ctx.ai.createChild("chat").streamText(
          modelKey,
          { prompt: "request marker" },
          {
            abortSignal: abort.signal,
            stopWhen: stepCountIs(2),
            tools: {
              lookup: {
                inputSchema: z.object({}),
                execute: async () => "ref-1",
                // Fetching the referenced result fails once the flush waits.
                ...(end === "tool failure" && {
                  toModelOutput: async () => {
                    await release.promise;
                    throw new TypeError("fetch failed");
                  },
                }),
              },
            },
          },
        );
        // The SDK's own reader drives the request.
        const raw = (async () => {
          for await (const _ of result.rawResult!.fullStream) {
            // Drain the stream.
          }
        })().catch(() => {});
        // The stage handles the reader's outcome; flush must still wait for it.
        const read = () =>
          (reader === "stream"
            ? (async () => {
                for await (const _ of result.stream) {
                  // Deliver to the client.
                }
              })()
            : result[reader]()
          ).catch(() => {});
        const rows = async () =>
          (
            await db.client.aICall.findMany({
              where: { workflowRunId: ctx.workflowRunId },
            })
          )
            .map((row: CreateAICallInput) => [
              row.inputTokens,
              row.outputTokens,
              row.cost,
            ])
            .sort();
        let reading: Promise<unknown>;
        let flush: Promise<unknown>;
        if (start === "after abort") {
          await secondStep.promise;
          abort.abort();
          await raw;
          await ctx.ai.flush();
          reading = read();
          flush = ctx.ai.flush({ timeoutMs: 2_000 });
        } else if (start === "before flush") {
          reading = read();
          flush = ctx.ai.flush({ timeoutMs: 2_000 });
          release.resolve();
        } else {
          flush = ctx.ai.flush({ timeoutMs: 2_000 });
          reading = read();
          release.resolve();
        }
        observed.flush = await flush;
        observed.atFlush = await rows();
        await reading;
        await ctx.ai.flush();
        observed.rows = await rows();
        return { output: {} };
      },
    });
    const { kernel, job } = await queueJob(stage, {
      services: {
        // Slow inserts, so a flush that returns early cannot see the row.
        aiLogger: override(db.aiLogger, {
          async logCall(call) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await db.aiLogger.logCall(call);
          },
        }),
        ai: (topic, logger, context, _resolver, options) =>
          createAIHelper(topic, logger, context, () => model, options),
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
    expect(observed.flush).toEqual({ failed: 0, pending: 0 });
    expect(observed.rows!.length > 0).toBe(writes);
    expect(observed.atFlush).toEqual(observed.rows);
  });

  it.each([
    "text generation",
    "batch results",
  ] as const)("waits for %s requested before the flush", async (work) => {
    const observed: { flush?: unknown; rows?: number } = {};
    const model = new MockLanguageModelV4({
      async doGenerate() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          content: [{ type: "text", text: "reply" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: v4Usage(2, 3),
          warnings: [],
        };
      },
    });
    const stage = defineStage({
      ...diagnosticsStage,
      async execute(ctx) {
        const child = ctx.ai.createChild("work");
        const requested =
          work === "batch results"
            ? child
                .batch(modelKey, "openrouter", batchTransport)
                .getResults("batch-1")
            : child.generateText(modelKey, "request marker");
        observed.flush = await ctx.ai.flush({ timeoutMs: 2_000 });
        observed.rows = await db.client.aICall.count({
          where: { workflowRunId: ctx.workflowRunId },
        });
        await requested;
        return { output: {} };
      },
    });
    const slowly = () => new Promise((resolve) => setTimeout(resolve, 100));
    const { kernel, job } = await queueJob(stage, {
      services: {
        aiLogger: override(db.aiLogger, {
          async logCall(call) {
            await slowly();
            await db.aiLogger.logCall(call);
          },
          async logBatchResults(batchId, rows) {
            await slowly();
            await db.aiLogger.logBatchResults(batchId, rows);
          },
        }),
        ai: (topic, logger, context, _resolver, options) =>
          createAIHelper(topic, logger, context, () => model, options),
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
    expect(observed).toEqual({
      flush: { failed: 0, pending: 0 },
      rows: work === "batch results" ? 2 : 1,
    });
  });
});
