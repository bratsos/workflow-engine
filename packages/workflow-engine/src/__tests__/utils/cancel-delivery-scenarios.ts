/**
 * A run.cancel sweep and the job deliveries of the same stage: duplicates,
 * superseded and exhausted deliveries, a job of a generation that is gone,
 * and a body that lost its step. Every delivery goes through `kernel.dispatch`
 * or the host loop (`executeJobWithHeartbeat`) on a real job transport. The
 * same scenarios run on the in-memory ports
 * (`kernel/cancel-delivery-boundaries.test.ts`) and, through
 * `sqlite8-kernel-concurrency.test.ts`, on SQLite and Postgres.
 */
import { expect, it } from "vitest";
import { z } from "zod";
import type { EngineBatchRef } from "../../ai/batch/model.js";
import { defineStage } from "../../core/stage-factory.js";
import { NonRetryableError, StageAbortedError } from "../../core/steps.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  executeJobWithHeartbeat,
  type HostJobMessage,
} from "../../kernel/helpers/host-support.js";
import type { Kernel, KernelConfig } from "../../kernel/kernel.js";
import type {
  BlobStore,
  JobTransport,
  StepLedger,
} from "../../kernel/ports.js";
import { createPayloadSpill, withStepResultSpill } from "../../kernel/spill.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import type { WorkflowPersistence } from "../../persistence/interface.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";
import {
  BATCH_MODEL,
  createBatchAwareFactory,
  makeFakeBackend,
} from "../durable/ai-map-harness.js";
import { createMockAIHelperFactory } from "./index.js";

export interface CancelDeliveryPorts {
  persistence: WorkflowPersistence;
  jobTransport: JobTransport;
  ledger: StepLedger;
  blobStore: BlobStore;
  /** Two transactions can be open at once (not SQLite, which has one writer). */
  concurrentTransactions: boolean;
  /** A kernel on these ports; `config` overrides clock, registry, services and ledger. */
  makeKernel(config: Partial<KernelConfig>): Kernel;
}

type Ports = (clock: FakeClock) => Promise<CancelDeliveryPorts>;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const schema = z.object({ count: z.number() });

/**
 * A claimed run whose one stage maps two items through one provider batch
 * (`extract`); with `twoMaps`, a second map (`extract2`) follows once the
 * first batch has finished.
 */
