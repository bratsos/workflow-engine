import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../core/stage-factory.js";
import { WorkflowBuilder } from "../core/workflow.js";
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
            blobStore: override(db.blobStore, {
              async deleteForPurge(key) {
                await gate.pause();
                return db.blobStore.deleteForPurge!(key);
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

  it("erases a genuine archived spill and ignores caller-submitted ownership claims", async () => {
    const archived = await db.seed("COMPLETED", "COMPLETED");
    const other = await db.seed();
    const worker = kernel();
    await worker.dispatch({
      type: "run.redrive",
      workflowRunId: archived.id,
      from: { kind: "start" },
    });
    await worker.dispatch({ type: "run.cancel", workflowRunId: archived.id });
    await worker.annotations.attach(archived.id, {
      scope: "stage",
      actor: { kind: "engine", id: "run.redrive" },
      attributes: { [SUPERSEDED_ATTEMPT_KEY]: "FAILED" },
      payload: { stageRecordId: other.stage.id },
    });
    const stale = `workflow-v2/spill/step-writes/${archived.stage.id}/step/value.json`;
    const foreign = `workflow-v2/spill/steps/${other.stage.id}/step.json`;
    await db.blobStore.put(stale, { saved: true });
    await db.blobStore.put(foreign, { saved: true });
    expect(
      await worker.dispatch({
        type: "run.purge",
        workflowRunIds: [archived.id],
      }),
    ).toMatchObject({ removed: { runs: 1, blobs: 1 }, incomplete: [] });
    expect(await db.blobStore.has(stale)).toBe(false);
    expect(await db.blobStore.has(foreign)).toBe(true);
  });

  it("keeps a legacy redrive discoverable when archived ownership is unavailable", async () => {
    const { id } = await db.seed("COMPLETED", "COMPLETED");
    const worker = kernel();
    await worker.dispatch({
      type: "run.redrive",
      workflowRunId: id,
      from: { kind: "start" },
    });
    await worker.dispatch({ type: "run.cancel", workflowRunId: id });
    await writeRetentionSql(
      db.client,
      sqlite ? "sqlite" : "postgresql",
      `UPDATE "workflow_runs" SET "archivedStageRecordIds" = NULL WHERE "id" = $1`,
      [id],
    );
    expect(
      await worker.dispatch({ type: "run.purge", workflowRunIds: [id] }),
    ).toMatchObject({
      removed: { runs: 0 },
      incomplete: [{ workflowRunId: id, failed: ["archive"] }],
    });
    expect(await db.persistence.getRun(id)).not.toBeNull();
  });

  it("keeps cancelled stage writes discoverable until they drain", async () => {
    const { id } = await db.seed();
    const gate = hold();
    let lateWrite!: () => Promise<void>;
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
            lateWrite = async () => {
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
    const executing = worker.dispatch({
      type: "job.execute",
      workflowRunId: id,
      workflowId: workflow.id,
      stageId: "first",
      config: {},
    });
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
    await lateWrite();
    expect(await db.client.aICall.count()).toBe(0);
    expect(await db.client.workflowBlob.count()).toBe(0);
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
    expect(await db.client.jobQueue.count()).toBe(0);
    expect(await db.client.idempotencyKey.count()).toBe(2);
    expect(
      await kernel().dispatch({ type: "run.purge", workflowRunIds: [id] }),
    ).toMatchObject({
      removed: { runs: 1, idempotencyKeys: 1 },
      incomplete: [],
    });
    expect(await db.client.idempotencyKey.count()).toBe(0);
  }, 30_000);

  it("keeps targeted cleanup discoverable when an age sweep tries a late delete", async () => {
    const { id } = await db.seed("COMPLETED", "COMPLETED");
    await seedCall("attributed", { workflowRunId: id });
    const ageDelete = hold();
    const targetedList = hold();
    const other = createPrismaWorkflowPersistence(sibling, {
      databaseType: sqlite ? "sqlite" : "postgresql",
    });
    const age = db.makeKernel({
      persistence: override(other, {
        async deleteRun(...args) {
          await ageDelete.pause();
          return other.deleteRun(...args);
        },
      }),
    });
    const aging = age.dispatch({ type: "run.purge", olderThan: cutoff });
    await ageDelete.reached;
    const erasing = db
      .makeKernel({
        services: { aiLogger: db.aiLogger },
        blobStore: override(db.blobStore, {
          async list() {
            await targetedList.pause();
            throw new Error("storage unavailable");
          },
        }),
      })
      .dispatch({ type: "run.purge", workflowRunIds: [id] });
    await targetedList.reached;
    const redrive = {
      type: "run.redrive",
      workflowRunId: id,
      from: { kind: "start" },
      idempotencyKey: "reopen-reserved",
    } as const;
    try {
      await expect(kernel().dispatch(redrive)).rejects.toMatchObject({
        code: "RUN_PURGE_IN_PROGRESS",
      });
      ageDelete.release();
      expect(await aging).toMatchObject({ purged: 0 });
    } finally {
      ageDelete.release();
      targetedList.release();
      await Promise.all([aging, erasing]);
    }
    expect(
      await kernel().dispatch({ type: "run.purge", workflowRunIds: [id] }),
    ).toMatchObject({ removed: { runs: 1, aiCalls: 1 }, incomplete: [] });
    await expect(kernel().dispatch(redrive)).rejects.toThrow("not found");
    expect(await db.client.idempotencyKey.count()).toBe(0);
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
