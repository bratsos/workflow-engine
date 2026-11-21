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
  stepSpillPrefix,
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
    expect(await ports.blobStore.list(stepSpillPrefix(current))).toEqual([]);
    expect((await wake(current, "ready")).status).toBe("acquired");
  });

  it("refuses a redrive while the sweep deletes the run, so no new attempt loses its data", async () => {
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
    const { blobStore } = ports;
    let redrive: unknown;
    const purge = kernel({
      blobStore: override(blobStore, {
        list: async (prefix) => {
          if (redrive === undefined && prefix.includes(runId)) {
            redrive = await send({
              type: "run.redrive",
              workflowRunId: runId,
            }).catch((error: Error) => error.message);
          }
          return blobStore.list(prefix);
        },
      }),
    });

    await expect(
      purge({ type: "run.purge", olderThan: later() }),
    ).resolves.toEqual({
      purged: 1,
      workflowRunIds: [runId],
    });
    expect(redrive).toMatch(/being deleted by run\.purge/);
    expect(await ports.persistence.getRun(runId)).toBeNull();
    expect(
      await blobStore.list(`workflow-v2/${workflow.id}/${runId}/`),
    ).toEqual([]);
  });

  it("removes a first-stage job whose delayed enqueue lands after the run was purged", async () => {
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
    await expect(
      send({ type: "run.purge", olderThan: later() }),
    ).resolves.toEqual({
      purged: 1,
      workflowRunIds: [runId],
    });
    held.open();

    await expect(claim).resolves.toMatchObject({
      claimed: [{ workflowRunId: runId, jobIds: [] }],
    });
    expect(await ports.jobTransport.getJobsByWorkflowRun(runId)).toEqual([]);
    expect(await ports.blobStore.list(jobSpillPrefix(runId))).toEqual([]);
  });

  it("refuses a signal's wake while the sweep deletes the run and leaves nothing behind", async () => {
    const external = new InMemoryStepLedger();
    const send = kernel({ stepLedger: external });
    const runId = await createClaimed(send);
    await send({ type: "run.cancel", workflowRunId: runId });
    const id = await stageRecordId(runId);
    const { persistence } = ports;
    let signal: unknown;
    const purge = kernel({
      stepLedger: external,
      persistence: override(persistence, {
        deleteRun: async (...args) => {
          signal = await send({
            type: "step.signal",
            workflowRunId: runId,
            stageId: "s",
            stepId: "late",
            payload: big,
          }).catch((error: Error) => error.message);
          return persistence.deleteRun(...args);
        },
      }),
    });

    await expect(
      purge({ type: "run.purge", olderThan: later() }),
    ).resolves.toEqual({
      purged: 1,
      workflowRunIds: [runId],
    });
    expect(signal).toMatch(/being deleted by run\.purge/);
    expect(await external.list(id)).toEqual([]);
    expect(await ports.blobStore.list(stepSpillPrefix(id))).toEqual([]);
    expect((await wake(id, "late")).status).toBe("acquired");
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
    await expect(
      send({ type: "run.purge", olderThan: later() }),
    ).resolves.toEqual({
      purged: 1,
      workflowRunIds: [runId],
    });
    held.open();

    await expect(signal).rejects.toThrow();
    expect(await ledger.list(id)).toEqual([]);
    expect(await ports.blobStore.list(stepSpillPrefix(id))).toEqual([]);
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

  it.each([
    "returns",
    "throws",
  ] as const)("keeps a stage a job completed when a stale checkCompletion %s an error", async (how) => {
    const held = gate();
    let calls = 0;
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
          async checkCompletion() {
            await held.pause();
            if (how === "throws") throw new Error("stale poll");
            return { ready: false, error: "stale poll" };
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
    await expect(execute()).resolves.toMatchObject({ outcome: "completed" });
    held.open();

    await expect(poll).resolves.toMatchObject({ failed: 0 });
    const stage = await ports.persistence.getStage(runId, "s");
    expect(stage?.status).toBe("COMPLETED");
    expect(stage?.errorMessage ?? null).toBeNull();
    expect((await ports.persistence.getRun(runId))?.status).toBe("RUNNING");
  });

  // On the databases the purge claim each redrive takes first serializes the
  // two commands, so the cancel cannot land inside this window.
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
