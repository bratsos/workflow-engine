import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runBlobPrefixes } from "../kernel/handlers/run-purge.js";
import { SUPERSEDED_ATTEMPT_KEY } from "../kernel/handlers/run-redrive.js";
import { runMaintenanceTick } from "../kernel/helpers/host-support.js";
import {
  createPrismaBlobStore,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "../persistence/prisma/index.js";
import {
  type KernelDatabase,
  kernelDatabase,
  override,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";
import { createPostgresClient } from "./utils/postgres-client.js";

const old = new Date("2020-01-01T00:00:00.000Z");
const cutoff = new Date("2021-01-01T00:00:00.000Z");

function hold() {
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    async pause() {
      arrived();
      await resume;
    },
  };
}

describe.skipIf(!realDatabase)("run erasure and retention", () => {
  let db: KernelDatabase;
  let sibling: any;
  beforeAll(async () => {
    db = await kernelDatabase();
    const fixture = createRequire(import.meta.url)(
      "../../../prisma-fixtures/index.cjs",
    );
    if (sqlite && process.env.PRISMA_MAJOR === "8") {
      const native = await fixture.openSqliteDb(db.file);
      sibling = Object.assign(fromPrisma8(native), {
        $disconnect: () => native.close(),
      });
    } else if (sqlite) {
      sibling = fixture.createSqliteClient(db.file);
    } else {
      sibling = createPostgresClient(process.env.DATABASE_URL!);
    }
    const dialect = sqlite ? "sqlite" : "postgresql";
    const ddl = await readFile(
      new URL(`../../sql/retention-indexes.${dialect}.sql`, import.meta.url),
      "utf8",
    );
    // The fixture owns this database. Production installations add these
    // expression indexes in the same migration as the attribution columns.
    for (const statement of ddl.split(";").filter((sql) => sql.trim())) {
      await db.client.$executeRawUnsafe(statement);
    }
  });
  beforeEach(() => db.reset());
  afterAll(async () => {
    try {
      await sibling?.$disconnect();
    } finally {
      await db?.close();
    }
  });

  const kernel = () => db.makeKernel({ services: { aiLogger: db.aiLogger } });

  async function seedCall(id: string, data = {}) {
    await db.client.aICall.create({
      data: {
        id,
        topic: "test",
        callType: "generateText",
        modelKey: "model",
        modelId: "model",
        prompt: "input",
        response: "output",
        inputTokens: 1,
        outputTokens: 1,
        cost: 0,
        ...data,
      },
    });
  }

  it("fails closed without an AI deletion port", async () => {
    const { id } = await db.seed("COMPLETED", "COMPLETED");
    await expect(
      db.kernel.dispatch({ type: "run.purge", workflowRunIds: [id] }),
    ).rejects.toMatchObject({ name: "AICallDeletionUnavailableError" });
    expect(await db.persistence.getRun(id)).not.toBeNull();
  });

  it.each([
    "ids",
    "tenant",
  ] as const)("deletes all attributed and legacy data by %s and skips live runs", async (by) => {
    const { id, stage, jobId } = await db.seed("COMPLETED", "COMPLETED");
    const live = await db.seed();
    await db.client.workflowRun.updateMany({
      where: { id: { in: [id, live.id] } },
      data: { tenantId: "tenant-a" },
    });
    await db.stepLedger.claim({
      stageRecordId: stage.id,
      stepId: "step",
      kind: "run",
      seq: 1,
      status: "completed",
      attempt: 1,
      leaseExpiresAt: null,
      deadlineAt: null,
      result: {},
    });
    await db.persistence.createLog({
      workflowRunId: id,
      workflowStageId: stage.id,
      level: "INFO",
      message: "saved",
    });
    await db.persistence.createLog({
      workflowStageId: stage.id,
      level: "INFO",
      message: "stage log",
    });
    await db.client.workflowArtifact.create({
      data: {
        workflowRunId: id,
        workflowStageId: stage.id,
        key: "receipt",
        type: "ARTIFACT",
        data: {},
        size: 1,
      },
    });
    await kernel().annotations.attach(id, {
      attributes: { "test.key": "saved" },
    });
    await db.persistence.appendOutboxEvents([
      {
        workflowRunId: id,
        eventType: "test",
        payload: {},
        causationId: "test",
        occurredAt: old,
      },
    ]);
    await db.persistence.appendAnnotations([
      {
        workflowRunId: id,
        key: SUPERSEDED_ATTEMPT_KEY,
        scope: "stage",
        actor: { kind: "engine", id: "run.redrive" },
        value: "FAILED",
        payload: { stageRecordId: "stage-archived" },
      },
    ]);
    const prefixes = runBlobPrefixes({
      id,
      workflowType: "kernel",
      stageRecordIds: [stage.id, "stage-archived"],
    });
    for (const prefix of prefixes)
      await db.blobStore.put(prefix + "data", { saved: true });
    await seedCall("attributed", { workflowRunId: id });
    await seedCall("legacy", { topic: `workflow.${id}.stage` });
    await seedCall("other", { topic: `workflow.${id}-other.stage` });
    await db.client.idempotencyKey.createMany({
      data: [
        {
          key: "stamped",
          commandType: "run.create",
          workflowRunId: id,
          result: {},
        },
        {
          key: "legacy",
          commandType: "run.create",
          result: { workflowRunId: id },
        },
        {
          key: `job:${jobId}:attempt:1`,
          commandType: "job.execute",
          result: {},
        },
        {
          key: JSON.stringify([stage.id, "signal"]),
          commandType: "step.signal.wake",
          result: {},
        },
      ],
    });
    const result = await kernel().dispatch(
      by === "ids"
        ? { type: "run.purge", workflowRunIds: [id, live.id, id] }
        : { type: "run.purge", tenantId: "tenant-a", limit: 2 },
    );
    expect(result).toEqual({
      removed: {
        runs: 1,
        stages: 1,
        steps: 1,
        jobs: 1,
        logs: 2,
        artifacts: 1,
        annotations: 2,
        outboxEvents: 1,
        idempotencyKeys: 4,
        aiCalls: 2,
        blobs: prefixes.length,
      },
      skipped: [{ workflowRunId: live.id, status: "RUNNING" }],
      incomplete: [],
    });
    expect(await db.client.idempotencyKey.count()).toBe(0);
    expect(await db.client.aICall.count()).toBe(1);
    expect(await db.client.workflowBlob.count()).toBe(0);
    for (const model of ["workflowRun", "workflowStage", "jobQueue"]) {
      expect(await db.client[model].count()).toBe(1);
    }
    for (const model of [
      "workflowStep",
      "workflowLog",
      "workflowArtifact",
      "workflowAnnotation",
      "outboxEvent",
    ]) {
      expect(await db.client[model].count()).toBe(0);
    }
  });

  it("keeps a run discoverable after a blob failure and resumes by tenant", async () => {
    const { id } = await db.seed("COMPLETED", "COMPLETED");
    await db.client.workflowRun.update({
      where: { id },
      data: { tenantId: "tenant-a" },
    });
    const key = `workflow-v2/kernel/${id}/receipt`;
    await db.blobStore.put(key, { saved: true });
    await seedCall("attributed", { workflowRunId: id });
    const failing = db.makeKernel({
      services: { aiLogger: db.aiLogger },
      blobStore: override(db.blobStore, {
        async delete() {
          throw new Error("storage failure");
        },
      }),
    });
    const command = { type: "run.purge", tenantId: "tenant-a" } as const;
    expect((await failing.dispatch(command)).incomplete).toEqual([
      { workflowRunId: id, failed: ["blobs"] },
    ]);
    expect(await db.persistence.getRun(id)).not.toBeNull();
    expect(await db.client.jobQueue.count()).toBe(1);
    expect(await db.client.aICall.count()).toBe(1);
    expect((await kernel().dispatch(command)).removed).toMatchObject({
      runs: 1,
      aiCalls: 1,
      blobs: 1,
    });
    expect(await db.persistence.getRun(id)).toBeNull();
  });

  it.each([
    "purge",
    "redrive",
  ] as const)("keeps the winner of concurrent %s on separate connections intact", async (winner) => {
    const { id, stage } = await db.seed("COMPLETED", "COMPLETED");
    const blob = `workflow-v2/kernel/${id}/receipt`;
    await db.blobStore.put(blob, { saved: true });
    await seedCall("attributed", { workflowRunId: id });
    const direction = {
      databaseType: sqlite ? ("sqlite" as const) : ("postgresql" as const),
    };
    const redriver = db.makeKernel({
      persistence: createPrismaWorkflowPersistence(sibling, direction),
      jobTransport: createPrismaJobQueue(sibling, direction),
      stepLedger: createPrismaStepLedger(sibling, direction),
      blobStore: createPrismaBlobStore(sibling, direction),
    });
    const gate = hold();
    const purger = db.makeKernel({
      services: { aiLogger: db.aiLogger },
      ...(winner === "purge"
        ? {
            blobStore: override(db.blobStore, {
              async delete(key) {
                await gate.pause();
                await db.blobStore.delete(key);
              },
            }),
          }
        : {
            jobTransport: override(db.jobTransport, {
              async getJobsForPurge(runId) {
                const jobs = await db.jobTransport.getJobsForPurge!(runId);
                await gate.pause();
                return jobs;
              },
            }),
          }),
    });
    const erasing = purger.dispatch({
      type: "run.purge",
      workflowRunIds: [id],
    });
    await gate.reached;
    try {
      const reopening = redriver.dispatch({
        type: "run.redrive",
        workflowRunId: id,
        from: { kind: "start" },
      });
      if (winner === "purge") {
        await expect(reopening).rejects.toMatchObject({
          name: "RunPurgeInProgressError",
        });
        expect(await db.persistence.getStage(id, stage.stageId)).not.toBeNull();
      } else {
        await reopening;
      }
    } finally {
      gate.release();
      await erasing;
    }
    if (winner === "purge") {
      expect(await erasing).toMatchObject({
        removed: { runs: 1, aiCalls: 1, blobs: 1 },
        incomplete: [],
      });
      expect(await db.persistence.getRun(id)).toBeNull();
      expect(await db.jobTransport.getJobsByWorkflowRun(id)).toEqual([]);
    } else {
      expect(await erasing).toMatchObject({
        removed: { runs: 0, aiCalls: 0, blobs: 0 },
        incomplete: [{ workflowRunId: id, failed: ["persistence"] }],
      });
      expect((await db.persistence.getRun(id))?.status).toBe("RUNNING");
      expect(await db.jobTransport.getJobsByWorkflowRun(id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "PENDING", stageId: "first" }),
        ]),
      );
    }
    expect(await db.blobStore.has(blob)).toBe(winner === "redrive");
    expect(await db.client.aICall.count()).toBe(winner === "redrive" ? 1 : 0);
  });

  it("runs pruning only on configured maintenance ticks", async () => {
    await seedCall("old", { createdAt: old });
    expect((await runMaintenanceTick(kernel())).pruned).toBeUndefined();
    expect(await db.client.aICall.count()).toBe(1);
    expect(
      (
        await runMaintenanceTick(kernel(), {
          prune: { aiCalls: { olderThanMs: 1000 } },
        })
      ).pruned,
    ).toEqual({ aiCalls: 1, aiCallText: 0, outbox: 0, idempotencyKeys: 0 });
  });

  it("bounds every prune clause and keeps live, dead-lettered and unpublished events", async () => {
    const live = await db.seed();
    const terminal = await db.seed("COMPLETED", "COMPLETED");
    for (const id of ["1", "2"]) {
      await seedCall(`old-${id}`, { createdAt: old });
      await seedCall(`text-${id}`, {
        textExpiresAt: cutoff,
        metadata: { instructions: "instruction", source: "test" },
      });
      await db.client.idempotencyKey.create({
        data: {
          key: id,
          commandType: "job.execute",
          result: {},
          createdAt: old,
        },
      });
    }
    await db.client.idempotencyKey.create({
      data: {
        key: "busy",
        commandType: "job.execute",
        createdAt: old,
        result: { __workflowEngineState: "in_progress" },
      },
    });
    const event = {
      eventType: "test",
      payload: {},
      causationId: "test",
      occurredAt: old,
    };
    await db.client.outboxEvent.createMany({
      data: [
        {
          ...event,
          id: "a",
          workflowRunId: terminal.id,
          sequence: 1,
          publishedAt: old,
        },
        {
          ...event,
          id: "b",
          workflowRunId: terminal.id,
          sequence: 2,
          publishedAt: old,
        },
        {
          ...event,
          id: "live",
          workflowRunId: live.id,
          sequence: 1,
          publishedAt: old,
        },
        { ...event, id: "pending", workflowRunId: terminal.id, sequence: 3 },
        {
          ...event,
          id: "dlq",
          workflowRunId: terminal.id,
          sequence: 4,
          publishedAt: old,
          dlqAt: old,
        },
      ],
    });
    const command = {
      type: "engine.prune",
      limit: 1,
      aiCalls: { olderThan: cutoff },
      aiCallText: { now: cutoff },
      outbox: { publishedOlderThan: cutoff },
      idempotencyKeys: { olderThan: cutoff },
    } as const;
    const counts = { aiCalls: 1, aiCallText: 1, outbox: 1, idempotencyKeys: 1 };
    expect(await kernel().dispatch(command)).toEqual(counts);
    expect(await kernel().dispatch(command)).toEqual(counts);
    expect(await kernel().dispatch(command)).toEqual({
      aiCalls: 0,
      aiCallText: 0,
      outbox: 0,
      idempotencyKeys: 0,
    });
    expect(await db.client.aICall.findMany()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "text-1",
          prompt: "",
          response: "",
          textExpiresAt: null,
          metadata: { source: "test" },
        }),
      ]),
    );
    expect(
      (await db.client.outboxEvent.findMany({ orderBy: { id: "asc" } })).map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual(["dlq", "live", "pending"]);
    expect(await db.client.idempotencyKey.count()).toBe(1);
  });
});
