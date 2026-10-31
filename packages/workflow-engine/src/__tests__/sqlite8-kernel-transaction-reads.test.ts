import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPayloadSpill,
  createSpillingJobTransport,
  stepSpillPrefix,
} from "../kernel/spill.js";
import {
  type KernelDatabase,
  kernelDatabase,
  override,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";
import { wrapStepLedger } from "./utils/step-ledger-double.js";

// Prisma read bindings preserve the shared SQLite transaction; Postgres
// keeps its configured root-port reads. Snapshot visibility cases are SQLite-only.
describe.skipIf(!realDatabase)("kernel transaction-scoped port reads", () => {
  let db: KernelDatabase;
  beforeAll(async () => {
    db = await kernelDatabase();
  }, 120_000);
  beforeEach(async () => {
    await db.reset();
  });
  afterAll(async () => {
    await db?.close();
  });

  function inTransaction(
    prepare: (client: any) => Promise<void>,
    rollback = false,
  ) {
    return override(db.persistence, {
      withTransaction: (fn) =>
        db.persistence.withTransaction(async (tx) => {
          // The real adapter's handle lets this fixture make an uncommitted
          // change before dispatch reads it. Every query still uses the driver.
          await prepare((tx as unknown as { prisma: any }).prisma);
          const result = await fn(tx);
          if (rollback) throw new Error("abort transaction reads");
          return result;
        }),
    });
  }

  async function seedStep() {
    const row = await db.seed("COMPLETED", "COMPLETED");
    await db.stepLedger.claim({
      stageRecordId: row.stage.id,
      stepId: "external",
      seq: 1,
      kind: "run",
      status: "running",
      attempt: 1,
      externalKey: "before",
      result: null,
      leaseExpiresAt: null,
      deadlineAt: null,
    });
    return row;
  }

  it.skipIf(!sqlite)(
    "archives the ledger state visible in the redrive transaction",
    async () => {
      const { id, stage } = await seedStep();
      const kernel = db.makeKernel({
        persistence: inTransaction(async (client) => {
          await client.workflowStep.update({
            where: {
              stageRecordId_stepId: {
                stageRecordId: stage.id,
                stepId: "external",
              },
            },
            data: { externalKey: "after" },
          });
        }),
      });
      await kernel.dispatch({
        type: "run.redrive",
        workflowRunId: id,
        from: { kind: "start" },
      });
      const annotations = await db.persistence.listAnnotations(id);
      expect(annotations).toHaveLength(1);
      expect(annotations[0]!.payload).toMatchObject({
        abandonedSteps: [
          { stepId: "external", status: "running", externalKey: "after" },
        ],
      });
      expect(await db.stepLedger.list(stage.id)).toEqual([]);
      expect((await db.jobTransport.getJobsByWorkflowRun(id))[0]!.status).toBe(
        "PENDING",
      );
    },
  );

  it("rolls back the redrive archive and ledger changes together", async () => {
    const { id, stage } = await seedStep();
    const kernel = db.makeKernel({
      persistence: inTransaction(async (client) => {
        await client.workflowStep.update({
          where: {
            stageRecordId_stepId: {
              stageRecordId: stage.id,
              stepId: "external",
            },
          },
          data: { externalKey: "uncommitted" },
        });
      }, true),
    });
    await expect(
      kernel.dispatch({
        type: "run.redrive",
        workflowRunId: id,
        from: { kind: "start" },
      }),
    ).rejects.toThrow("abort transaction reads");
    expect((await db.persistence.getRun(id))?.status).toBe("COMPLETED");
    expect((await db.stepLedger.list(stage.id))[0]!.externalKey).toBe("before");
    expect(await db.persistence.listAnnotations(id)).toEqual([]);
    expect(await db.persistence.getUnpublishedOutboxEvents(100)).toEqual([]);
    expect(await db.jobTransport.getJobsByWorkflowRun(id)).toHaveLength(1);
  });

  it("fails a redrive without changing its run or ledger when ledger reads fail", async () => {
    const { id, stage } = await seedStep();
    const kernel = db.makeKernel({
      stepLedger: wrapStepLedger(db.stepLedger, {
        list: async () => {
          throw new Error("ledger unavailable");
        },
      }),
    });
    await expect(
      kernel.dispatch({
        type: "run.redrive",
        workflowRunId: id,
        from: { kind: "start" },
      }),
    ).rejects.toThrow("ledger unavailable");
    expect((await db.persistence.getRun(id))?.status).toBe("COMPLETED");
    expect((await db.stepLedger.list(stage.id))[0]!.externalKey).toBe("before");
    expect(await db.persistence.listAnnotations(id)).toEqual([]);
    expect(await db.jobTransport.getJobsByWorkflowRun(id)).toHaveLength(1);
  });

  it("keeps one archive and one new attempt when two redrives race", async () => {
    const { id, stage } = await seedStep();
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        db.kernel.dispatch({
          type: "run.redrive",
          workflowRunId: id,
          from: { kind: "stage", stageId: "first" },
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect((await db.persistence.getRun(id))?.redriveCount).toBe(1);
    expect((await db.persistence.getStage(id, "first"))?.attempt).toBe(1);
    expect(await db.persistence.listAnnotations(id)).toHaveLength(1);
    expect(
      (await db.persistence.getUnpublishedOutboxEvents(100)).map(
        (event) => event.eventType,
      ),
    ).toEqual(["workflow:started"]);
    expect((await db.stepLedger.list(stage.id))[0]!.externalKey).toBe("before");
  });

  it("reads spilled results through the transaction while preserving them for redrive", async () => {
    const { id, stage } = await db.seed("COMPLETED", "COMPLETED");
    const key = `${stepSpillPrefix(stage.id)}work.json`;
    const result = await createPayloadSpill({
      blobStore: db.blobStore,
      thresholdBytes: 1,
    }).pack(key, { value: "kept" });
    await db.stepLedger.claim({
      stageRecordId: stage.id,
      stepId: "work",
      seq: 1,
      kind: "run",
      status: "completed",
      attempt: 1,
      result,
      leaseExpiresAt: null,
      deadlineAt: null,
    });
    const transport = createSpillingJobTransport(db.jobTransport, {
      blobStore: db.blobStore,
      thresholdBytes: 1,
    });
    const kernel = db.makeKernel({ jobTransport: transport });
    await expect(
      kernel.dispatch({
        type: "run.redrive",
        workflowRunId: id,
        from: { kind: "stage", stageId: "first" },
      }),
    ).resolves.toMatchObject({ redriveCount: 1 });
    expect((await db.stepLedger.list(stage.id))[0]!.status).toBe("completed");
    expect(await db.blobStore.get(key)).toEqual({ value: "kept" });
    expect((await transport.getJobsByWorkflowRun(id))[0]!.payload).toEqual({
      config: {},
    });
  });

  it.skipIf(!sqlite)(
    "recovers a missing job using the reaper transaction's current job state",
    async () => {
      const { id, stage, jobId } = await db.seed();
      const old = new Date("2020-01-01T00:00:00Z");
      await db.client.workflowRun.update({
        where: { id },
        data: { updatedAt: old },
      });
      await db.client.workflowStage.update({
        where: { id: stage.id },
        data: { updatedAt: old },
      });
      await db.client.jobQueue.update({
        where: { id: jobId },
        data: { status: "RUNNING" },
      });
      const kernel = db.makeKernel({
        persistence: inTransaction(async (client) => {
          await client.jobQueue.update({
            where: { id: jobId },
            data: { status: "FAILED" },
          });
        }),
      });
      await expect(
        kernel.dispatch({ type: "run.reapStuck", stuckThresholdMs: 1000 }),
      ).resolves.toMatchObject({ failed: 0, healed: 0 });
      expect((await db.persistence.getRun(id))?.status).toBe("RUNNING");
      expect((await db.jobTransport.getJobsByWorkflowRun(id))[0]!.status).toBe(
        "PENDING",
      );
    },
  );

  it("claims missing-job recovery once and rolls that claim back on failure", async () => {
    const { id, stage } = await db.seed();
    await db.jobTransport.deleteByRunAndStages(id, ["first"]);
    const old = new Date("2020-01-01T00:00:00Z");
    await db.client.workflowRun.update({
      where: { id },
      data: { updatedAt: old },
    });
    await db.client.workflowStage.update({
      where: { id: stage.id },
      data: { updatedAt: old },
    });
    const before = (await db.persistence.getRun(id))!;
    const aborted = db.makeKernel({
      persistence: inTransaction(async () => {}, true),
    });
    await expect(
      aborted.dispatch({ type: "run.reapStuck", stuckThresholdMs: 1000 }),
    ).rejects.toThrow("abort transaction reads");
    expect(await db.persistence.getRun(id)).toMatchObject({
      version: before.version,
      updatedAt: old,
    });
    expect(await db.jobTransport.getJobsByWorkflowRun(id)).toEqual([]);

    await db.kernel.dispatch({ type: "run.reapStuck", stuckThresholdMs: 1000 });
    const recovered = (await db.persistence.getRun(id))!;
    expect(recovered.version).toBe(before.version + 1);
    expect(recovered.updatedAt.getTime()).toBeGreaterThan(old.getTime());
    const [job] = await db.jobTransport.getJobsByWorkflowRun(id);
    expect(job!.status).toBe("PENDING");
    await db.kernel.dispatch({ type: "run.reapStuck", stuckThresholdMs: 1000 });
    expect((await db.persistence.getRun(id))?.version).toBe(recovered.version);
    expect(
      (await db.jobTransport.getJobsByWorkflowRun(id)).map((row) => row.id),
    ).toEqual([job!.id]);
    expect(await db.persistence.getUnpublishedOutboxEvents(100)).toEqual([]);
  });

  it.skipIf(!sqlite)(
    "leaves a failed stage's run active when its retry is visible in the transaction",
    async () => {
      const { id, jobId } = await db.seed("RUNNING", "FAILED");
      await db.jobTransport.fail(jobId, "retryable", false);
      const kernel = db.makeKernel({
        persistence: inTransaction(async (client) => {
          await client.jobQueue.update({
            where: { id: jobId },
            data: { status: "PENDING", attempt: 1 },
          });
        }),
      });
      await expect(
        kernel.dispatch({ type: "run.transition", workflowRunId: id }),
      ).resolves.toEqual({ action: "noop" });
      expect((await db.persistence.getRun(id))?.status).toBe("RUNNING");
      expect(await db.persistence.getUnpublishedOutboxEvents(100)).toEqual([]);
    },
  );

  it.skipIf(!sqlite)(
    "completes a run from transaction-consistent blob output and AI totals",
    async () => {
      const { id } = await db.seed("RUNNING", "COMPLETED");
      const stage = await db.persistence.createStage({
        workflowRunId: id,
        stageId: "second",
        stageName: "Second",
        stageNumber: 2,
        executionGroup: 2,
        status: "COMPLETED",
      });
      const key = `workflow-v2/kernel/${id}/second/output`;
      await db.blobStore.put(key, { value: "before" });
      await db.persistence.updateStage(stage.id, {
        outputData: { _artifactKey: key },
      });
      const kernel = db.makeKernel({
        services: { aiLogger: db.aiLogger },
        persistence: inTransaction(async (client) => {
          await client.workflowBlob.update({
            where: { key },
            data: { data: { value: "after" } },
          });
          await client.aICall.create({
            data: {
              topic: `workflow.${id}`,
              callType: "completion",
              modelKey: "test",
              modelId: "test",
              prompt: "prompt",
              response: "response",
              inputTokens: 5,
              outputTokens: 8,
              cost: 1.25,
            },
          });
        }),
      });
      await expect(
        kernel.dispatch({ type: "run.transition", workflowRunId: id }),
      ).resolves.toMatchObject({ action: "completed" });
      expect(await db.persistence.getRun(id)).toMatchObject({
        status: "COMPLETED",
        output: { value: "after" },
        totalCost: 1.25,
        totalTokens: 13,
      });
    },
  );
});
