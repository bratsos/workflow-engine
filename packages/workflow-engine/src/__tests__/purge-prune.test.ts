import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
import { defineAsyncBatchStage, defineStage } from "../core/stage-factory.js";
import { WorkflowBuilder } from "../core/workflow.js";
import { runBlobPrefixes } from "../kernel/handlers/run-purge.js";
import { SUPERSEDED_ATTEMPT_KEY } from "../kernel/handlers/run-redrive.js";
import { runMaintenanceTick } from "../kernel/helpers/host-support.js";
import { RUN_WRITE_LEASE_MS } from "../persistence/interface.js";
import {
  createPrismaBlobStore,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "../persistence/prisma/index.js";
import { writeRetentionSql } from "../persistence/prisma/retention-sql.js";
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
      sibling = fixture.openSqliteClient(db.file);
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
    const eligibility = await readFile(
      new URL(
        `../../sql/retention-eligibility.${dialect}.sql`,
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of eligibility.split("-- statement-breakpoint")) {
      await db.client.$executeRawUnsafe(statement.trim());
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

  /**
   * A worker whose stage pauses on `gate`, then records an AI call and saves
   * a blob. `late` writes again through the context the stage kept.
   */
  function pausingWorker(gate: ReturnType<typeof hold>) {
    const writes: { late?: () => Promise<void> } = {};
    const shape = z.object({ value: z.string() });
    const workflow = new WorkflowBuilder(
      db.workflow.id,
      "Example",
      "kernel",
      shape,
      shape,
    )
      .pipe(
        defineStage({
          id: "first",
          name: "First",
          schemas: { input: shape, output: shape, config: z.object({}) },
          async execute(ctx) {
            writes.late = async () => {
              await ctx.aiLogger.logCall({
                topic: "alternate-topic",
                modelKey: "model",
                modelId: "model",
                callType: "text",
                prompt: "",
                response: "",
                inputTokens: 1,
                outputTokens: 1,
                cost: 0,
              });
              await ctx.storage.save(ctx.storage.getStageKey("first", "late"), {
                saved: true,
              });
            };
            await gate.pause();
            ctx.ai.recordCall({
              modelKey: "gemini-2.5-flash",
              callType: "text",
              prompt: "",
              response: "",
              inputTokens: 1,
              outputTokens: 1,
            });
            await ctx.storage.save(ctx.storage.getStageKey("first", "extra"), {
              saved: true,
            });
            return { output: ctx.input };
          },
        }),
      )
      .build();
    const worker = db.makeKernel({
      registry: { getWorkflow: () => workflow },
      services: { aiLogger: db.aiLogger },
    });
    return {
      writes,
      execute: (workflowRunId: string) =>
        worker.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: workflow.id,
          stageId: "first",
          config: {},
        }),
    };
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
    const prefixes = runBlobPrefixes({
      id,
      workflowType: "kernel",
      stageRecordIds: [stage.id],
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
        annotations: 1,
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
        async deleteForPurge() {
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
            // Holds the erasing transaction open after the run row went.
            persistence: override(db.persistence, {
              withTransaction: (fn) =>
                db.persistence.withTransaction(async (tx) => {
                  const result = await fn(tx);
                  await gate.pause();
                  return result;
                }),
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
    let reopening: Promise<unknown> | undefined;
    try {
      reopening = redriver.dispatch({
        type: "run.redrive",
        workflowRunId: id,
        from: { kind: "start" },
      });
      if (winner === "redrive") await reopening;
    } finally {
      gate.release();
      await erasing;
    }
    if (winner === "purge") {
      await expect(reopening).rejects.toThrow();
      expect(await erasing).toMatchObject({
        removed: { runs: 1, aiCalls: 1, blobs: 1 },
        incomplete: [],
      });
      expect(await db.persistence.getRun(id)).toBeNull();
      expect(await db.client.workflowStage.count()).toBe(0);
      expect(await db.jobTransport.getJobsByWorkflowRun(id)).toEqual([]);
      return;
    }
    // The redrive committed first: the fenced delete rolled back and the
    // reopened run keeps its rows; external data already went.
    expect(await erasing).toMatchObject({
      removed: { runs: 0, stages: 0, aiCalls: 1, blobs: 1 },
      incomplete: [{ workflowRunId: id, failed: ["persistence"] }],
    });
    expect((await db.persistence.getRun(id))?.status).toBe("RUNNING");
    expect(await db.persistence.getStage(id, stage.stageId)).not.toBeNull();
    await kernel().dispatch({ type: "run.cancel", workflowRunId: id });
    expect(
      await kernel().dispatch({ type: "run.purge", workflowRunIds: [id] }),
    ).toMatchObject({ removed: { runs: 1 }, incomplete: [] });
    expect(await db.client.workflowStage.count()).toBe(0);
    expect(await db.client.jobQueue.count()).toBe(0);
  });

  it("erases a genuine archived spill and ignores caller-submitted ownership claims", async () => {
    const archived = await db.seed("COMPLETED", "COMPLETED");
    const other = await db.seed();
    const redriven = await db.seed("COMPLETED", "COMPLETED");
    const worker = kernel();
    for (const run of [archived, redriven]) {
      await worker.dispatch({
        type: "run.redrive",
        workflowRunId: run.id,
        from: { kind: "start" },
      });
    }
    await worker.dispatch({ type: "run.cancel", workflowRunId: archived.id });
    // Claims on another run's current record and on another run's archive.
    for (const claimed of [other.stage.id, redriven.stage.id]) {
      await worker.annotations.attach(archived.id, {
        scope: "stage",
        actor: { kind: "engine", id: "run.redrive" },
        attributes: { [SUPERSEDED_ATTEMPT_KEY]: "FAILED" },
        payload: { stageRecordId: claimed },
      });
    }
    const stale = `workflow-v2/spill/step-writes/${archived.stage.id}/step/value.json`;
    const foreign = [
      `workflow-v2/spill/steps/${other.stage.id}/step.json`,
      `workflow-v2/spill/step-writes/${redriven.stage.id}/step/value.json`,
    ];
    for (const key of [stale, ...foreign])
      await db.blobStore.put(key, { saved: true });
    expect(
      await worker.dispatch({
        type: "run.purge",
        workflowRunIds: [archived.id],
      }),
    ).toMatchObject({ removed: { runs: 1, blobs: 1 }, incomplete: [] });
    expect(await db.blobStore.has(stale)).toBe(false);
    for (const key of foreign) expect(await db.blobStore.has(key)).toBe(true);
  });

  it("erases the archived attempts of a run redriven before this release", async () => {
    const { id, stage } = await db.seed("COMPLETED", "COMPLETED");
    const worker = kernel();
    await worker.dispatch({
      type: "run.redrive",
      workflowRunId: id,
      from: { kind: "start" },
    });
    await worker.dispatch({ type: "run.cancel", workflowRunId: id });
    // What an earlier release left: unstamped keys and an archived record's
    // spilled step, found only through the redrive's archive annotation.
    await db.client.idempotencyKey.updateMany({
      data: { workflowRunId: null },
    });
    const archived = `workflow-v2/spill/step-writes/${stage.id}/step/value.json`;
    await db.blobStore.put(archived, { saved: true });
    expect(await db.persistence.getStage(id, stage.stageId)).not.toMatchObject({
      id: stage.id,
    });
    expect(
      await worker.dispatch({ type: "run.purge", workflowRunIds: [id] }),
    ).toMatchObject({ removed: { runs: 1 }, incomplete: [] });
    expect(await db.blobStore.has(archived)).toBe(false);
    expect(await db.client.workflowAnnotation.count()).toBe(0);
  });

  it("keeps cancelled stage writes discoverable until they drain", async () => {
    const { id } = await db.seed();
    const gate = hold();
    const worker = pausingWorker(gate);
    const executing = worker.execute(id);
    await gate.reached;
    const erase = { type: "run.purge", workflowRunIds: [id] } as const;
    try {
      await kernel().dispatch({ type: "run.cancel", workflowRunId: id });
      const result = await kernel().dispatch(erase);
      expect(result).toMatchObject({
        removed: { runs: 0 },
        incomplete: [{ workflowRunId: id, failed: ["writers"] }],
      });
    } finally {
      gate.release();
      await executing;
    }
    const result = await kernel().dispatch(erase);
    expect(result).toMatchObject({ removed: { runs: 1 }, incomplete: [] });
    // A context the stage kept writes nothing for the erased run.
    await worker.writes.late!();
    expect(await db.client.aICall.count()).toBe(0);
    expect(await db.client.workflowBlob.count()).toBe(0);
    expect(await db.client.idempotencyKey.count()).toBe(0);
  });

  it.each([
    "run.redrive",
    "run.rerunFrom",
  ] as const)("erases an in-progress key when %s completion is delayed", async (type) => {
    const { id } = await db.seed("COMPLETED", "COMPLETED");
    const gate = hold();
    const other = createPrismaWorkflowPersistence(sibling, {
      databaseType: sqlite ? "sqlite" : "postgresql",
    });
    const worker = db.makeKernel({
      persistence: override(other, {
        async completeIdempotencyKey(...args) {
          await gate.pause();
          await other.completeIdempotencyKey(...args);
        },
      }),
    });
    const key = "reopening";
    const reopening = worker.dispatch(
      type === "run.redrive"
        ? {
            type,
            workflowRunId: id,
            from: { kind: "start" },
            idempotencyKey: key,
          }
        : {
            type,
            workflowRunId: id,
            fromStageId: "first",
            idempotencyKey: key,
          },
    );
    await gate.reached;
    try {
      await kernel().dispatch({ type: "run.cancel", workflowRunId: id });
      expect(
        await kernel().dispatch({ type: "run.purge", workflowRunIds: [id] }),
      ).toMatchObject({
        removed: { runs: 1, idempotencyKeys: 1 },
        incomplete: [],
      });
    } finally {
      gate.release();
      await reopening;
    }
    expect(await db.client.idempotencyKey.count()).toBe(0);
  });

  it("recovers legacy key attribution after a process exits during external cleanup", async () => {
    const { id, jobId } = await db.seed("COMPLETED", "COMPLETED");
    await db.client.idempotencyKey.create({
      data: {
        key: `job:${jobId}:attempt:1`,
        commandType: "job.execute",
        result: {},
      },
    });
    const child = fileURLToPath(
      new URL("./fixtures/purge-exit-child.ts", import.meta.url),
    );
    const loader = createRequire(import.meta.url).resolve("tsx");
    await expect(
      promisify(execFile)(
        process.execPath,
        ["--import", loader, child, id, db.file ?? ""],
        { timeout: 25_000 },
      ),
    ).rejects.toMatchObject({ code: 77 });
    // The key named only the job, so it went before the job did.
    expect(await db.client.jobQueue.count()).toBe(0);
    expect(await db.client.idempotencyKey.count()).toBe(0);
    expect(
      await kernel().dispatch({ type: "run.purge", workflowRunIds: [id] }),
    ).toMatchObject({ removed: { runs: 1 }, incomplete: [] });
    expect(await db.client.workflowRun.count()).toBe(0);
  }, 30_000);

  it("keeps a written run from the age sweep and erases what the sweep leaves", async () => {
    const { id } = await db.seed();
    const gate = hold();
    const worker = pausingWorker(gate);
    const executing = worker.execute(id);
    await gate.reached;
    const sweep = {
      type: "run.purge",
      olderThan: new Date("2090-01-01T00:00:00Z"),
    } as const;
    const erase = { type: "run.purge", workflowRunIds: [id] } as const;
    try {
      await kernel().dispatch({ type: "run.cancel", workflowRunId: id });
      expect(await kernel().dispatch(sweep)).toMatchObject({ purged: 0 });
      expect(await kernel().dispatch(erase)).toMatchObject({
        incomplete: [{ workflowRunId: id, failed: ["writers"] }],
      });
    } finally {
      gate.release();
      await executing;
    }
    await db.client.idempotencyKey.create({
      data: {
        key: "k",
        commandType: "run.create",
        workflowRunId: id,
        result: {},
      },
    });
    expect(await kernel().dispatch(sweep)).toMatchObject({ purged: 1 });
    // Age retention keeps AI calls, events and keys; erasure by id finds them.
    expect(await db.client.aICall.count()).toBe(1);
    const outboxEvents = await db.client.outboxEvent.count();
    expect(outboxEvents).toBeGreaterThan(0);
    expect(await kernel().dispatch(erase)).toEqual({
      removed: expect.objectContaining({
        runs: 0,
        aiCalls: 1,
        outboxEvents,
        idempotencyKeys: 1,
      }),
      skipped: [],
      incomplete: [],
    });
    expect(await db.client.aICall.count()).toBe(0);
    expect(await db.client.outboxEvent.count()).toBe(0);
    expect(await db.client.idempotencyKey.count()).toBe(0);
  });

  it("stops counting a writer that stopped refreshing, and fences its late writes", async () => {
    const { id } = await db.seed();
    const gate = hold();
    const worker = pausingWorker(gate);
    const executing = worker.execute(id).catch(() => {});
    await gate.reached;
    const erase = { type: "run.purge", workflowRunIds: [id] } as const;
    try {
      await kernel().dispatch({ type: "run.cancel", workflowRunId: id });
      expect(await kernel().dispatch(erase)).toMatchObject({
        incomplete: [{ workflowRunId: id, failed: ["writers"] }],
      });
      // The worker's refreshes stop (a crash, or a stall): once the lease
      // lapses, its registration no longer holds erasure back.
      vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
      vi.setSystemTime(Date.now() + RUN_WRITE_LEASE_MS + 1000);
      expect(await kernel().dispatch(erase)).toMatchObject({
        removed: { runs: 1 },
        incomplete: [],
      });
      // A stalled worker that resumes checks its registration first.
      gate.release();
      await executing;
    } finally {
      gate.release();
      await executing;
      vi.useRealTimers();
    }
    expect(await db.client.aICall.count()).toBe(0);
    expect(await db.client.workflowBlob.count()).toBe(0);
    expect(await db.client.idempotencyKey.count()).toBe(0);
  });

  it.each([
    "fails",
    "completes",
  ] as const)("leaves a key acquired after an erasure to its command when a delayed one %s", async (outcome) => {
    const first = await db.seed("COMPLETED", "COMPLETED");
    const second = await db.seed("COMPLETED", "COMPLETED");
    const gate = hold();
    const other = createPrismaWorkflowPersistence(sibling, {
      databaseType: sqlite ? "sqlite" : "postgresql",
    });
    const delayed = db.makeKernel({
      persistence: override(other, {
        async completeIdempotencyKey(...args) {
          await gate.pause();
          if (outcome === "fails") throw new Error("store unavailable");
          await other.completeIdempotencyKey(...args);
        },
      }),
    });
    const redrive = (workflowRunId: string) =>
      ({
        type: "run.redrive",
        workflowRunId,
        from: { kind: "start" },
        idempotencyKey: "reopen",
      }) as const;
    const reopening = delayed.dispatch(redrive(first.id));
    await gate.reached;
    try {
      await kernel().dispatch({ type: "run.cancel", workflowRunId: first.id });
      expect(
        await kernel().dispatch({
          type: "run.purge",
          workflowRunIds: [first.id],
        }),
      ).toMatchObject({ removed: { runs: 1, idempotencyKeys: 1 } });
      await kernel().dispatch(redrive(second.id));
    } finally {
      gate.release();
      await reopening.catch(() => {});
    }
    // The key now answers for the second run's command only.
    expect(await db.client.idempotencyKey.findMany()).toEqual([
      expect.objectContaining({
        key: "reopen",
        workflowRunId: second.id,
        result: expect.objectContaining({ workflowRunId: second.id }),
      }),
    ]);
  });

  it("keeps a cancelled run from erasure until its batch sweep ends", async () => {
    const { id, stage } = await db.seed("RUNNING", "SUSPENDED");
    const ref = {
      version: 1,
      type: "text",
      id: "batch-1",
      provider: "fake",
      modelId: "model",
    } as const;
    await db.persistence.updateStage(stage.id, {
      suspendedState: { batchId: id, metadata: { batchRefs: [ref] } },
    });
    const cancelled: string[] = [];
    const model = {
      provider: "fake",
      modelId: "model",
      start: async () => {
        throw new Error("not used");
      },
      status: async () => ({ status: "processing" as const }),
      cancel: async (batch: { id: string }) => {
        cancelled.push(batch.id);
        return { outcome: "cancelled" as const, rawStatus: "cancelling" };
      },
      results: async function* () {},
    };
    const gate = hold();
    let paused = false;
    const canceller = db.makeKernel({
      services: { batchModels: () => model as any },
      persistence: override(db.persistence, {
        async getStagesByRun(...args) {
          // The sweep's first read, after the cancel committed.
          if (!paused) {
            paused = true;
            await gate.pause();
          }
          return db.persistence.getStagesByRun(...args);
        },
      }),
    });
    const cancelling = canceller.dispatch({
      type: "run.cancel",
      workflowRunId: id,
    });
    await gate.reached;
    const erase = { type: "run.purge", workflowRunIds: [id] } as const;
    try {
      expect((await db.persistence.getRun(id))?.status).toBe("CANCELLED");
      expect(await kernel().dispatch(erase)).toMatchObject({
        removed: { runs: 0, blobs: 0 },
        incomplete: [{ workflowRunId: id, failed: ["writers"] }],
      });
    } finally {
      gate.release();
      await cancelling;
    }
    expect(cancelled).toEqual(["batch-1"]);
    expect(await kernel().dispatch(erase)).toMatchObject({
      removed: { runs: 1 },
      incomplete: [],
    });
  });

  it("answers commands for an erased run as before erasure existed", async () => {
    const { id } = await db.seed("COMPLETED", "COMPLETED");
    const worker = kernel();
    await worker.dispatch({ type: "run.purge", workflowRunIds: [id] });
    await expect(
      worker.dispatch({
        type: "step.signal",
        workflowRunId: id,
        stageId: "first",
        stepId: "approval",
        payload: {},
      }),
    ).rejects.toThrow("not found");
    await expect(
      worker.annotations.attach(id, { attributes: { "test.key": "late" } }),
    ).rejects.toThrow();
    expect(await db.client.workflowAnnotation.count()).toBe(0);
    expect(await db.client.idempotencyKey.count()).toBe(0);
  });

  it("keeps a poll from writing for a run erased while it checked", async () => {
    const { id } = await db.seed("RUNNING", "SUSPENDED");
    const gate = hold();
    const shape = z.object({ value: z.string() });
    const workflow = new WorkflowBuilder(
      db.workflow.id,
      "Example",
      "kernel",
      shape,
      shape,
    )
      .pipe(
        defineAsyncBatchStage({
          id: "first",
          name: "First",
          mode: "async-batch",
          schemas: { input: shape, output: shape, config: z.object({}) },
          async execute(ctx) {
            return { output: ctx.input };
          },
          async checkCompletion(_state, ctx) {
            await gate.pause();
            await ctx.storage.save(ctx.storage.getStageKey("first", "late"), {
              saved: true,
            });
            return { ready: true, output: { value: "polled" } };
          },
        }),
      )
      .build();
    const polling = db
      .makeKernel({ registry: { getWorkflow: () => workflow } })
      .dispatch({ type: "stage.pollSuspended" });
    await gate.reached;
    try {
      await kernel().dispatch({ type: "run.cancel", workflowRunId: id });
      expect(
        await kernel().dispatch({ type: "run.purge", workflowRunIds: [id] }),
      ).toMatchObject({ removed: { runs: 1 }, incomplete: [] });
    } finally {
      gate.release();
      await polling;
    }
    expect(await db.client.workflowBlob.count()).toBe(0);
    expect(await db.client.workflowRun.count()).toBe(0);
  });

  it("counts a shared blob once when two kernels listed it before deleting", async () => {
    const { id, stage } = await db.seed("COMPLETED", "COMPLETED");
    const ledger = createPrismaStepLedger(sibling, {
      databaseType: sqlite ? "sqlite" : "postgresql",
    });
    await ledger.claim({
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
    const key = `workflow-v2/kernel/${id}/first/shared`;
    await db.blobStore.put(key, { saved: true });
    const first = hold(),
      second = hold();
    const blobStore = (gate: ReturnType<typeof hold>) =>
      override(db.blobStore, {
        async list(prefix) {
          const keys = await db.blobStore.list(prefix);
          if (keys.includes(key)) await gate.pause();
          return keys;
        },
      });
    const erase = { type: "run.purge", workflowRunIds: [id] } as const;
    const oldLedger = db.makeKernel({
      stepLedger: override(ledger, { deleteForPurge: undefined }),
      services: { aiLogger: db.aiLogger },
    });
    await expect(oldLedger.dispatch(erase)).rejects.toThrow(
      "atomic blob and ledger delete counts",
    );
    expect(await ledger.list(stage.id)).toHaveLength(1);
    const erasing = [first, second].map((gate) =>
      db
        .makeKernel({
          blobStore: blobStore(gate),
          stepLedger: ledger,
          services: { aiLogger: db.aiLogger },
        })
        .dispatch(erase),
    );
    await Promise.all([first.reached, second.reached]);
    first.release();
    second.release();
    const results = await Promise.all(erasing);
    expect(
      results.reduce((total, result) => total + result.removed.blobs, 0),
    ).toBe(1);
    expect(
      results.reduce((total, result) => total + result.removed.steps, 0),
    ).toBe(1);
    expect(await db.client.workflowBlob.count()).toBe(0);
  });

  it("selects an eligible event and key behind an old ineligible backlog", async () => {
    const live = await db.seed();
    const terminal = await db.seed("COMPLETED", "COMPLETED");
    const dialect = sqlite ? "sqlite" : "postgresql";
    const numbers = sqlite
      ? "(WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 10000) SELECT n FROM numbers)"
      : "generate_series(1,10000) AS numbers(n)";
    const oldDate = sqlite ? "$2" : "$2::timestamp";
    await writeRetentionSql(
      db.client,
      dialect,
      `INSERT INTO "outbox_events" ("id","workflowRunId","sequence","eventType","payload","causationId","occurredAt","publishedAt")
        SELECT 'live-' || n, $1, n, 'test', '{}', 'test', ${oldDate}, ${oldDate} FROM ${numbers}`,
      [live.id, sqlite ? old : old.toISOString()],
    );
    await writeRetentionSql(
      db.client,
      dialect,
      `INSERT INTO "idempotency_keys" ("id","key","commandType","createdAt","result")
        SELECT 'busy-' || n, 'busy-' || n, 'job.execute', ${sqlite ? "$1" : "$1::timestamp"}, '{"__workflowEngineState":"in_progress"}'
        FROM ${numbers}`,
      [sqlite ? old : old.toISOString()],
    );
    const later = new Date("2020-08-01T00:00:00Z");
    await db.client.outboxEvent.create({
      data: {
        id: "eligible",
        workflowRunId: terminal.id,
        sequence: 1,
        eventType: "test",
        payload: {},
        causationId: "test",
        occurredAt: later,
        publishedAt: later,
      },
    });
    await db.client.idempotencyKey.create({
      data: {
        key: "eligible",
        commandType: "job.execute",
        result: {},
        createdAt: later,
      },
    });
    const command = {
      type: "engine.prune",
      limit: 1,
      outbox: { publishedOlderThan: cutoff },
      idempotencyKeys: { olderThan: cutoff },
    } as const;
    expect(await kernel().dispatch(command)).toMatchObject({
      outbox: 1,
      idempotencyKeys: 1,
    });
    expect(await kernel().dispatch(command)).toMatchObject({
      outbox: 0,
      idempotencyKeys: 0,
    });
    expect(await db.client.outboxEvent.count()).toBe(10000);
    expect(await db.client.idempotencyKey.count()).toBe(10000);
  });

  it("updates outbox eligibility when a run reopens and ends again", async () => {
    const { id } = await db.seed("COMPLETED", "COMPLETED");
    await db.client.outboxEvent.create({
      data: {
        id: "published",
        workflowRunId: id,
        sequence: 1,
        eventType: "test",
        payload: {},
        causationId: "test",
        occurredAt: old,
        publishedAt: old,
      },
    });
    const worker = kernel();
    const prune = {
      type: "engine.prune",
      outbox: { publishedOlderThan: cutoff },
    } as const;
    await worker.dispatch({
      type: "run.redrive",
      workflowRunId: id,
      from: { kind: "start" },
    });
    expect(await worker.dispatch(prune)).toMatchObject({ outbox: 0 });
    await worker.dispatch({ type: "run.cancel", workflowRunId: id });
    expect(await worker.dispatch(prune)).toMatchObject({ outbox: 1 });
    expect(
      await db.client.outboxEvent.findUnique({ where: { id: "published" } }),
    ).toBeNull();
    const { published } = await worker.dispatch({ type: "outbox.flush" });
    expect(published).toBeGreaterThan(0);
    expect(
      await worker.dispatch({
        ...prune,
        outbox: { publishedOlderThan: new Date("2090-01-01T00:00:00Z") },
      }),
    ).toMatchObject({ outbox: published });
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
