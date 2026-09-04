/**
 * Shared harness for the `ctx.step.ai` tests: drives the REAL kernel with an
 * InMemoryStepLedger, an InMemoryAICallLogger and the mock AI factory, and
 * (for batch) swaps the mock's `batch()` for the real AIBatchImpl bound to a
 * fake EngineBatchModel backend.
 */

import { vi } from "vitest";
import type { z } from "zod";
import type { EngineBatchModel, EngineBatchRef } from "../../ai/batch/model.js";
import { AIBatchImpl } from "../../ai/batch-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import type { AIHelper } from "../../ai/types.js";
import type { defineStage } from "../../core/stage-factory.js";
import { StepInFlight } from "../../core/steps.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import type { AIHelperFactory, StepLedger } from "../../kernel/ports.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { getBestProviderForModel } from "../../utils/batch/model-mapping.js";
import {
  createMockAIHelperFactory,
  createTestKernel,
  type MockAIHelperFactory,
} from "../utils/index.js";

export const REALTIME_MODEL = "ai-map-realtime-model";
export const BATCH_MODEL = "ai-map-batch-model";

registerModels({
  [REALTIME_MODEL]: {
    id: "openai/gpt-4o-mini",
    name: "AI Map Realtime Model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
    supportsAsyncBatch: false,
  },
  [BATCH_MODEL]: {
    id: "openai/gpt-4o",
    name: "AI Map Batch Model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
    supportsAsyncBatch: true,
  },
});

export interface FakeBackendOptions {
  /**
   * Whether the transport can find a batch it already created from the
   * engine's external key. `true` (default) models OpenAI/Gemini, which
   * carry the key in `metadata`/`displayName`; `false` models Anthropic
   * Message Batches and OpenRouter, which carry nothing searchable.
   */
  adoptable?: boolean;
  /** How many status polls report "pending" before "completed". */
  pendingPolls?: number;
  /** Report the batch as failed with this error. */
  failWith?: string;
  /** Produce the text returned for a request id. */
  respond?: (id: string) => string;
  /** Request ids the provider reports as failed (with this error). */
  failIds?: ReadonlySet<string>;
  failError?: string;
}

/** Adapted from batch-resume.test.ts: echoes what was submitted, per partition. */
export function makeFakeBackend(opts: FakeBackendOptions = {}) {
  const byBatch = new Map<string, string[]>();
  /** Batch id per external key, i.e. what the provider would let us search. */
  const byExternalKey = new Map<string, string>();
  const adoptedKeys: string[] = [];
  let adoptable = opts.adoptable ?? true;
  let n = 0;
  let polls = 0;
  const respond = opts.respond ?? ((id) => JSON.stringify({ v: id }));

  const model: EngineBatchModel = {
    provider: "openrouter",
    modelId: "openai/gpt-4o",
    get recovery() {
      return adoptable ? ("metadata" as const) : ("none" as const);
    },
    start: vi.fn(
      async (
        requests: Array<{ id: string }>,
        startOpts?: { externalKey?: string },
      ) => {
        n += 1;
        const id = `batch-${n}`;
        byBatch.set(
          id,
          requests.map((r) => r.id),
        );
        // Stand-in for the provider-side field the real adapters stamp.
        if (startOpts?.externalKey)
          byExternalKey.set(startOpts.externalKey, id);
        return {
          version: 1 as const,
          type: "text" as const,
          id,
          provider: "openrouter",
          modelId: "openai/gpt-4o",
          status: "pending" as const,
        };
      },
    ),
    adopt: vi.fn(async (externalKey: string) => {
      if (!adoptable) return null;
      const id = byExternalKey.get(externalKey);
      if (!id) return null;
      adoptedKeys.push(externalKey);
      return {
        version: 1 as const,
        type: "text" as const,
        id,
        provider: "openrouter",
        modelId: "openai/gpt-4o",
        status: "pending" as const,
      };
    }),
    status: vi.fn(async (_ref: EngineBatchRef) => {
      polls += 1;
      if (opts.failWith) {
        return { status: "failed" as const, error: opts.failWith };
      }
      const ids = byBatch.get(_ref.id) ?? [];
      const failed = ids.filter((id) => opts.failIds?.has(id)).length;
      const done = polls > (opts.pendingPolls ?? 0);
      return {
        status: done ? ("completed" as const) : ("pending" as const),
        ...(opts.failIds
          ? {
              requestCounts: {
                total: ids.length,
                pending: done ? 0 : ids.length,
                completed: done ? ids.length - failed : 0,
                failed: done ? failed : 0,
              },
            }
          : {}),
      };
    }),
    results: vi.fn(async function* (ref: EngineBatchRef) {
      for (const id of byBatch.get(ref.id) ?? []) {
        if (opts.failIds?.has(id)) {
          yield {
            id,
            status: "failed" as const,
            error: opts.failError ?? "Request contains an invalid argument.",
          };
          continue;
        }
        yield {
          id,
          status: "succeeded" as const,
          text: respond(id),
          inputTokens: 1,
          outputTokens: 1,
        };
      }
    }),
  };
  return {
    model,
    byBatch,
    polls: () => polls,
    /** External keys the replay adopted instead of creating a second batch. */
    adopted: () => [...adoptedKeys],
    /** Batch ids by the external key their creation carried. */
    byExternalKey,
    setAdoptable: (value: boolean) => {
      adoptable = value;
    },
  };
}

/**
 * Wrap the mock factory so `batch()` returns the real AIBatchImpl bound to a
 * fake backend (the seam is AIBatchImpl's optional `backend` constructor
 * argument), while realtime calls still go to the mock.
 */
