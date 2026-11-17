import { z } from "zod";
import type { EngineBatchModel, EngineBatchRef } from "../../ai/batch/model.js";
import { AIBatchImpl } from "../../ai/batch-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import type { AIBatchProvider, AIHelper } from "../../ai/types.js";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
import { Workflow, WorkflowBuilder } from "../../core/workflow.js";
import type { Kernel } from "../../kernel/kernel.js";
import type { AIHelperFactory } from "../../kernel/ports.js";
import type { FakeClock } from "../../kernel/testing/fake-clock.js";

const inputSchema = z.object({ value: z.string() }).passthrough();
const valueOutput = z.object({ value: z.string() }).passthrough();
const BATCH_MODEL = "stored-rows-fake-batch-model";

registerModels({
  [BATCH_MODEL]: {
    id: "openai/gpt-4o",
    name: "Stored Rows Fake Batch Model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
    supportsAsyncBatch: true,
    batchProvider: "openrouter",
  },
});

export interface ScenarioRuntime {
  readonly id: string;
  readonly workflow: Workflow<any, any>;
  readonly inFlightPoint: string;
  readonly expectedFinalOutcome: { status: "COMPLETED"; output: unknown };
  readonly completedStepBodies: string[];
  readonly stepBodyExecutions: Record<string, number>;
  readonly fakeBatch: {
    complete: boolean;
    startCount: number;
    pollCount: number;
  };
  release(): void;
  beforeReplay?(
    kernel: Kernel,
    workflowRunId: string,
    clock: FakeClock,
  ): Promise<void>;
  prepareCapture?(
    client: Record<string, any>,
    workflowRunId: string,
  ): Promise<void>;
}

function singleWorkflow(id: string, stage: ReturnType<typeof defineStage>) {
  return new WorkflowBuilder(
    `stored-rows-${id}`,
    `Stored rows ${id}`,
    "stored row compatibility",
    inputSchema,
    z.any(),
  )
    .pipe(stage)
    .build();
}

function parallelWorkflow(
  id: string,
  stages: [ReturnType<typeof defineStage>, ReturnType<typeof defineStage>],
) {
  return new WorkflowBuilder(
    `stored-rows-${id}`,
    `Stored rows ${id}`,
    "stored row compatibility",
    inputSchema,
    z.any(),
  )
    .parallel(stages)
    .build();
}

function basicStage(id: string, output: Record<string, unknown>) {
  return defineStage({
    id,
    name: id,
    schemas: { input: inputSchema, output: z.any(), config: z.object({}) },
    async execute() {
      return { output };
    },
  });
}

