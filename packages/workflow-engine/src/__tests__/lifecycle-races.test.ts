/**
 * Writers racing run.purge and run.redrive, through kernel.dispatch on the
 * in-memory ports and, with SQLITE8_KERNEL_SQLITE=1 or DATABASE_URL, on the
 * real Prisma adapters.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAsyncBatchStage, defineStage } from "../core/stage-factory.js";
import { WorkflowBuilder } from "../core/workflow.js";
import { createKernel, type KernelConfig } from "../kernel/kernel.js";
import {
  createSpillingJobTransport,
  jobSpillPrefix,
  stepWriteSpillPrefix,
} from "../kernel/spill.js";
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
const workflow = new WorkflowBuilder(
  "lifecycle-races",
  "Lifecycle races",
  "lifecycle-races",
  schema,
  z.any(),
)
  .pipe(
    defineStage({
      id: "s",
      name: "S",
      schemas: { input: schema, output: z.any(), config: schema },
      async execute(ctx) {
        await ctx.storage.save("receipt", { saved: true });
        return { output: { done: true } };
      },
    }),
  )
  .build();

const big = "x".repeat(64);
const later = () => new Date(Date.now() + 60_000);
const wakeKey = (stageRecordId: string, stepId: string) =>
  JSON.stringify([stageRecordId, stepId]);

function gate() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  return {
    open,
    reached: arrived,
    async pause() {
      reached();
      await opened;
    },
  };
}

describe(`lifecycle races on ${realDatabase ? (sqlite ? "SQLite" : "Postgres") : "memory"}`, () => {
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

  const kernel = (changes: Partial<KernelConfig> = {}) => {
    const k = createKernel({
      ...ports,
      spillThresholdBytes: 8,
      eventSink: new CollectingEventSink(),
      clock: { now: () => new Date() },
      registry: { getWorkflow: () => workflow },
      ...changes,
    });
    return (command: Record<string, unknown>) => k.dispatch(command as any);
  };

  async function createClaimed(send = kernel()) {
    const { workflowRunId } = (await send({
      type: "run.create",
      workflowId: workflow.id,
      input: {},
      idempotencyKey: crypto.randomUUID(),
    })) as { workflowRunId: string };
    await send({ type: "run.claimPending", workerId: "w" });
    return workflowRunId;
  }

  const stageRecordId = async (workflowRunId: string) =>
    (await ports.persistence.getStage(workflowRunId, "s"))!.id;
  const wake = (id: string, stepId: string) =>
    ports.persistence.acquireIdempotencyKey(
      wakeKey(id, stepId),
      "step.signal.wake",
    );

  it("cleans the stage records a restart created between selection and the sweep", async () => {
    const send = kernel();
    const runId = await createClaimed(send);
    await send({ type: "run.cancel", workflowRunId: runId });
    let current = "";
    const { persistence } = ports;
    const purge = kernel({
      persistence: override(persistence, {
        withTransaction: async (fn) => {
          const selected = await persistence.withTransaction(fn);
          // Selection has committed; the sweep has not started.
          await send({
            type: "run.redrive",
            workflowRunId: runId,
            from: { kind: "start" },
          });
          current = await stageRecordId(runId);
          await send({
            type: "step.signal",
            workflowRunId: runId,
            stageId: "s",
            stepId: "ready",
            payload: big,
          });
          await send({ type: "run.cancel", workflowRunId: runId });
          return selected;
        },
      }),
    });

    await expect(
      purge({ type: "run.purge", olderThan: later() }),
    ).resolves.toEqual({
      purged: 1,
      workflowRunIds: [runId],
    });
    expect(await ports.blobStore.list(stepWriteSpillPrefix(current))).toEqual(
      [],
    );
    expect((await wake(current, "ready")).status).toBe("acquired");
  });

  it("purges a run whose first-stage enqueue was in flight once the enqueue lands", async () => {
    const send = kernel();
    const spilling = createSpillingJobTransport(ports.jobTransport, {
      blobStore: ports.blobStore,
      thresholdBytes: 1,
    });
    const held = gate();
    const claimant = kernel({
      jobTransport: override(spilling, {
        enqueueParallel: async (jobs) => {
          await held.pause();
          return spilling.enqueueParallel(jobs);
        },
      }),
    });
    const { workflowRunId: runId } = (await send({
      type: "run.create",
      workflowId: workflow.id,
      input: {},
      idempotencyKey: crypto.randomUUID(),
    })) as { workflowRunId: string };
    const claim = claimant({ type: "run.claimPending", workerId: "w" });
    await held.reached;
    await send({ type: "run.cancel", workflowRunId: runId });
    // Prisma registers the enqueue as a writer of the run, so the age sweep
    // leaves the run until it ends; the in-memory store registers nothing.
    const purged = { purged: 1, workflowRunIds: [runId] };
    const none = { purged: 0, workflowRunIds: [] };
    await expect(
      send({ type: "run.purge", olderThan: later() }),
    ).resolves.toEqual(realDatabase ? none : purged);
    held.open();

    // The job lands for a run that still exists only when the sweep waited.
    await expect(claim).resolves.toMatchObject({
      claimed: [
        {
          workflowRunId: runId,
          jobIds: realDatabase ? [expect.any(String)] : [],
        },
      ],
    });
    await expect(
      send({ type: "run.purge", olderThan: later() }),
    ).resolves.toEqual(realDatabase ? purged : none);

    expect(await ports.jobTransport.getJobsByWorkflowRun(runId)).toEqual([]);
    expect(await ports.blobStore.list(jobSpillPrefix(runId))).toEqual([]);
  });

  it("removes what a signal wrote after the sweep had finished with its stage", async () => {
    const send = kernel();
    const runId = await createClaimed(send);
    await send({ type: "run.cancel", workflowRunId: runId });
    const id = await stageRecordId(runId);
    const ledger = ports.stepLedger!;
    const held = gate();
    const signaller = kernel({
      stepLedger: override(ledger, {
        get: async (recordId, stepId) => {
          await held.pause();
          return ledger.get(recordId, stepId);
        },
      }),
    });
    const signal = signaller({
      type: "step.signal",
      workflowRunId: runId,
      stageId: "s",
      stepId: "late",
      payload: big,
    });
    await held.reached;
    // Prisma registers the sender as a writer of the run, so the sweep leaves
    // the run until it is done; the in-memory store registers nothing.
    const purged = { purged: 1, workflowRunIds: [runId] };
    const none = { purged: 0, workflowRunIds: [] };
    await expect(
      send({ type: "run.purge", olderThan: later() }),
    ).resolves.toEqual(realDatabase ? none : purged);
    held.open();

    if (realDatabase) {
      await expect(signal).resolves.toMatchObject({ signalled: true });
      await expect(
        send({ type: "run.purge", olderThan: later() }),
      ).resolves.toEqual(purged);
    } else {
      await expect(signal).rejects.toThrow();
    }
    expect(await ledger.list(id)).toEqual([]);
    expect(await ports.blobStore.list(stepWriteSpillPrefix(id))).toEqual([]);
    expect((await wake(id, "late")).status).toBe("acquired");
  });

  it("releases the wake keys of the stage records a restart deletes", async () => {
    const send = kernel();
    const runId = await createClaimed(send);
    const first = await stageRecordId(runId);
    await send({
      type: "step.signal",
      workflowRunId: runId,
      stageId: "s",
      stepId: "ready",
      payload: 1,
    });
    await send({ type: "run.cancel", workflowRunId: runId });
    await send({
      type: "run.redrive",
      workflowRunId: runId,
      from: { kind: "start" },
    });
    expect(await stageRecordId(runId)).not.toBe(first);
    expect((await wake(first, "ready")).status).toBe("acquired");
  });

  describe("a poll that a newer execution superseded writes nothing", () => {
    const outcomes = {
      "returns an error": async () => ({ ready: false, error: "stale poll" }),
      throws: async () => {
        throw new Error("stale poll");
      },
      succeeds: async () => ({ ready: true, output: { winner: "poll" } }),
    } as const;
    const cases = (Object.keys(outcomes) as (keyof typeof outcomes)[]).flatMap(
      (outcome) =>
        (["a completed job", "a redrive"] as const).map(
          (by) => [outcome, by] as const,
        ),
    );

    it.each(cases)("checkCompletion %s after %s", async (outcome, by) => {
      const held = gate();
      let calls = 0;
      let receipt = "";
      const legacy = new WorkflowBuilder(
        "lifecycle-legacy",
        "Lifecycle legacy",
        "lifecycle-legacy",
        schema,
        z.any(),
      )
        .pipe(
          defineAsyncBatchStage({
            id: "s",
            name: "S",
            mode: "async-batch",
            schemas: { input: schema, output: z.any(), config: schema },
            async execute() {
              if (++calls > 1) return { output: { winner: "job" } };
              const poll = { pollInterval: 1000, maxWaitTime: 3_600_000 };
              return {
                suspended: true,
                state: {
                  batchId: "b",
                  submittedAt: new Date().toISOString(),
                  ...poll,
                },
                pollConfig: { nextPollAt: new Date(0), ...poll },
              };
            },
            async checkCompletion(_state, ctx) {
              await held.pause();
              ctx.annotate("stale-note", "poll");
              // What user code writes itself is not fenced: see below.
              receipt = ctx.storage.getStageKey("s", "receipt");
              await ctx.storage.save(receipt, "stale poll");
              return outcomes[outcome]() as never;
            },
          }),
        )
        .build();
      const send = kernel({ registry: { getWorkflow: () => legacy } });
      const runId = await createClaimed(send);
      const execute = () =>
        send({
          type: "job.execute",
          workflowRunId: runId,
          workflowId: legacy.id,
          stageId: "s",
          config: {},
        });
      await execute();
      const poll = send({ type: "stage.pollSuspended" });
      await held.reached;
      if (by === "a redrive") {
        await send({ type: "run.cancel", workflowRunId: runId });
        await send({
          type: "run.redrive",
          workflowRunId: runId,
          from: { kind: "start" },
        });
      }
      await expect(execute()).resolves.toMatchObject({ outcome: "completed" });
      const winner = await ports.persistence.getStage(runId, "s");
      held.open();

      await expect(poll).resolves.toMatchObject({ resumed: 0, failed: 0 });
      expect(await ports.persistence.getStage(runId, "s")).toEqual(winner);
      expect((await ports.persistence.getRun(runId))?.status).toBe("RUNNING");
      const output = (winner?.outputData as { _artifactKey: string })
        ._artifactKey;
      expect(await ports.blobStore.get(output)).toEqual({ winner: "job" });
      const events = (await ports.persistence.getUnpublishedOutboxEvents(1000))
        .filter((e) => e.workflowRunId === runId)
        .map((e) => e.eventType);
      expect(events.filter((t) => t === "stage:completed")).toHaveLength(1);
      expect(events).not.toContain("stage:failed");
      expect(await ports.persistence.listAnnotations(runId)).not.toContainEqual(
        expect.objectContaining({ key: "stale-note" }),
      );
      // Left as documented: a write user code makes through ctx.storage
      // after the poll was superseded lands, at whatever key it names.
      expect(await ports.blobStore.get(receipt)).toBe("stale poll");
    });

    it("a read that fails once after a successful checkCompletion does not fail the stage", async () => {
      let armed = false;
      const legacy = new WorkflowBuilder(
        "lifecycle-blip",
        "Lifecycle blip",
        "lifecycle-blip",
        schema,
        z.any(),
      )
        .pipe(
          defineAsyncBatchStage({
            id: "s",
            name: "S",
            mode: "async-batch",
            schemas: { input: schema, output: z.any(), config: schema },
            async execute() {
              const poll = { pollInterval: 1000, maxWaitTime: 3_600_000 };
              return {
                suspended: true,
                state: {
                  batchId: "b",
                  submittedAt: new Date().toISOString(),
                  ...poll,
                },
                pollConfig: { nextPollAt: new Date(0), ...poll },
              };
            },
            async checkCompletion() {
              armed = true;
              return { ready: true, output: { done: true } } as never;
            },
          }),
        )
        .build();
      const send = kernel({ registry: { getWorkflow: () => legacy } });
      const runId = await createClaimed(send);
      await send({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: legacy.id,
        stageId: "s",
        config: {},
      });
      const persistence = ports.persistence as unknown as Record<
        string,
        unknown
      >;
      const getStage = ports.persistence.getStage.bind(ports.persistence);
      persistence.getStage = async (...args: Parameters<typeof getStage>) => {
        if (armed) {
          armed = false;
          throw new Error("read blip");
        }
        return getStage(...args);
      };
      try {
        await expect(
          send({ type: "stage.pollSuspended" }),
        ).resolves.toMatchObject({ resumed: 1, failed: 0 });
      } finally {
        delete persistence.getStage;
      }
      expect((await ports.persistence.getStage(runId, "s"))?.status).toBe(
        "COMPLETED",
      );
      expect((await ports.persistence.getRun(runId))?.status).not.toBe(
        "FAILED",
      );
    });

    it("a poller that cannot serve the workflow leaves a stage a host completed since the claim", async () => {
      const legacy = new WorkflowBuilder(
        "lifecycle-unserved",
        "Lifecycle unserved",
        "lifecycle-unserved",
        schema,
        z.any(),
      )
        .pipe(
          defineAsyncBatchStage({
            id: "s",
            name: "S",
            mode: "async-batch",
            schemas: { input: schema, output: z.any(), config: schema },
            async execute() {
              const poll = { pollInterval: 1000, maxWaitTime: 3_600_000 };
              return {
                suspended: true,
                state: {
                  batchId: "b",
                  submittedAt: new Date().toISOString(),
                  ...poll,
                },
                pollConfig: { nextPollAt: new Date(0), ...poll },
              };
            },
            async checkCompletion() {
              return { ready: false } as never;
            },
          }),
        )
        .build();
      const send = kernel({ registry: { getWorkflow: () => legacy } });
      const runId = await createClaimed(send);
      await send({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: legacy.id,
        stageId: "s",
        config: {},
      });
      const poll = kernel({
        registry: {
          getWorkflow: () => {
            return undefined as never;
          },
        },
      });
      const persistence = ports.persistence as unknown as Record<
        string,
        unknown
      >;
      const getRun = ports.persistence.getRun.bind(ports.persistence);
      // Between the claim and the registry lookup, a serving host
      // completes the stage.
      persistence.getRun = async (...args: Parameters<typeof getRun>) => {
        delete persistence.getRun;
        const stage = (await ports.persistence.getStage(runId, "s"))!;
        await ports.persistence.updateStage(stage.id, {
          status: "COMPLETED",
          completedAt: new Date(),
        });
        return getRun(...args);
      };
      try {
        await expect(
          poll({ type: "stage.pollSuspended" }),
        ).resolves.toMatchObject({ failed: 0 });
      } finally {
        delete persistence.getRun;
      }
      expect((await ports.persistence.getStage(runId, "s"))?.status).toBe(
        "COMPLETED",
      );
    });

    it("a durable replay that finishes after a completed job", async () => {
      const held = gate();
      let calls = 0;
      const durable = new WorkflowBuilder(
        "lifecycle-durable",
        "Lifecycle durable",
        "lifecycle-durable",
        schema,
        z.any(),
      )
        .pipe(
          defineStage({
            id: "s",
            name: "S",
            schemas: { input: schema, output: z.any(), config: schema },
            async execute(ctx) {
              const call = ++calls;
              await ctx.step.waitForSignal("go", { timeout: "1h" });
              if (call === 2) {
                await held.pause();
                return {
                  output: { winner: "poll" },
                  artifacts: { proof: "poll" },
                };
              }
              return { output: { winner: "job" } };
            },
          }),
        )
        .build();
      const send = kernel({ registry: { getWorkflow: () => durable } });
      const runId = await createClaimed(send);
      const execute = () =>
        send({
          type: "job.execute",
          workflowRunId: runId,
          workflowId: durable.id,
          stageId: "s",
          config: {},
        });
      await execute();
      await send({
        type: "step.signal",
        workflowRunId: runId,
        stageId: "s",
        stepId: "go",
        payload: true,
      });
      const poll = send({ type: "stage.pollSuspended" });
      await held.reached;
      await expect(execute()).resolves.toMatchObject({ outcome: "completed" });
      const winner = await ports.persistence.getStage(runId, "s");
      held.open();

      await expect(poll).resolves.toMatchObject({ resumed: 0, failed: 0 });
      expect(await ports.persistence.getStage(runId, "s")).toEqual(winner);
      const output = (winner?.outputData as { _artifactKey: string })
        ._artifactKey;
      expect(await ports.blobStore.get(output)).toEqual({ winner: "job" });
    });

    it.each([
      "with a retry left",
      "on its last attempt",
    ] as const)("a durable replay that throws after a completed job, %s", async (budget) => {
      const held = gate();
      const durable = signalWorkflow(async (call) => {
        if (call === 2) {
          await held.pause();
          throw new Error("stale replay");
        }
        return { output: { winner: "job" } };
      });
      const { send, runId, execute } = await suspendOnSignal(
        durable,
        budget === "on its last attempt" ? 1 : 3,
      );
      const poll = send({ type: "stage.pollSuspended" });
      await held.reached;
      await expect(execute()).resolves.toMatchObject({ outcome: "completed" });
      const winner = await ports.persistence.getStage(runId, "s");
      held.open();

      await expect(poll).resolves.toMatchObject({ resumed: 0, failed: 0 });
      expect(await ports.persistence.getStage(runId, "s")).toEqual(winner);
      expect((await ports.persistence.getRun(runId))?.status).toBe("RUNNING");
      const events = (await ports.persistence.getUnpublishedOutboxEvents(1000))
        .filter((e) => e.workflowRunId === runId)
        .map((e) => e.eventType);
      expect(events).not.toContain("stage:retrying");
      expect(events).not.toContain("stage:failed");
    });
  });

  it("spends the real budget of a job whose suspension the host has not acknowledged", async () => {
    const durable = signalWorkflow(async (call) => {
      if (call === 2) throw new Error("temporary");
      return { output: { call } };
    });
    // The job is dequeued (RUNNING) with one attempt and never acknowledged.
    const { send, runId } = await suspendOnSignal(durable, 1);
    expect(
      (await ports.jobTransport.getJobsByWorkflowRun(runId))[0]?.status,
    ).toBe("RUNNING");

    await send({ type: "stage.pollSuspended" });
    expect((await ports.persistence.getStage(runId, "s"))?.status).toBe(
      "FAILED",
    );
    expect((await ports.persistence.getRun(runId))?.status).toBe("FAILED");
    expect(durable.calls()).toBe(2);
  });

  /** One durable stage that waits for signal "go"; `after` runs once it arrives. */
  function signalWorkflow(after: (call: number) => Promise<unknown>) {
    let calls = 0;
    return {
      calls: () => calls,
      workflow: new WorkflowBuilder(
        "lifecycle-signal",
        "Lifecycle signal",
        "lifecycle-signal",
        schema,
        z.any(),
      )
        .pipe(
          defineStage({
            id: "s",
            name: "S",
            schemas: { input: schema, output: z.any(), config: schema },
            async execute(ctx) {
              const call = ++calls;
              await ctx.step.waitForSignal("go", { timeout: "1h" });
              return (await after(call)) as never;
            },
          }),
        )
        .build(),
    };
  }

  /**
   * Creates and claims a run, dequeues its job with `maxAttempts`, runs that
   * delivery to its suspension (the row stays RUNNING) and signals it.
   */
  async function suspendOnSignal(
    durable: ReturnType<typeof signalWorkflow>,
    maxAttempts: number,
  ) {
    const send = kernel({ registry: { getWorkflow: () => durable.workflow } });
    if (!db) {
      (ports.jobTransport as InMemoryJobQueue).setDefaultMaxAttempts(
        maxAttempts,
      );
    }
    const runId = await createClaimed(send);
    if (db) {
      await (db.client as any).jobQueue.updateMany({ data: { maxAttempts } });
    }
    const delivery = (await ports.jobTransport.dequeue())!;
    const execute = (extra: Record<string, unknown> = {}) =>
      send({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: durable.workflow.id,
        stageId: "s",
        config: {},
        ...extra,
      });
    await execute({
      attempt: delivery.attempt,
      maxAttempts: delivery.maxAttempts,
    });
    await send({
      type: "step.signal",
      workflowRunId: runId,
      stageId: "s",
      stepId: "go",
      payload: true,
    });
    return { send, runId, execute };
  }

  it("enqueues the restarted run when its cleanup cannot read the current records", async () => {
    let armed = false;
    const send = kernel({
      persistence: override(ports.persistence, {
        getStagesByRun: async (id: string) => {
          if (armed) {
            armed = false;
            throw new Error("read blip");
          }
          return ports.persistence.getStagesByRun(id);
        },
      }),
      blobStore: override(ports.blobStore, {
        list: async (prefix: string) => {
          if (prefix.endsWith("/s/")) armed = true;
          return ports.blobStore.list(prefix);
        },
      }),
    });
    const runId = await createClaimed(send);
    await send({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: workflow.id,
      stageId: "s",
      config: {},
    });
    const output = (
      (await ports.persistence.getStage(runId, "s"))?.outputData as {
        _artifactKey: string;
      }
    )._artifactKey;
    await send({ type: "run.cancel", workflowRunId: runId });
    await send({
      type: "run.redrive",
      workflowRunId: runId,
      from: { kind: "start" },
    });
    expect(
      (await ports.jobTransport.getJobsByWorkflowRun(runId)).filter(
        (job) => job.status === "PENDING",
      ),
    ).toHaveLength(1);
    expect(await ports.blobStore.get(output)).toEqual({ done: true });
  });

  it("keeps the output of a new attempt that completed during the restart's cleanup", async () => {
    const send = kernel();
    const runId = await createClaimed(send);
    const execute = () =>
      send({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: workflow.id,
        stageId: "s",
        config: {},
      });
    await execute();
    await send({ type: "run.transition", workflowRunId: runId });
    const { jobTransport } = ports;
    const restart = kernel({
      jobTransport: override(jobTransport, {
        // The first post-commit step: the new record exists, its job not yet.
        deleteByRunAndStages: async (...args) => {
          await execute();
          return jobTransport.deleteByRunAndStages(...args);
        },
      }),
    });
    await restart({
      type: "run.redrive",
      workflowRunId: runId,
      from: { kind: "start" },
    });

    const stage = await ports.persistence.getStage(runId, "s");
    expect(stage?.status).toBe("COMPLETED");
    const output = (stage?.outputData as { _artifactKey: string })._artifactKey;
    expect(await ports.blobStore.get(output)).toEqual({ done: true });
  });

  it.skipIf(!realDatabase)(
    "leaves a restored record's output readable when the caller's transaction rolls a restart back",
    async () => {
      // External stores, as in production: Prisma-backed ones on the
      // same SQLite file would wait on the caller's write lock.
      const stepLedger = new InMemoryStepLedger();
      const blobStore = new InMemoryBlobStore();
      const send = kernel({ blobStore, stepLedger });
      const runId = await createClaimed(send);
      await send({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: workflow.id,
        stageId: "s",
        config: {},
      });
      await send({ type: "run.transition", workflowRunId: runId });
      const before = await ports.persistence.getStage(runId, "s");
      const { createPrismaWorkflowPersistence, createPrismaJobQueue } =
        await import("../persistence/prisma/index.js");
      const options = {
        databaseType: sqlite ? "sqlite" : "postgresql",
      } as const;

      await expect(
        (db!.client as any).$transaction(async (tx: unknown) => {
          const inner = kernel({
            persistence: createPrismaWorkflowPersistence(tx as any, options),
            jobTransport: createPrismaJobQueue(tx as any, options),
            blobStore,
            stepLedger,
          });
          // Its enqueue cannot run on a borrowed transaction; the cleanup
          // before it has run by then.
          await inner({
            type: "run.redrive",
            workflowRunId: runId,
            from: { kind: "start" },
          }).catch(() => {});
          throw new Error("caller rollback");
        }),
      ).rejects.toThrow("caller rollback");

      const after = await ports.persistence.getStage(runId, "s");
      expect(after?.id).toBe(before?.id);
      const output = (after?.outputData as { _artifactKey: string })
        ._artifactKey;
      expect(await blobStore.get(output)).toEqual({ done: true });
    },
  );

  // Memory only: the window is opened by patching the in-memory port.
  it.skipIf(realDatabase)(
    "refuses a rerunFrom whose run was cancelled while it decided",
    async () => {
      const send = kernel();
      const runId = await createClaimed(send);
      await send({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: workflow.id,
        stageId: "s",
        config: {},
      });
      await send({ type: "run.transition", workflowRunId: runId });
      // The in-memory transaction is the port itself, so patch the port.
      const persistence = ports.persistence as InMemoryWorkflowPersistence;
      const getRun = persistence.getRun.bind(persistence);
      persistence.getRun = async (id) => {
        const run = await getRun(id);
        persistence.getRun = getRun;
        await send({ type: "run.redrive", workflowRunId: runId });
        await send({ type: "run.cancel", workflowRunId: runId });
        return run;
      };

      await expect(
        send({ type: "run.rerunFrom", workflowRunId: runId, fromStageId: "s" }),
      ).rejects.toThrow(/Stale version/);
      expect((await getRun(runId))?.status).toBe("CANCELLED");
    },
  );
});
