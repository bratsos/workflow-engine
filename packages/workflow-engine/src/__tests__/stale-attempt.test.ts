/**
 * An attempt that was overtaken while its body ran (its run was cancelled and
 * a redrive or rerunFrom reopened the stage, with a job of its own) commits
 * nothing when the body settles: not the failure, the retry, the suspension
 * or the completion. Through kernel.dispatch and the host path both hosts
 * share, on the in-memory ports and, with SQLITE8_KERNEL_SQLITE=1 or
 * DATABASE_URL, on the Prisma ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../core/stage-factory.js";
import { WorkflowBuilder } from "../core/workflow.js";
import { executeJobWithHeartbeat } from "../kernel/helpers/host-support.js";
import { createKernel, type KernelConfig } from "../kernel/kernel.js";
import type { DequeueResult } from "../kernel/ports.js";
import {
  CollectingEventSink,
  InMemoryBlobStore,
} from "../kernel/testing/index.js";
import {
  InMemoryJobQueue,
  InMemoryStepLedger,
  InMemoryWorkflowPersistence,
} from "../testing/index.js";
import {
  type KernelDatabase,
  kernelDatabase,
  override,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";

const schema = z.object({});
const budget = 3;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

const endings = {
  "fails for good": () => {
    throw z.number().safeParse("x").error;
  },
  "fails with a retry left": () => {
    throw new Error("provider unavailable");
  },
  completes: () => ({ output: { stale: true } }),
  suspends: (ctx: { step: { sleep(id: string, ms: number): Promise<void> } }) =>
    ctx.step.sleep("nap", 600_000),
} as const;

describe(`a stale attempt on ${realDatabase ? (sqlite ? "SQLite" : "Postgres") : "memory"}`, () => {
  let db: KernelDatabase | undefined;
  let ports: Pick<
    KernelConfig,
    "persistence" | "jobTransport" | "stepLedger" | "blobStore"
  >;

  beforeAll(async () => {
    if (realDatabase) db = await kernelDatabase();
  }, 120_000);
  beforeEach(async () => {
    await db?.reset();
    ports = db
      ? {
          persistence: db.persistence,
          jobTransport: db.jobTransport,
          stepLedger: db.stepLedger,
          blobStore: db.blobStore,
        }
      : {
          persistence: new InMemoryWorkflowPersistence(),
          jobTransport: new InMemoryJobQueue(),
          stepLedger: new InMemoryStepLedger(),
          blobStore: new InMemoryBlobStore(),
        };
  });
  afterAll(async () => {
    await db?.close();
  });

  /**
   * Entry 1 is the attempt that gets overtaken: it holds in its body until
   * `release`, then settles as `ending`. With `secondFails`, entry 2 fails
   * for good (the run ends FAILED before a rerunFrom). Later entries succeed.
   */
  async function overtaken(ending: keyof typeof endings, secondFails = false) {
    const held = gate();
    const release = gate();
    let entries = 0;
    const workflow = new WorkflowBuilder(
      "stale-attempt",
      "Stale attempt",
      "stale-attempt",
      schema,
      z.any(),
    )
      .pipe(
        defineStage({
          id: "s",
          name: "S",
          schemas: { input: schema, output: z.any(), config: schema },
          async execute(ctx) {
            const entry = ++entries;
            await ctx.step.run("receipt", async () => entry);
            if (entry === 1) {
              held.open();
              await release.opened;
              return (await endings[ending](ctx as never)) as never;
            }
            if (entry === 2 && secondFails) throw endings["fails for good"]();
            return { output: { entry } };
          },
        }),
      )
      .build();
    const kernel = createKernel({
      ...ports,
      eventSink: new CollectingEventSink(),
      clock: { now: () => new Date() },
      registry: { getWorkflow: () => workflow },
    });
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      workflowId: workflow.id,
      input: {},
      idempotencyKey: crypto.randomUUID(),
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    const deliver = (job: DequeueResult) =>
      executeJobWithHeartbeat(kernel, {
        jobTransport: ports.jobTransport,
        job: {
          jobId: job.jobId,
          workflowRunId,
          workflowId: workflow.id,
          stageId: "s",
          attempt: job.attempt,
          maxAttempts: budget,
          payload: job.payload,
          startedAt: job.startedAt,
        },
      });
    const events = async () =>
      (await ports.persistence.getUnpublishedOutboxEvents(1000))
        .filter((row) => row.workflowRunId === workflowRunId)
        .map((row) => row.eventType);
    const first = (await ports.jobTransport.dequeue())!;
    const stale = deliver(first);
    await held.opened;
    return {
      kernel,
      workflowRunId,
      deliver,
      events,
      stale,
      release: release.open,
      entries: () => entries,
    };
  }

  const redrives = [
    ["a redrive of the stage", { kind: "stage", stageId: "s" }],
    ["a redrive from the last failure", { kind: "lastFailure" }],
  ] as const;

  it.each(
    Object.keys(endings).flatMap((ending) =>
      redrives.map(([name, from]) => [ending, name, from] as const),
    ),
  )("commits nothing when it %s after a cancel and %s", async (ending, _name, from) => {
    const t = await overtaken(ending as keyof typeof endings);
    await t.kernel.dispatch({
      type: "run.cancel",
      workflowRunId: t.workflowRunId,
    });
    await t.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: t.workflowRunId,
      from,
    });
    const redriven = (await ports.jobTransport.dequeue())!;
    const stage = (await ports.persistence.getStage(t.workflowRunId, "s"))!;
    expect(stage.status).toBe("PENDING");
    const eventsBefore = await t.events();

    t.release();
    await expect(t.stale).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("result discarded"),
    });

    // The overtaken attempt wrote nothing: the reopened stage, the run and
    // the redrive's job stand as the redrive left them.
    expect(await ports.persistence.getStage(t.workflowRunId, "s")).toEqual(
      stage,
    );
    expect(await t.events()).toEqual(eventsBefore);
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "RUNNING",
    );
    expect(
      (await ports.jobTransport.getJobsByWorkflowRun(t.workflowRunId))[0]
        ?.status,
    ).toBe("RUNNING");

    // The redrive's job runs the stage and recovers the run.
    await expect(t.deliver(redriven)).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(t.entries()).toBe(2);
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });

  it.each(
    Object.keys(endings),
  )("commits nothing when it %s after rerunFrom reopened the stage", async (ending) => {
    const t = await overtaken(ending as keyof typeof endings, true);
    // A lost lease hands the job to a second attempt, which fails the run.
    await sleep(20);
    await expect(
      t.kernel.dispatch({ type: "lease.reapStale", staleThresholdMs: 0 }),
    ).resolves.toMatchObject({ released: 1 });
    const second = (await ports.jobTransport.dequeue())!;
    await expect(t.deliver(second)).resolves.toMatchObject({
      outcome: "failed",
      willRetry: false,
    });
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "FAILED",
    );
    await t.kernel.dispatch({
      type: "run.rerunFrom",
      workflowRunId: t.workflowRunId,
      fromStageId: "s",
    });
    const rerun = (await ports.jobTransport.dequeue())!;
    const stage = (await ports.persistence.getStage(t.workflowRunId, "s"))!;
    expect(stage.status).toBe("PENDING");
    const eventsBefore = await t.events();

    t.release();
    await expect(t.stale).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("result discarded"),
    });

    expect(await ports.persistence.getStage(t.workflowRunId, "s")).toEqual(
      stage,
    );
    expect(await t.events()).toEqual(eventsBefore);
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "RUNNING",
    );
    await expect(t.deliver(rerun)).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(t.entries()).toBe(3);
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });

  it("keeps the result of an attempt whose stage a signal woke while it ran", async () => {
    const t = await overtaken("completes");
    // The wake moves `nextPollAt` on the RUNNING stage and so its version, but
    // not the claim: the attempt is still the stage's attempt.
    await t.kernel.dispatch({
      type: "step.signal",
      workflowRunId: t.workflowRunId,
      stageId: "s",
      stepId: "approval",
      payload: "go",
    });

    t.release();

    await expect(t.stale).resolves.toMatchObject({ outcome: "completed" });
    expect(
      (await ports.persistence.getStage(t.workflowRunId, "s"))?.status,
    ).toBe("COMPLETED");
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });

  /**
   * `s` then `t`, which records the input it got. Entry 1 of `s` holds in
   * its body until `release` and then settles as `first`; entry 2 holds
   * until `releaseSecond` when `holdSecond` is set. Every later entry
   * succeeds with `{ who: "J<entry>" }` and an artifact holding the same.
   */
  async function pipeline(
    first: (ctx: never) => unknown,
    holdSecond = false,
    { attempts = budget, frozen = false } = {},
  ) {
    const held = gate();
    const release = gate();
    const heldSecond = gate();
    const releaseSecond = gate();
    let entries = 0;
    const frozenAt = new Date();
    const tInputs: unknown[] = [];
    /** What `t` read at the stage's fixed keys, as code on every release could. */
    const tFixed: unknown[] = [];
    const workflow = new WorkflowBuilder(
      "attempt-owner",
      "Attempt owner",
      "attempt-owner",
      schema,
      z.any(),
    )
      .pipe(
        defineStage({
          id: "s",
          name: "S",
          schemas: { input: schema, output: z.any(), config: schema },
          async execute(ctx) {
            const entry = ++entries;
            if (entry === 1) {
              held.open();
              await release.opened;
              return (await first(ctx as never)) as never;
            }
            if (entry === 2 && holdSecond) {
              heldSecond.open();
              await releaseSecond.opened;
            }
            const who = { who: `J${entry}` };
            return { output: who, artifacts: { raw: who } };
          },
        }),
      )
      .pipe(
        defineStage({
          id: "t",
          name: "T",
          schemas: { input: z.any(), output: z.any(), config: schema },
          async execute(ctx) {
            tInputs.push(ctx.input);
            const read = (key: string) =>
              ctx.storage.load(key).catch(() => "missing");
            tFixed.push({
              output: await read(ctx.storage.getStageKey("s")),
              raw: await read(
                ctx.storage.getStageKey("s", "artifacts/raw.json"),
              ),
            });
            return { output: ctx.input };
          },
        }),
      )
      .build();
    const kernel = createKernel({
      ...ports,
      eventSink: new CollectingEventSink(),
      // Frozen: a takeover in the same millisecond must still change owner.
      clock: { now: () => (frozen ? frozenAt : new Date()) },
      registry: { getWorkflow: () => workflow },
    });
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      workflowId: workflow.id,
      input: {},
      idempotencyKey: crypto.randomUUID(),
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    const deliver = (job: DequeueResult) =>
      executeJobWithHeartbeat(kernel, {
        jobTransport: ports.jobTransport,
        job: { ...job, maxAttempts: attempts },
      });
    const drain = async () => {
      for (let job = await ports.jobTransport.dequeue(); job; ) {
        await deliver(job);
        job = await ports.jobTransport.dequeue();
      }
    };
    const stale = deliver((await ports.jobTransport.dequeue())!);
    await held.opened;
    const prefix = `workflow-v2/${workflow.id}/${workflowRunId}/s/`;
    return {
      kernel,
      workflowRunId,
      deliver,
      drain,
      stale,
      release: release.open,
      heldSecond: heldSecond.opened,
      releaseSecond: releaseSecond.open,
      entries: () => entries,
      tInputs,
      tFixed,
      /** What the stage row points at, read through its pointers. */
      committed: async () => {
        const row = (await ports.persistence.getStage(workflowRunId, "s"))!;
        const data = row.outputData as {
          _artifactKey: string;
          _artifactKeys?: Record<string, string>;
        };
        return {
          output: await ports.blobStore.get(data._artifactKey),
          raw: await ports.blobStore.get(data._artifactKeys!.raw),
        };
      },
      /** Every blob value saved under the stage's prefix. */
      blobs: async () =>
        Promise.all(
          (await ports.blobStore.list(prefix)).map((key) =>
            ports.blobStore.get(key),
          ),
        ),
    };
  }

  const overtakers = {
    "a cancel and a redrive": async (
      kernel: Awaited<ReturnType<typeof pipeline>>["kernel"],
      workflowRunId: string,
    ) => {
      await kernel.dispatch({ type: "run.cancel", workflowRunId });
      await kernel.dispatch({
        type: "run.redrive",
        workflowRunId,
        from: { kind: "stage", stageId: "s" },
      });
    },
    "a lost lease": async (
      kernel: Awaited<ReturnType<typeof pipeline>>["kernel"],
    ) => {
      await sleep(20);
      await kernel.dispatch({ type: "lease.reapStale", staleThresholdMs: 0 });
    },
  };

  it.each(
    Object.keys(overtakers),
  )("keeps the output and artifacts of the attempt that took over after %s, for the next stage too", async (name) => {
    const t = await pipeline(() => ({
      output: { who: "A" },
      artifacts: { raw: { who: "A" } },
    }));
    await overtakers[name as keyof typeof overtakers](
      t.kernel,
      t.workflowRunId,
    );
    await expect(
      t.deliver((await ports.jobTransport.dequeue())!),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(await t.committed()).toEqual({
      output: { who: "J2" },
      raw: { who: "J2" },
    });

    // The overtaken attempt finishes last: its result and its blobs go.
    t.release();
    await expect(t.stale).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("result discarded"),
    });
    expect(await t.committed()).toEqual({
      output: { who: "J2" },
      raw: { who: "J2" },
    });
    expect(await t.blobs()).not.toContainEqual({ who: "A" });

    await t.drain();
    expect(t.tInputs).toEqual([{ who: "J2" }]);
    // Only the committed winner wrote the stage's fixed keys.
    expect(t.tFixed).toEqual([{ output: { who: "J2" }, raw: { who: "J2" } }]);
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });

  it.each(
    Object.keys(endings).flatMap((ending) =>
      [false, true].flatMap((signal) =>
        [false, true].map((frozen) => [ending, signal, frozen] as const),
      ),
    ),
  )("lets the attempt that took over a lost lease finish when the stale one %s first (signal between: %s, frozen clock: %s)", async (ending, signal, frozen) => {
    const t = await pipeline(
      endings[ending as keyof typeof endings] as never,
      true,
      { frozen },
    );
    await overtakers["a lost lease"](t.kernel);
    const second = t.deliver((await ports.jobTransport.dequeue())!);
    await t.heldSecond;
    if (signal) {
      // A wake on the RUNNING stage must not hand it back to the stale owner.
      await t.kernel.dispatch({
        type: "step.signal",
        workflowRunId: t.workflowRunId,
        stageId: "s",
        stepId: "poke",
        payload: 1,
      });
    }

    t.release();
    await expect(t.stale).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("result discarded"),
    });
    const stage = (await ports.persistence.getStage(t.workflowRunId, "s"))!;
    expect(stage.status).toBe("RUNNING");
    expect(stage.errorMessage).toBeNull();

    t.releaseSecond();
    await expect(second).resolves.toMatchObject({ outcome: "completed" });
    await t.drain();
    expect(t.entries()).toBe(2);
    expect(t.tInputs).toEqual([{ who: "J2" }]);
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });

  it.each([
    3, 1,
  ])("commits the attempt whose RUNNING stage a step.signal of an earlier release nudged (attempts: %i)", async (attempts) => {
    const t = await pipeline(() => ({ output: { who: "A" } }), false, {
      attempts,
    });
    // What `step.signal` of every release does to a RUNNING stage.
    const row = (await ports.persistence.getStage(t.workflowRunId, "s"))!;
    await ports.persistence.updateStage(row.id, { nextPollAt: new Date() });

    t.release();
    await expect(t.stale).resolves.toMatchObject({ outcome: "completed" });
    await t.drain();
    expect(t.entries()).toBe(1);
    expect(t.tInputs).toEqual([{ who: "A" }]);
    expect(t.tFixed).toEqual([{ output: { who: "A" }, raw: "missing" }]);
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });

  /** A stage that waits for signal `approval`; `signal` goes through a store whose first `getStage` runs `hook`. */
  async function signalWait(holdFirst: boolean) {
    const bodyHeld = gate();
    const bodyGo = gate();
    let entries = 0;
    let hook: ((row: unknown) => Promise<void>) | undefined;
    const workflow = new WorkflowBuilder(
      "signal-wait",
      "Signal wait",
      "signal-wait",
      schema,
      z.any(),
    )
      .pipe(
        defineStage({
          id: "s",
          name: "S",
          schemas: { input: schema, output: z.any(), config: schema },
          async execute(ctx) {
            if (++entries === 1 && holdFirst) {
              bodyHeld.open();
              await bodyGo.opened;
            }
            const value = await ctx.step.waitForSignal("approval", {
              timeout: "1h",
              keepalive: "30m",
            });
            return { output: value };
          },
        }),
      )
      .build();
    const config = {
      ...ports,
      eventSink: new CollectingEventSink(),
      clock: { now: () => new Date() },
      registry: { getWorkflow: () => workflow },
    };
    const kernel = createKernel(config);
    const hooked = createKernel({
      ...config,
      persistence: override(ports.persistence, {
        getStage: async (runId: string, stageId: string) => {
          const row = await ports.persistence.getStage(runId, stageId);
          const run = hook;
          hook = undefined;
          await run?.(row);
          return row;
        },
      }),
    });
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      workflowId: workflow.id,
      input: {},
      idempotencyKey: crypto.randomUUID(),
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    const job = (await ports.jobTransport.dequeue())!;
    const execution = executeJobWithHeartbeat(kernel, {
      jobTransport: ports.jobTransport,
      job: { ...job, maxAttempts: budget },
    });
    const signal = (payload: string) =>
      hooked.dispatch({
        type: "step.signal",
        workflowRunId,
        stageId: "s",
        stepId: "approval",
        payload,
      });
    return {
      workflowRunId,
      execution,
      signal,
      bodyHeld: bodyHeld.opened,
      bodyGo: bodyGo.open,
      setHook: (next: (row: unknown) => Promise<void>) => {
        hook = next;
      },
      stage: async () =>
        (await ports.persistence.getStage(workflowRunId, "s"))!,
      signalled: async () =>
        (await ports.persistence.getUnpublishedOutboxEvents(1000)).filter(
          (row) =>
            row.workflowRunId === workflowRunId &&
            row.eventType === "step:signalled",
        ).length,
    };
  }

  it("wakes a stage at once when the signal read it RUNNING and it suspended before the wake", async () => {
    const t = await signalWait(true);
    await t.bodyHeld;
    const read = gate();
    const go = gate();
    t.setHook(async () => {
      read.open();
      await go.opened;
    });
    const signal = t.signal("one");
    await read.opened;
    // The attempt reaches the wait before the signal is stored and suspends
    // for its keepalive.
    t.bodyGo();
    await expect(t.execution).resolves.toMatchObject({ outcome: "suspended" });
    expect((await t.stage()).status).toBe("SUSPENDED");

    go.open();
    await expect(signal).resolves.toMatchObject({ signalled: true });
    const stage = await t.stage();
    expect(stage.nextPollAt!.getTime()).toBeLessThan(Date.now() + 60_000);
    expect(await t.signalled()).toBe(1);
  });

  it("wakes the stage when another write lands between the signal's read and its wake", async () => {
    const t = await signalWait(false);
    await expect(t.execution).resolves.toMatchObject({ outcome: "suspended" });
    t.setHook(async (row) => {
      await ports.persistence.updateStage((row as { id: string }).id, {
        nextPollAt: new Date("2099-01-01"),
      });
    });

    await expect(t.signal("one")).resolves.toMatchObject({
      signalled: true,
      alreadyCompleted: false,
    });
    expect((await t.stage()).nextPollAt!.getTime()).toBeLessThan(
      Date.now() + 60_000,
    );
    await expect(t.signal("two")).resolves.toMatchObject({
      alreadyCompleted: true,
    });
    expect(await t.signalled()).toBe(1);
  });

  it("reads an output pointer stored by an earlier release", async () => {
    const t = await pipeline(() => ({ output: { who: "A" } }));
    t.release();
    await t.stale;
    // Rewrite the row the way an earlier release stored it: one key per stage.
    const row = (await ports.persistence.getStage(t.workflowRunId, "s"))!;
    const legacy = `workflow-v2/attempt-owner/${t.workflowRunId}/s/output.json`;
    await ports.blobStore.put(legacy, { who: "legacy" });
    await ports.persistence.updateStage(row.id, {
      outputData: { _artifactKey: legacy },
    });

    await t.drain();
    expect(t.tInputs).toEqual([{ who: "legacy" }]);
  });
});