function fakeBatch(state: {
  complete: boolean;
  startCount: number;
  pollCount: number;
}): EngineBatchModel {
  const ref: EngineBatchRef = {
    version: 1,
    type: "text",
    id: "stored-rows-batch-1",
    provider: "openrouter",
    modelId: "openai/gpt-4o",
  };
  return {
    provider: "openrouter",
    modelId: "openai/gpt-4o",
    recovery: "metadata",
    async start() {
      state.startCount++;
      return {
        ...ref,
        status: "pending",
      };
    },
    async adopt() {
      return { ...ref, status: "pending" };
    },
    async status() {
      state.pollCount++;
      return { status: state.complete ? "completed" : "pending" };
    },
    async *results() {
      // The single item has its deterministic default item id (`0`). This
      // lets a fresh fake transport answer the persisted batch ref on replay.
      yield {
        id: "0",
        status: "succeeded",
        text: JSON.stringify({ answer: "batch-result" }),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

function batchAI(state: {
  complete: boolean;
  startCount: number;
  pollCount: number;
}): AIHelperFactory {
  const backend = fakeBatch(state);
  return ((topic, aiCallLogger) => {
    const helper = {
      topic,
      batch(modelKey: string, provider?: AIBatchProvider, options?: unknown) {
        return new AIBatchImpl(
          { topic, aiCallLogger },
          modelKey as never,
          (provider ?? "openrouter") as AIBatchProvider,
          undefined,
          options as never,
          backend,
        );
      },
    };
    return helper as unknown as AIHelper;
  }) as AIHelperFactory;
}

export function createScenario(id: string): ScenarioRuntime {
  const stepBodyExecutions: Record<string, number> = {};
  const fakeBatchState = { complete: false, startCount: 0, pollCount: 0 };
  let ready = false;
  let shouldFail = true;
  let workflow: ScenarioRuntime["workflow"];
  let inFlightPoint = "";
  let expectedOutput: unknown;
  let completedStepBodies: string[] = [];
  let beforeReplay: ScenarioRuntime["beforeReplay"];
  let prepareCapture: ScenarioRuntime["prepareCapture"];

  switch (id) {
    case "pending-unclaimed": {
      workflow = singleWorkflow(id, basicStage("finish", { value: "pending" }));
      inFlightPoint =
        "run.create has persisted a PENDING run; no host has claimed it";
      expectedOutput = { value: "pending" };
      break;
    }
    case "running-queued": {
      workflow = singleWorkflow(id, basicStage("finish", { value: "queued" }));
      inFlightPoint =
        "run.claimPending has made the run RUNNING and left its first job queued";
      expectedOutput = { value: "queued" };
      break;
    }
    case "wait-for": {
      const stage = defineStage({
        id: "wait",
        name: "wait",
        schemas: {
          input: inputSchema,
          output: valueOutput,
          config: z.object({}),
        },
        async execute(ctx) {
          await ctx.step.waitFor("release", {
            poll: async () => ready,
            ready: (value) => value === true,
            every: "1s",
            timeout: "1h",
          });
          return { output: { value: "released" } };
        },
      });
      workflow = singleWorkflow(id, stage);
      inFlightPoint =
        "stage is SUSPENDED in ctx.step.waitFor with its poll step pending";
      expectedOutput = { value: "released" };
      break;
    }
    case "sleep": {
      const stage = defineStage({
        id: "sleep",
        name: "sleep",
        schemas: {
          input: inputSchema,
          output: valueOutput,
          config: z.object({}),
        },
        async execute(ctx) {
          await ctx.step.sleep("short-delay", "1s");
          return { output: { value: "slept" } };
        },
      });
      workflow = singleWorkflow(id, stage);
      inFlightPoint = "stage is SUSPENDED on ctx.step.sleep";
      expectedOutput = { value: "slept" };
      break;
    }
    case "wait-for-signal": {
      const stage = defineStage({
        id: "signal",
        name: "signal",
        schemas: {
          input: inputSchema,
          output: valueOutput,
          config: z.object({}),
        },
        async execute(ctx) {
          const signal = await ctx.step.waitForSignal<{ value: string }>(
            "approval",
            {
              timeout: "1h",
            },
          );
          return { output: signal };
        },
      });
      workflow = singleWorkflow(id, stage);
      inFlightPoint =
        "stage is SUSPENDED on ctx.step.waitForSignal before approval is delivered";
      expectedOutput = { value: "approved" };
      beforeReplay = async (kernel, workflowRunId, clock) => {
        await kernel.dispatch({
          type: "step.signal",
          workflowRunId,
          stageId: "signal",
          stepId: "approval",
          payload: { value: "approved" },
        });
        clock.advance(60_000);
      };
      break;
    }
    case "completed-step-checkpoint": {
      const stage = defineStage({
        id: "checkpoint",
        name: "checkpoint",
        schemas: {
          input: inputSchema,
          output: valueOutput,
          config: z.object({}),
        },
        async execute(ctx) {
          const result = await ctx.step.run("large-result", async () => {
            stepBodyExecutions["checkpoint:large-result"] =
              (stepBodyExecutions["checkpoint:large-result"] ?? 0) + 1;
            return { marker: "persisted", payload: "x".repeat(100_000) };
          });
          await ctx.step.waitFor("release", {
            poll: async () => ready,
            ready: (value) => value === true,
            every: "1s",
            timeout: "1h",
          });
          return { output: { value: result.marker } };
        },
      });
      workflow = singleWorkflow(id, stage);
      inFlightPoint =
        "a completed ctx.step.run result larger than the spill threshold is stored in WorkflowBlob, then the stage suspends";
      expectedOutput = { value: "persisted" };
      completedStepBodies = ["checkpoint:large-result"];
      break;
    }
    case "legacy-async-batch": {
      const stage = defineAsyncBatchStage({
        id: "legacy-batch",
        name: "legacy-batch",
        mode: "async-batch",
        schemas: {
          input: inputSchema,
          output: valueOutput,
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: { batchId: "legacy-batch-1" },
            pollConfig: {
              pollInterval: 1_000,
              maxWaitTime: 3_600_000,
              nextPollAt: new Date(now.getTime() + 1_000),
            },
          };
        },
        async checkCompletion() {
          return ready
            ? { ready: true, output: { value: "batch-complete" } }
            : { ready: false };
        },
      });
      workflow = singleWorkflow(id, stage);
      inFlightPoint =
        "legacy defineAsyncBatchStage is SUSPENDED before checkCompletion reports ready";
      expectedOutput = { value: "batch-complete" };
      break;
    }
    case "ai-map-poll": {
      const stage = defineStage({
        id: "ai-map",
        name: "ai-map",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string(), count: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const results = await ctx.step.ai.map("items", [ctx.input.value], {
            model: BATCH_MODEL,
            policy: "batch",
            schema: z.object({ answer: z.string() }),
            prompt: (item) => `Return an answer for ${item}`,
            batch: { pollEvery: "1s", timeout: "1h" },
          });
          const first = results[0];
          return {
            output: {
              value:
                first?.status === "succeeded" ? first.result.answer : "missing",
              count: results.length,
            },
          };
        },
      });
      workflow = singleWorkflow(id, stage);
      inFlightPoint =
        "ctx.step.ai.map submitted through a fake EngineBatchModel and is SUSPENDED on its :poll step";
      expectedOutput = { value: "batch-result", count: 1 };
      break;
    }
    case "failed-redrive": {
      const stage = defineStage({
        id: "recover",
        name: "recover",
        schemas: {
          input: inputSchema,
          output: valueOutput,
          config: z.object({}),
        },
        async execute() {
          if (shouldFail) throw new Error("stored rows fixture failure");
          return { output: { value: "recovered" } };
        },
      });
      workflow = singleWorkflow(id, stage);
      inFlightPoint =
        "run and stage are FAILED with an exhausted queued-job attempt; replay starts with run.redrive";
      expectedOutput = { value: "recovered" };
      prepareCapture = async (client, workflowRunId) => {
        await client.jobQueue.updateMany({
          where: { workflowRunId },
          data: { maxAttempts: 1 },
        });
      };
      beforeReplay = async (kernel, workflowRunId) => {
        shouldFail = false;
        await kernel.dispatch({
          type: "run.redrive",
          workflowRunId,
          from: { kind: "lastFailure" },
          idempotencyKey: "stored-rows-redrive",
        });
      };
      break;
    }
    case "parallel-partial": {
      const fast = basicStage("fast", { value: "fast" });
      const waiting = defineStage({
        id: "waiting",
        name: "waiting",
        schemas: {
          input: inputSchema,
          output: valueOutput,
          config: z.object({}),
        },
        async execute(ctx) {
          await ctx.step.waitFor("release", {
            poll: async () => ready,
            ready: (value) => value === true,
            every: "1s",
            timeout: "1h",
          });
          return { output: { value: "resumed" } };
        },
      });
      workflow = parallelWorkflow(id, [fast, waiting]);
      inFlightPoint =
        "parallel execution group has fast COMPLETED and waiting SUSPENDED";
      expectedOutput = {
        fast: { value: "fast" },
        waiting: { value: "resumed" },
      };
      break;
    }
    case "unpublished-outbox": {
      workflow = singleWorkflow(id, basicStage("finish", { value: "outbox" }));
      inFlightPoint =
        "one outbox event has publishedAt set and a later event remains unpublished";
      expectedOutput = { value: "outbox" };
      break;
    }
    default:
      throw new Error(`Unknown stored-row scenario: ${id}`);
  }

  return {
    id,
    workflow,
    inFlightPoint,
    expectedFinalOutcome: { status: "COMPLETED", output: expectedOutput },
    completedStepBodies,
    stepBodyExecutions,
    fakeBatch: fakeBatchState,
    release() {
      ready = true;
      fakeBatchState.complete = true;
    },
    beforeReplay,
    prepareCapture,
  };
}

export const STORED_ROW_SCENARIOS = [
  "pending-unclaimed",
  "running-queued",
  "wait-for",
  "sleep",
  "wait-for-signal",
  "completed-step-checkpoint",
  "legacy-async-batch",
  "ai-map-poll",
  "failed-redrive",
  "parallel-partial",
  "unpublished-outbox",
] as const;

export function aiFactoryForScenario(
  runtime: ScenarioRuntime,
): AIHelperFactory {
  if (runtime.id !== "ai-map-poll") {
    return ((topic) => ({ topic }) as AIHelper) as AIHelperFactory;
  }
  return batchAI(runtime.fakeBatch);
}