async function mapRun(ports: Ports, { twoMaps = false, spill = false } = {}) {
  const clock = new FakeClock(new Date());
  const base = await ports(clock);
  const backend = makeFakeBackend({ pendingPolls: 1000 });
  const model = backend.model;
  const created: string[] = [];
  const cancelled = new Set<string>();
  const finished = new Set<string>();

  let beforeStart: undefined | (() => Promise<void>);
  const start = model.start.bind(model);
  model.start = async (...args) => {
    const hook = beforeStart;
    await hook?.();
    const ref = await start(...args);
    created.push(ref.id);
    return ref;
  };
  let onCancel: "ok" | "throw" | (() => Promise<void>) = "ok";
  model.cancel = async (ref: EngineBatchRef) => {
    if (onCancel === "throw") throw new Error("HTTP 503");
    if (typeof onCancel === "function") await onCancel();
    cancelled.add(ref.id);
    return { outcome: "cancelled" as const, rawStatus: "in_progress" };
  };
  const status = model.status.bind(model);
  model.status = async (ref, o) =>
    cancelled.has(ref.id)
      ? { status: "failed" as const, rawStatus: "cancelled", cancelled: true }
      : finished.has(ref.id)
        ? { status: "completed" as const }
        : status(ref, o);
  const adopt = model.adopt!.bind(model);
  model.adopt = async (key, o) => {
    const id = backend.byExternalKey.get(key);
    if (id && (cancelled.has(id) || o?.excludeBatchIds?.includes(id))) {
      return null;
    }
    return adopt(key, o);
  };

  // The ledger the kernel uses: a hook can run before a submit row's failure
  // write, and a process can die before its releasing writes.
  // Runs before the next failure write of a submit row is sent.
  let beforeFailureWrite: undefined | (() => Promise<void>);
  let dying = false;
  // The process stops at a write of a submit row: the write never answers,
  // having applied ("after") or not ("before").
  let onSubmitWrite: undefined | (() => "before" | "after" | undefined);
  let stopped = gate();
  // The write applies and its answer is lost.
  let loseAnswer: undefined | ((patch: { result?: unknown }) => boolean);
  const ledger = new Proxy(base.ledger, {
    get(target, key) {
      if (key === "compareAndSet") {
        return (
          ...args: Parameters<StepLedger["compareAndSet"]>
        ): ReturnType<StepLedger["compareAndSet"]> => {
          const [, stepId, expected, patch] = args;
          const hook =
            stepId.endsWith(":submit") && patch.status === "failed"
              ? beforeFailureWrite
              : undefined;
          if (hook) {
            beforeFailureWrite = undefined;
            return hook().then(() => target.compareAndSet(...args));
          }
          const stop = stepId.endsWith(":submit")
            ? onSubmitWrite?.()
            : undefined;
          if (stop) {
            onSubmitWrite = undefined;
            const write =
              stop === "after" ? target.compareAndSet(...args) : undefined;
            void Promise.resolve(write).then(() => stopped.release());
            return new Promise(() => {});
          }
          const lose = loseAnswer;
          if (lose?.(patch)) {
            loseAnswer = undefined;
            return target.compareAndSet(...args).then(() => {
              throw new Error("the connection dropped before the answer");
            });
          }
          return dying &&
            expected.status === "running" &&
            patch.leaseExpiresAt === null &&
            Object.hasOwn(patch, "result")
            ? Promise.reject(new Error("the process died"))
            : target.compareAndSet(...args);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StepLedger;

  let executions = 0;
  let beforeMap: undefined | (() => Promise<void>);
  const stage = defineStage({
    id: "map",
    name: "map",
    schemas: {
      input: schema,
      output: z.object({ done: z.number() }),
      config: z.object({}),
    },
    async execute(ctx) {
      executions++;
      await beforeMap?.();
      const spec = {
        model: BATCH_MODEL,
        schema: z.object({ v: z.string() }),
        policy: "batch" as const,
        prompt: (item: number) => `Extract <<${item}>>`,
        batch: { pollEvery: "60s", timeout: "24h" },
      };
      const results = await ctx.step.ai.map("extract", [0, 1], spec);
      if (twoMaps) await ctx.step.ai.map("extract2", [2, 3], spec);
      return { output: { done: results.length } };
    },
  });
  const workflow = new WorkflowBuilder(
    `cancel-delivery-${crypto.randomUUID()}`,
    "cancel delivery",
    "test",
    schema,
    z.object({ done: z.number() }),
  )
    .pipe(stage)
    .build();
  const warnings: Array<{ message: string; metadata: unknown }> = [];
  // A command held up right after its transaction read the run.
  let afterRunRead: undefined | (() => Promise<void>);
  const persistence = new Proxy(base.persistence, {
    get(target, key) {
      // Wrapped only while armed: a wrapped transaction loses the adapter's
      // per-transaction read binding, which SQLite's one writer needs.
      if (key === "withTransaction" && afterRunRead) {
        return <T>(
          fn: Parameters<WorkflowPersistence["withTransaction"]>[0],
        ): Promise<T> =>
          target.withTransaction((tx) =>
            fn(
              new Proxy(tx, {
                get(o, k) {
                  const value = Reflect.get(o, k);
                  if (k === "getRun" && afterRunRead) {
                    const hook = afterRunRead;
                    afterRunRead = undefined;
                    return async (id: string) => {
                      const run = await value.call(o, id);
                      await hook();
                      return run;
                    };
                  }
                  return typeof value === "function" ? value.bind(o) : value;
                },
              }),
            ),
          ) as Promise<T>;
      }
      if (key === "createLog") {
        return (input: Parameters<WorkflowPersistence["createLog"]>[0]) => {
          if (input.level === "WARN") {
            warnings.push({ message: input.message, metadata: input.metadata });
          }
          return target.createLog(input);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let beforeResolve: undefined | (() => Promise<void>);
  const mock = createMockAIHelperFactory();
  const kernel = base.makeKernel({
    persistence,
    clock,
    stepLedger: ledger,
    ...(spill ? { spillThresholdBytes: 1 } : {}),
    registry: {
      getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
      listWorkflows: () => [workflow],
    },
    services: {
      aiLogger: new InMemoryAICallLogger(),
      ai: createBatchAwareFactory(mock, model),
      batchModels: async () => {
        await beforeResolve?.();
        return model;
      },
    },
  });
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: crypto.randomUUID(),
    workflowId: workflow.id,
    input: { count: 2 },
  });
  await kernel.dispatch({ type: "run.claimPending", workerId: "worker" });

  const stageRow = async () =>
    (await base.persistence.getStage(workflowRunId, "map"))!;
  // Rows as the kernel reads them: a spilled result resolved.
  const reader = withStepResultSpill(
    base.ledger,
    createPayloadSpill({ blobStore: base.blobStore }),
  );
  const submitRow = async (stepId = "extract:submit") =>
    (await reader.get((await stageRow()).id, stepId))!;
  return {
    ...base,
    clock,
    kernel,
    workflowRunId,
    created,
    cancelled,
    executions: () => executions,
    stage: stageRow,
    submitRow,
    run: async () => (await base.persistence.getRun(workflowRunId))!,
    next: async () => (await base.jobTransport.dequeue())! as HostJobMessage,
    /** The worker holding the lease went silent: the job is handed out again. */
    reap: async () => {
      await base.jobTransport.releaseStaleJobs(-60_000);
      return (await base.jobTransport.dequeue())! as HostJobMessage;
    },
    /** The host loop runs the job: dispatch, then acknowledge. */
    host: (job: HostJobMessage) =>
      executeJobWithHeartbeat(kernel, {
        jobTransport: base.jobTransport,
        job,
        jobHeartbeatIntervalMs: 3_600_000,
      }),
    /** A delivery of `job` as a host makes it, with no idempotency record. */
    deliver: (job: HostJobMessage, abortSignal?: AbortSignal) =>
      kernel.dispatch({
        ...(abortSignal ? { abortSignal } : {}),
        type: "job.execute",
        workflowRunId,
        workflowId: workflow.id,
        stageId: "map",
        config: {},
        jobId: job.jobId,
        attempt: job.attempt,
        ...(job.maxAttempts !== undefined
          ? { maxAttempts: job.maxAttempts }
          : {}),
        generation: (job.payload as { generation?: number }).generation,
      }),
    cancel: () => kernel.dispatch({ type: "run.cancel", workflowRunId }),
    redrive: () => kernel.dispatch({ type: "run.redrive", workflowRunId }),
    transition: () =>
      kernel.dispatch({ type: "run.transition", workflowRunId }),
    poll: (advanceMs: number) => {
      clock.advance(advanceMs);
      return kernel.dispatch({ type: "stage.pollSuspended" });
    },
    setBeforeStart: (hook: typeof beforeStart) => {
      beforeStart = hook;
    },
    setBeforeMap: (hook: typeof beforeMap) => {
      beforeMap = hook;
    },
    setCancel: (mode: typeof onCancel) => {
      onCancel = mode;
    },
    beforeNextSubmitFailureWrite: (hook: () => Promise<void>) => {
      beforeFailureWrite = hook;
    },
    die: (on: boolean) => {
      dying = on;
    },
    /**
     * The process stops at the `n`th write to a submit row from now on (1 is
     * the first), before or after the write applies. Resolves once it has.
     */
    stopAtSubmitWrite: (n: number, when: "before" | "after") => {
      let seen = 0;
      stopped = gate();
      onSubmitWrite = () => (++seen === n ? when : undefined);
      return stopped.promise;
    },
    /** The next submit-row write that `when` matches applies, and its answer is lost. */
    loseAnswerTo: (when: (patch: { result?: unknown }) => boolean) => {
      loseAnswer = when;
    },
    setBeforeResolve: (hook: typeof beforeResolve) => {
      beforeResolve = hook;
    },
    /** The next transaction that reads the run waits for `hook` after the read. */
    afterNextRunRead: (hook: () => Promise<void>) => {
      afterRunRead = hook;
    },
    /** The provider finished `id` on its own. */
    finish: (id: string) => {
      finished.add(id);
    },
    warnings,
    /**
     * Batches the provider still runs that the submit row does not list as
     * its own: nothing would ever read or cancel them.
     */
    lost: async () => {
      const result = ((await submitRow()).result ?? {}) as {
        refs?: Array<{ id: string }>;
        cancelledBatchIds?: string[];
      };
      const listed = new Set(
        (result.refs ?? [])
          .map((ref) => ref.id)
          .filter((id) => !result.cancelledBatchIds?.includes(id)),
      );
      return created.filter((id) => !cancelled.has(id) && !listed.has(id));
    },
  };
}

export function cancelDeliveryScenarios(ports: Ports) {
  it("a sweep holding the submit row: the stage's job delivered again and re-delivered after a reap never use the held handle", async () => {
    const env = await mapRun(ports);
    const first = await env.next();
    expect((await env.host(first)).outcome).toBe("suspended");

    // The sweep holds the row while its provider call is out.
    const inCancel = gate();
    const answer = gate();
    env.setCancel(async () => {
      inCancel.release();
      await answer.promise;
    });
    const sweep = env.cancel();
    await inCancel.promise;
    const held = await env.submitRow();
    expect(held.result).toHaveProperty("cancelFence");

    // The cancelled run's job delivered again: nothing runs.
    expect(await env.deliver(first)).toMatchObject({
      ghost: true,
      ghostReason: "orphan",
    });

    // Redriven while the row is held; the new job's body waits.
    await env.redrive();
    const inBody = gate();
    const go = gate();
    env.setBeforeMap(async () => {
      env.setBeforeMap(undefined);
      inBody.release();
      await go.promise;
    });
    const second = await env.next();
    const running = env.host(second);
    await inBody.promise;

    // Its lease is reaped and the job delivered again: that execution meets
    // the held row too and waits, creating nothing.
    const latest = await env.reap();
    expect(await env.host(latest)).toMatchObject({ outcome: "suspended" });
    expect(env.executions()).toBe(3);
    expect(env.created).toEqual(["batch-1"]);

    // The overtaken body goes on, meets the held row, and its result is
    // discarded by the stage's version fence.
    go.release();
    expect(await running).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("taken over"),
    });
    answer.release();
    expect((await sweep).batches).toEqual([
      expect.objectContaining({ status: "cancelled" }),
    ]);
    expect(env.created).toEqual(["batch-1"]);
    expect(await env.lost()).toEqual([]);
    expect((await env.submitRow()).result).not.toHaveProperty("cancelFence");

    // The suspended stage replaces the cancelled batch.
    await env.poll(10 * 60_000);
    expect(env.created).toEqual(["batch-1", "batch-2"]);
    expect((await env.submitRow()).result).toMatchObject({
      refs: [expect.objectContaining({ id: "batch-2" })],
      cancelledBatchIds: ["batch-1"],
      generation: 1,
    });
    expect(await env.lost()).toEqual([]);
  });

  it("run.cancel then run.redrive: a job of the old generation delivered late replaces the batch once, and the new job reuses the replacement", async () => {
    const env = await mapRun(ports);
    const first = await env.next();
    await env.host(first);
    await env.cancel();
    await env.redrive();
    const tombstoned = await env.submitRow();

    // The redrive re-opened the stage record in place, so the old job runs on
    // it: it meets the tombstone and replaces the batch, never adopting it.
    expect((await env.deliver(first)).outcome).toBe("suspended");
    expect(env.created).toEqual(["batch-1", "batch-2"]);

    // The new job finds the replacement and creates nothing more.
    const second = await env.next();
    expect(second.jobId).not.toBe(first.jobId);
    expect((await env.host(second)).outcome).toBe("suspended");
    expect(env.created).toEqual(["batch-1", "batch-2"]);
    expect(tombstoned.result).toHaveProperty("engineCancelled");
    expect((await env.submitRow()).result).toMatchObject({
      refs: [expect.objectContaining({ id: "batch-2" })],
      cancelledBatchIds: ["batch-1"],
      generation: 1,
    });
    expect(await env.lost()).toEqual([]);
  });

  it("after an error answer to a sent cancel, the retried job completes the cancel before it replaces the batch, and its stale delivery creates nothing", async () => {
    const env = await mapRun(ports);
    await env.host(await env.next());
    env.setCancel("throw");
    expect((await env.cancel()).batches[0]?.status).toBe("failed");
    expect((await env.submitRow()).result).toMatchObject({
      cancelIntent: { batchIds: ["batch-1"] },
    });
    await env.redrive();

    // The redriven step cannot complete the cancel: a retryable failure.
    const second = await env.next();
    expect(await env.deliver(second)).toMatchObject({
      outcome: "failed",
      willRetry: true,
    });
    expect(env.created).toEqual(["batch-1"]);
    expect((await env.submitRow()).result).toMatchObject({
      cancelIntent: { batchIds: ["batch-1"] },
    });

    env.setCancel("ok");
    const retry = await env.reap();
    // A stale delivery of attempt 1 replays the step's recorded failure:
    // it creates nothing and re-opens nothing.
    expect(await env.deliver(second)).toMatchObject({
      outcome: "failed",
      willRetry: true,
    });
    expect(env.created).toEqual(["batch-1"]);
    // The retry re-opens the step, completes the cancel, then replaces.
    expect((await env.host(retry)).outcome).toBe("suspended");

    expect(env.created).toEqual(["batch-1", "batch-2"]);
    const row = await env.submitRow();
    expect(row.result).toMatchObject({
      refs: [expect.objectContaining({ id: "batch-2" })],
      cancelledBatchIds: ["batch-1"],
    });
    expect(row.result).not.toHaveProperty("cancelIntent");
    expect(await env.lost()).toEqual([]);
  });

  it("a submit body that returns into a stage another delivery already failed keeps its batch reachable for run.redrive", async () => {
    const env = await mapRun(ports);
    const inStart = gate();
    const go = gate();
    env.setBeforeStart(async () => {
      env.setBeforeStart(undefined);
      inStart.release();
      await go.promise;
    });
    const first = await env.next();
    const running = env.host(first);
    await inStart.promise;

    // The job is re-delivered after a reap, and that execution fails the
    // stage for good before it reaches the map.
    const latest = await env.reap();
    env.setBeforeMap(async () => {
      env.setBeforeMap(undefined);
      throw new NonRetryableError("input rejected");
    });
    expect(await env.host(latest)).toMatchObject({ outcome: "failed" });
    const failed = await env.stage();
    expect(failed.status).toBe("FAILED");

    go.release();
    // The body in flight records its batch on the step, and the run's
    // status re-check discards its suspension.
    expect(await running).toMatchObject({ outcome: "failed" });
    expect(await env.stage()).toMatchObject({
      status: "FAILED",
      attempt: failed.attempt,
      errorMessage: failed.errorMessage,
    });
    expect(env.created).toEqual(["batch-1"]);
    expect(await env.lost()).toEqual([]);

    // A FAILED run keeps its batch, and run.redrive continues on it.
    await env.transition();
    expect((await env.run()).status).toBe("FAILED");
    await env.redrive();
    expect((await env.host(await env.next())).outcome).toBe("suspended");
    expect(env.created).toEqual(["batch-1"]);
    expect((await env.submitRow()).result).toMatchObject({
      refs: [expect.objectContaining({ id: "batch-1" })],
    });
  });

  it("a sweep that died holding the row is completed by the redriven stage once its hold expires, whatever the old jobs do", async () => {
    const env = await mapRun(ports);
    const first = await env.next();
    await env.host(first);
    env.die(true);
    await env.cancel();
    env.die(false);
    const held = await env.submitRow();
    expect(held.result).toMatchObject({
      cancelFence: expect.anything(),
      cancelIntent: { batchIds: ["batch-1"] },
    });
    expect(held.leaseExpiresAt).not.toBeNull();

    await env.redrive();
    // The old job runs on the re-opened record: the hold is live, so the
    // step waits instead of using the handle.
    expect((await env.deliver(first)).outcome).toBe("suspended");
    const second = await env.next();
    expect((await env.host(second)).outcome).toBe("suspended");
    expect(env.created).toEqual(["batch-1"]);
    // So does a stale delivery of the new job.
    expect((await env.deliver(second)).outcome).toBe("suspended");
    expect(env.created).toEqual(["batch-1"]);

    await env.poll(10 * 60_000);
    expect(env.created).toEqual(["batch-1", "batch-2"]);
    const row = await env.submitRow();
    expect(row.result).toMatchObject({
      refs: [expect.objectContaining({ id: "batch-2" })],
      cancelledBatchIds: ["batch-1"],
    });
    expect(row.result).not.toHaveProperty("cancelFence");
    expect(row.result).not.toHaveProperty("cancelIntent");
    expect(await env.lost()).toEqual([]);
  });

  it("the failure write of a body that outlived its lease cannot drop a sweep's release that landed just before it", async () => {
    const env = await mapRun(ports);
    await env.host(await env.next());
    await env.cancel();
    await env.redrive();

    const inStart = gate();
    const go = gate();
    env.setBeforeStart(async () => {
      env.setBeforeStart(undefined);
      inStart.release();
      await go.promise;
      throw new Error("socket reset after the lease ended");
    });
    const replacement = env.host(await env.next());
    await inStart.promise;
    await env.cancel();
    env.clock.advance(10 * 60_000);

    let swept: Awaited<ReturnType<typeof env.cancel>> | undefined;
    env.beforeNextSubmitFailureWrite(async () => {
      swept = await env.cancel();
    });
    go.release();
    await replacement;

    expect(swept).toBeDefined();
    const row = await env.submitRow();
    expect(row).toMatchObject({ status: "running", leaseExpiresAt: null });
    expect(row.result).toHaveProperty("engineCancelled");
    expect(row.result).not.toHaveProperty("cancelFence");
    expect(await env.lost()).toEqual([]);
  });

  // A sweep's writes to the submit row: 1 the hold, 2 the cancel intent (then
  // the provider call), 3 the release. The process stops at each, before or
  // after it applies.
  const STOPS = [1, 2, 3].flatMap((n) =>
    (["before", "after"] as const).map((when) => ({ n, when })),
  );
  /** The row the stopped sweep left is still its hold. */
  const holds = ({ n, when }: (typeof STOPS)[number]) =>
    !(n === 1 && when === "before") && !(n === 3 && when === "after");
  /** A cancel may have left for batch-1 (an intent is recorded). */
  const sent = ({ n, when }: (typeof STOPS)[number]) =>
    n === 3 || (n === 2 && when === "after");

  async function stoppedSweep(ports: Ports, stop: (typeof STOPS)[number]) {
    const env = await mapRun(ports);
    expect((await env.host(await env.next())).outcome).toBe("suspended");
    const stopped = env.stopAtSubmitWrite(stop.n, stop.when);
    void env.cancel();
    await stopped;
    expect((await env.run()).status).toBe("CANCELLED");
    const row = await env.submitRow();
    if (holds(stop)) {
      expect(row.result).toHaveProperty("cancelFence");
      expect(row.leaseExpiresAt).not.toBeNull();
    } else {
      expect(row.result).not.toHaveProperty("cancelFence");
    }
    return { env, row };
  }

  it("a sweep stopped at any of its writes: a repeated run.cancel reports the hold and when it ends, in the result and the WARN alike, and after then takes the step over and cancels the batch", async () => {
    for (const stop of STOPS) {
      const { env, row } = await stoppedSweep(ports, stop);
      const at = `stopped ${stop.when} write ${stop.n}`;

      const again = await env.cancel();
      if (holds(stop)) {
        const heldUntil = row.leaseExpiresAt!.toISOString();
        expect(again, at).toEqual({
          cancelled: false,
          batches: [
            expect.objectContaining({
              stageId: "map",
              stepId: "extract:submit",
              ref: expect.objectContaining({ id: "batch-1" }),
              status: "held",
              heldUntil,
              error: expect.stringContaining(`held until ${heldUntil}`),
            }),
          ],
        });
        const warning = env.warnings.find((w) =>
          w.message.includes(`repeat run.cancel after ${heldUntil}`),
        );
        expect(warning?.message, at).toContain('provider batch "batch-1"');
        expect(warning?.metadata, at).toEqual(again.batches[0]);
        expect(await env.submitRow(), at).toEqual(row);

        env.clock.advance(
          row.leaseExpiresAt!.getTime() - env.clock.now().getTime() + 1,
        );
      }
      const after = holds(stop) ? await env.cancel() : again;
      expect(after.batches, at).toEqual([
        expect.objectContaining({
          ref: expect.objectContaining({ id: "batch-1" }),
          status: "cancelled",
        }),
      ]);
      expect(env.cancelled.has("batch-1"), at).toBe(true);
      const released = await env.submitRow();
      expect(released.leaseExpiresAt, at).toBeNull();
      expect(released.result, at).not.toHaveProperty("cancelFence");
      expect(released.result, at).not.toHaveProperty("cancelIntent");
      expect(released.result, at).toMatchObject({
        cancelledBatchIds: ["batch-1"],
      });
      expect(env.created, at).toEqual(["batch-1"]);
    }
  });

  it("a sweep stopped at any of its writes: run.redrive reports the hold and when it ends, and once it has the redriven step takes the row over and the run completes", async () => {
    for (const stop of STOPS) {
      const { env, row } = await stoppedSweep(ports, stop);
      const at = `stopped ${stop.when} write ${stop.n}`;

      const redriven = await env.redrive();
      if (holds(stop)) {
        const heldUntil = row.leaseExpiresAt!.toISOString();
        expect(redriven.batches, at).toEqual([
          expect.objectContaining({
            stageId: "map",
            stepId: "extract:submit",
            ref: expect.objectContaining({ id: "batch-1" }),
            status: "held",
            heldUntil,
            error: expect.stringContaining(
              `holds this step until ${heldUntil}`,
            ),
          }),
        ]);
        // The hold is live: the step waits instead of using the handle.
        expect((await env.host(await env.next())).outcome, at).toBe(
          "suspended",
        );
        expect(env.created, at).toEqual(["batch-1"]);
        await env.poll(10 * 60_000);
      } else {
        expect(redriven, at).not.toHaveProperty("batches");
        expect((await env.host(await env.next())).outcome, at).toBe(
          "suspended",
        );
      }

      // A cancel may have reached batch-1: it is cancelled and replaced.
      // Otherwise none left, and the step goes on with it.
      const live = sent(stop) ? "batch-2" : "batch-1";
      expect(env.created, at).toEqual(
        sent(stop) ? ["batch-1", "batch-2"] : ["batch-1"],
      );
      expect(env.cancelled.has("batch-1"), at).toBe(sent(stop));
      const taken = await env.submitRow();
      expect(taken.result, at).toMatchObject({
        refs: [expect.objectContaining({ id: live })],
      });
      expect(taken.result, at).not.toHaveProperty("cancelFence");
      expect(taken.result, at).not.toHaveProperty("cancelIntent");
      expect(await env.lost(), at).toEqual([]);

      env.finish(live);
      for (
        let i = 0;
        i < 5 && (await env.stage()).status !== "COMPLETED";
        i++
      ) {
        await env.poll(60_000);
        const job = await env.jobTransport.dequeue();
        if (job) await env.host(job as HostJobMessage);
      }
      await env.transition();
      expect((await env.run()).status, at).toBe("COMPLETED");
    }
  });

  it("a third run.cancel while two stopped sweeps hold different submit rows reports both holds, and after them cancels both rows' batches", async () => {
    const env = await mapRun(ports, { twoMaps: true });
    expect((await env.host(await env.next())).outcome).toBe("suspended");
    env.finish("batch-1");
    for (let i = 0; i < 5 && env.created.length < 2; i++) {
      await env.poll(60_000);
      const job = await env.jobTransport.dequeue();
      if (job) await env.host(job as HostJobMessage);
    }
    expect(env.created).toEqual(["batch-1", "batch-2"]);

    // A holds the first row it reached and stops before holding the other.
    const a = env.stopAtSubmitWrite(2, "before");
    void env.cancel();
    await a;
    // B finds A's row held, holds the other, and stops before its intent.
    const b = env.stopAtSubmitWrite(2, "before");
    const second = env.cancel();
    await b;
    const rows = await Promise.all(
      ["extract:submit", "extract2:submit"].map((id) => env.submitRow(id)),
    );
    for (const row of rows) expect(row.result).toHaveProperty("cancelFence");

    const third = await env.cancel();
    expect(third.batches).toHaveLength(2);
    for (const [i, row] of rows.entries()) {
      expect(third.batches).toContainEqual(
        expect.objectContaining({
          stepId: row.stepId,
          ref: expect.objectContaining({ id: `batch-${i + 1}` }),
          status: "held",
          heldUntil: row.leaseExpiresAt!.toISOString(),
        }),
      );
    }

    const last = Math.max(...rows.map((r) => r.leaseExpiresAt!.getTime()));
    env.clock.advance(last - env.clock.now().getTime() + 1);
    const after = await env.cancel();
    expect(after.batches.map((o) => [o.ref?.id, o.status]).sort()).toEqual([
      ["batch-1", "cancelled"],
      ["batch-2", "cancelled"],
    ]);
    for (const id of ["extract:submit", "extract2:submit"]) {
      const row = await env.submitRow(id);
      expect(row.leaseExpiresAt).toBeNull();
      expect(row.result).not.toHaveProperty("cancelFence");
    }
    void second;
  });

  /**
   * A submit body held up before its provider call while the run is
   * cancelled and redriven, and the redriven job records its own batch
   * (`batch-1`) first. Released, the late body creates `batch-2` and loses
   * the row.
   */
  async function lateSubmit(
    env: Awaited<ReturnType<typeof mapRun>>,
    abortSignal?: AbortSignal,
    onCancelled?: () => void,
  ) {
    const inStart = gate();
    const go = gate();
    env.setBeforeStart(async () => {
      env.setBeforeStart(undefined);
      inStart.release();
      await go.promise;
    });
    const first = await env.next();
    const late = abortSignal
      ? env.deliver(first, abortSignal)
      : env.host(first);
    await inStart.promise;
    await env.cancel();
    onCancelled?.();
    await env.redrive();
    expect((await env.host(await env.next())).outcome).toBe("suspended");
    expect(env.created).toEqual(["batch-1"]);
    return { go: go.release, done: late.catch(() => undefined) };
  }

  it("with results spilled to the blob store, a submit body that loses the row leaves the winner's record as it was and cancels its own batch", async () => {
    const env = await mapRun(ports, { spill: true });
    const late = await lateSubmit(env);
    const won = await env.submitRow();
    expect(won.result).toMatchObject({
      refs: [expect.objectContaining({ id: "batch-1" })],
    });
    late.go();
    await late.done;

    expect(env.created).toEqual(["batch-1", "batch-2"]);
    expect(await env.submitRow()).toMatchObject({ result: won.result });
    expect(env.cancelled.has("batch-2")).toBe(true);
    expect(await env.lost()).toEqual([]);
    const swept = await env.cancel();
    expect(swept.batches).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ id: "batch-1" }),
        status: "cancelled",
      }),
    ]);
  });

  it("a submit body that lost the row cancels its batch when the answer to its exclusion write is lost", async () => {
    const env = await mapRun(ports);
    const late = await lateSubmit(env);
    let lostAnswers = 0;
    env.loseAnswerTo((patch) => {
      const owed = (
        patch.result as { cancelOwed?: Array<{ id: string }> } | undefined
      )?.cancelOwed;
      const hit = owed?.some((ref) => ref.id === "batch-2") === true;
      if (hit) lostAnswers++;
      return hit;
    });
    late.go();
    await late.done;

    expect(lostAnswers).toBeGreaterThan(0);
    // Owed until the provider answered the body's cancel, then cancelled.
    const result = (await env.submitRow()).result;
    expect(result).toMatchObject({
      refs: [expect.objectContaining({ id: "batch-1" })],
      cancelledBatchIds: expect.arrayContaining(["batch-2"]),
    });
    expect(result).not.toHaveProperty("cancelOwed");
    expect(env.cancelled.has("batch-2")).toBe(true);
    expect(await env.lost()).toEqual([]);
  });

  it("an aborted submit body whose own cancel loses the row hands its batch to the loser's cleanup, which cancels it", async () => {
    const env = await mapRun(ports);
    const abort = new AbortController();
    const late = await lateSubmit(env, abort.signal, () =>
      abort.abort(new StageAbortedError("cancelled", env.workflowRunId)),
    );
    late.go();
    await late.done;

    expect(env.cancelled.has("batch-2")).toBe(true);
    expect(await env.lost()).toEqual([]);
    expect(env.warnings.filter((w) => w.message.includes('"batch-2"'))).toEqual(
      [],
    );
  });

  it("a run.cancel held up after reading the run, while another cancel and a redrive ran, cancels and sweeps the generation it ends", async ({
    skip,
  }) => {
    const env = await mapRun(ports);
    if (!env.concurrentTransactions) skip();
    await env.host(await env.next());
    const read = gate();
    const go = gate();
    env.afterNextRunRead(async () => {
      read.release();
      await go.promise;
    });
    const delayed = env.cancel();
    await read.promise;
    await env.cancel();
    await env.redrive();
    expect((await env.host(await env.next())).outcome).toBe("suspended");
    expect(env.created).toEqual(["batch-1", "batch-2"]);
    go.release();
    const result = await delayed;

    expect(await env.run()).toMatchObject({
      status: "CANCELLED",
      redriveCount: 1,
    });
    expect(result).toEqual({
      cancelled: true,
      batches: [
        expect.objectContaining({
          ref: expect.objectContaining({ id: "batch-2" }),
          status: "cancelled",
        }),
      ],
    });
    expect([...env.cancelled].sort()).toEqual(["batch-1", "batch-2"]);
  });

  for (const from of ["resume", "start"] as const) {
    it(`a run.redrive (${from}) while a sweep resolves the provider: the redriven run keeps its batch, and a batch whose row the redrive deleted is cancelled`, async () => {
      const env = await mapRun(ports);
      await env.host(await env.next());
      const resolving = gate();
      const go = gate();
      env.setBeforeResolve(async () => {
        env.setBeforeResolve(undefined);
        resolving.release();
        await go.promise;
      });
      const sweep = env.cancel();
      await resolving.promise;
      await env.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: env.workflowRunId,
        ...(from === "start" ? { from: { kind: "start" as const } } : {}),
      });
      go.release();
      const result = await sweep;
      expect((await env.host(await env.next())).outcome).toBe("suspended");

      if (from === "resume") {
        expect(env.cancelled.size).toBe(0);
        // The intent the sweep recorded reached no provider: not kept.
        expect(result.batches).toEqual([]);
        expect(env.created).toEqual(["batch-1"]);
        const row = await env.submitRow();
        expect(row.result).toMatchObject({
          refs: [expect.objectContaining({ id: "batch-1" })],
        });
        expect(row.result).not.toHaveProperty("cancelIntent");
        expect(row.result).not.toHaveProperty("cancelFence");
      } else {
        // The redrive deleted the stage record and the row with it: nothing
        // can find the old batch again, so the sweep sends its cancel with
        // no record, and names it.
        expect(env.created).toEqual(["batch-1", "batch-2"]);
        expect([...env.cancelled]).toEqual(["batch-1"]);
        expect(result.batches).toEqual([
          expect.objectContaining({
            ref: expect.objectContaining({ id: "batch-1" }),
            status: "cancelled",
            error: expect.stringContaining("deleted with its stage record"),
          }),
        ]);
        expect(env.warnings.some((w) => w.message.includes('"batch-1"'))).toBe(
          true,
        );
      }
    });
  }
}