export function createBatchAwareFactory(
  mock: MockAIHelperFactory,
  backend: EngineBatchModel,
  batchLog?: (level: string, message: string) => void,
  onBatch?: (modelKey: string, provider: string) => void,
): AIHelperFactory {
  return (topic, logger, logContext, providerResolver, options) => {
    const helper = mock(topic, logger, logContext, providerResolver, options);
    return new Proxy(helper, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return (
            modelKey: string,
            provider?: string,
            batchOptions?: unknown,
          ) => {
            onBatch?.(
              modelKey,
              (provider ?? getBestProviderForModel(modelKey)) as string,
            );
            return new AIBatchImpl(
              { topic, aiCallLogger: logger },
              modelKey,
              (provider ?? getBestProviderForModel(modelKey)) as never,
              batchLog
                ? (((level: string, message: string) =>
                    batchLog(level, message)) as never)
                : undefined,
              batchOptions as never,
              backend,
            );
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AIHelper;
  };
}

/** Call a hook before every realtime model call (to inject one-off failures). */
export function withCallHook(
  factory: AIHelperFactory,
  hook: (call: { type: "text" | "object"; prompt: unknown }) => void,
): AIHelperFactory {
  return (...args) => {
    const helper = factory(...args);
    return new Proxy(helper, {
      get(target, prop, receiver) {
        if (prop === "generateText" || prop === "generateObject") {
          return (modelKey: string, prompt: unknown, ...rest: unknown[]) => {
            hook({ type: prop === "generateText" ? "text" : "object", prompt });
            return (target[prop] as (...a: unknown[]) => unknown)(
              modelKey,
              prompt,
              ...rest,
            );
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AIHelper;
  };
}

/**
 * Emulate a worker dying the moment it claims `stepId`: the claim throws
 * `StepInFlight` once (what a replay meets when the dead worker's row is
 * still leased), so the stage suspends and the next poll replays it with
 * every earlier step answered from the ledger.
 */
export function crashOnClaim(
  inner: StepLedger,
  stepId: string,
  now: () => Date,
): StepLedger {
  let crashed = false;
  return {
    claim: (record) => {
      if (record.stepId === stepId && !crashed) {
        crashed = true;
        throw new StepInFlight(stepId, now());
      }
      return inner.claim(record);
    },
    get: (stageRecordId, id) => inner.get(stageRecordId, id),
    update: (stageRecordId, id, patch) =>
      inner.update(stageRecordId, id, patch),
    compareAndSet: (stageRecordId, id, expected, patch) =>
      inner.compareAndSet(stageRecordId, id, expected, patch),
    list: (stageRecordId) => inner.list(stageRecordId),
    clear: (stageRecordId) => inner.clear(stageRecordId),
  };
}

export interface HarnessOptions {
  stage: ReturnType<typeof defineStage>;
  /** Wrap the harness ledger (e.g. `crashOnClaim`) before the kernel sees it. */
  wrapLedger?: (ledger: StepLedger, now: () => Date) => StepLedger;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  input: Record<string, unknown>;
  aiFactory?: AIHelperFactory;
  mock?: MockAIHelperFactory;
}

/** Build a one-stage workflow on the real kernel and expose tick helpers. */
export async function createAiMapHarness(opts: HarnessOptions) {
  const mock = opts.mock ?? createMockAIHelperFactory();
  const aiLogger = new InMemoryAICallLogger();
  const clock = new FakeClock();
  const inner = new InMemoryStepLedger({ now: () => clock.now() });
  const ledger = opts.wrapLedger
    ? opts.wrapLedger(inner, () => clock.now())
    : inner;
  const workflowId = `wf-${opts.stage.id}`;
  const workflow = new WorkflowBuilder(
    workflowId,
    workflowId,
    "test",
    opts.inputSchema,
    opts.outputSchema,
  )
    .pipe(opts.stage)
    .build();
  const harness = createTestKernel([workflow], {
    clock,
    stepLedger: ledger,
    services: { aiLogger, ai: opts.aiFactory ?? mock },
  });
  const created = await harness.kernel.dispatch({
    type: "run.create",
    idempotencyKey: `${workflowId}-run`,
    workflowId,
    input: opts.input,
  });
  await harness.kernel.dispatch({
    type: "run.claimPending",
    workerId: "test-worker",
  });
  const workflowRunId = created.workflowRunId;

  return {
    ...harness,
    mock,
    aiLogger,
    ledger: inner,
    workflowRunId,
    topic: `workflow.${workflowRunId}.stage.${opts.stage.id}`,
    execute: () =>
      harness.kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId,
        stageId: opts.stage.id,
        config: {},
      }),
    /** Advance the clock and poll suspended stages once. */
    tick: async (advanceMs = 1) => {
      clock.advance(advanceMs);
      await harness.kernel.dispatch({ type: "stage.pollSuspended" });
    },
    stage: () => harness.persistence.getStage(workflowRunId, opts.stage.id),
    /** Run ticks until the stage leaves SUSPENDED (bounded). */
    settle: async (advanceMs = 1, maxTicks = 20) => {
      for (let i = 0; i < maxTicks; i++) {
        const record = await harness.persistence.getStage(
          workflowRunId,
          opts.stage.id,
        );
        if (record?.status !== "SUSPENDED") return i;
        clock.advance(advanceMs);
        await harness.kernel.dispatch({ type: "stage.pollSuspended" });
      }
      return maxTicks;
    },
  };
}
