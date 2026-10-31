import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BlobStore, Persistence, StepLedger } from "../../kernel/ports.js";
import {
  createPayloadSpill,
  isSpillRef,
  withStepResultSpill,
} from "../../kernel/spill.js";
import {
  fromPrisma8,
  PrismaAICallLogger,
  PrismaBlobStore,
  PrismaJobQueue,
  PrismaStepLedger,
  PrismaWorkflowPersistence,
} from "../../persistence/prisma/index.js";

const major = process.env.PRISMA_MAJOR ?? "7";
const fixtures = createRequire(import.meta.url)(
  "../../../../prisma-fixtures/index.cjs",
);
const result = { message: "a spilled result".repeat(50) };

function ports(client: any, databaseType: "sqlite" | "postgresql") {
  const options = { databaseType };
  return {
    queue: new PrismaJobQueue(client, {
      ...options,
      workerId: "reads-worker",
      now: () => new Date("2026-01-01T00:00:00Z"),
    }),
    ledger: new PrismaStepLedger(client, options),
    blob: new PrismaBlobStore(client),
    logger: new PrismaAICallLogger(client, options),
  };
}

type Ports = ReturnType<typeof ports>;
function reads(configured: Ports, persistence: Persistence) {
  return {
    queue: configured.queue.transactionReads(persistence)!,
    ledger: configured.ledger.transactionReads(persistence)!,
    blob: configured.blob.transactionReads(persistence)!,
    logger: configured.logger.transactionReads(persistence)!,
  };
}

async function seed(
  persistence: Persistence,
  configured: Ports,
  transactionClient?: any,
) {
  const run = await persistence.createRun({
    workflowId: "reads",
    workflowName: "reads",
    workflowType: "reads",
    input: {},
  });
  const stage = await persistence.createStage({
    workflowRunId: run.id,
    stageId: "stage",
    stageName: "stage",
    stageNumber: 1,
    executionGroup: 0,
  });
  if (transactionClient) {
    await transactionClient.jobQueue.create({
      data: {
        workflowRunId: run.id,
        stageId: "stage",
        priority: 5,
        status: "PENDING",
        payload: {
          value: "payload",
          _workflowId: "reads",
          _groupKey: "group",
          _definitionVersion: "v1",
        },
      },
    });
  } else {
    await configured.queue.enqueue({
      workflowRunId: run.id,
      workflowId: "reads",
      stageId: "stage",
      payload: { value: "payload" },
      groupKey: "group",
      definitionVersion: "v1",
    });
  }
  await withStepResultSpill(
    configured.ledger,
    createPayloadSpill({ blobStore: configured.blob, thresholdBytes: 32 }),
  ).claim({
    stageRecordId: stage.id,
    stepId: "step",
    seq: 1,
    kind: "run",
    status: "completed",
    attempt: 1,
    leaseExpiresAt: null,
    deadlineAt: null,
    externalKey: null,
    result,
  });
  await configured.blob.put("reads/direct", { value: "blob" });
  await configured.logger.logBatchResults(run.id, [
    {
      topic: "reads.stats",
      callType: "text",
      modelKey: "model",
      modelId: "model",
      prompt: "p",
      response: "r",
      inputTokens: 3,
      outputTokens: 7,
      cost: 0.25,
      requestId: "request",
    },
  ]);
  return { run, stage };
}

async function assertReads(
  bound: ReturnType<typeof reads>,
  records: Awaited<ReturnType<typeof seed>>,
) {
  expect(Object.keys(bound.queue)).toEqual(["getJobsByWorkflowRun"]);
  expect(Object.keys(bound.ledger).sort()).toEqual(["get", "list"]);
  expect(Object.keys(bound.blob).sort()).toEqual(["get", "has", "list"]);
  expect(Object.keys(bound.logger)).toEqual(["getStats"]);
  const jobs = await bound.queue.getJobsByWorkflowRun!(records.run.id);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    workflowId: "reads",
    payload: { value: "payload" },
  });
  const step = await bound.ledger.get!(records.stage.id, "step");
  expect(isSpillRef(step!.result)).toBe(true);
  expect(await bound.ledger.get!(records.stage.id, "missing")).toBeNull();
  expect(await bound.ledger.list!(records.stage.id)).toEqual([step]);
  expect(await bound.blob.get!("reads/direct")).toEqual({ value: "blob" });
  expect(await bound.blob.has!("reads/direct")).toBe(true);
  expect(await bound.blob.has!("missing")).toBe(false);
  expect(await bound.blob.list!("reads/")).toEqual(["reads/direct"]);
  const decoded = withStepResultSpill(
    bound.ledger as StepLedger,
    createPayloadSpill({
      blobStore: bound.blob as BlobStore,
      thresholdBytes: 32,
    }),
  );
  expect((await decoded.get(records.stage.id, "step"))?.result).toEqual(result);
  expect((await decoded.list(records.stage.id))[0]!.result).toEqual(result);
  expect(await bound.logger.getStats!("reads.")).toMatchObject({
    totalCalls: 1,
    totalInputTokens: 3,
    totalOutputTokens: 7,
    totalCost: 0.25,
  });
}

function noReads(configured: Ports, persistence: Persistence) {
  for (const port of Object.values(configured))
    expect(port.transactionReads(persistence)).toBeUndefined();
}

describe(`SQLite ${major} transaction read capabilities`, () => {
  let directory: string;
  let client: any;
  let foreign: any;
  let configured: Ports;
  let persistence: PrismaWorkflowPersistence;
  let nativeTx: any;
  let timeout: number | undefined;

  async function sqliteClient(file: string) {
    if (major === "8") {
      const db = await fixtures.createSqliteDb(file);
      return Object.assign(fromPrisma8(db), { $disconnect: () => db.close() });
    }
    const generated = fixtures.createSqliteClient(file);
    if (major !== "6") return generated;
    await generated.$disconnect();
    return new generated.constructor({
      datasourceUrl: `file:${file}?connection_limit=1`,
    });
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "sqlite8-adapter-reads-"));
    client = await sqliteClient(join(directory, "own.db"));
    foreign =
      major === "6"
        ? new client.constructor({
            datasourceUrl: `file:${join(directory, "own.db")}?connection_limit=1`,
          })
        : await sqliteClient(join(directory, "foreign.db"));
    const transaction = client.$transaction.bind(client);
    // Capture the real transaction passed through the driver, without replacing any SQL.
    client.$transaction = (fn: any, options: any) =>
      typeof fn !== "function"
        ? transaction(fn, options)
        : transaction(
            async (tx: any) => {
              nativeTx = tx;
              try {
                return await fn(tx);
              } finally {
                nativeTx = undefined;
              }
            },
            timeout === undefined ? options : { ...options, timeout },
          );
    configured = ports(client, "sqlite");
    persistence = new PrismaWorkflowPersistence(client, {
      databaseType: "sqlite",
    });
  }, 60_000);

  beforeEach(async () => {
    timeout = undefined;
    for (const model of [
      "workflowStep",
      "workflowStage",
      "workflowRun",
      "jobQueue",
      "aICall",
      "workflowBlob",
    ])
      await client[model].deleteMany();
  });

  afterAll(async () => {
    await client?.$disconnect();
    await foreign?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reads uncommitted data from every facade, preserves spill decoding and closes retained reads", async () => {
    let retained!: ReturnType<typeof reads>;
    let txPersistence!: Persistence;
    let rootRead: Promise<unknown> | undefined;
    let rootFinished = false;
    let records!: Awaited<ReturnType<typeof seed>>;
    await persistence.withTransaction(async (tx) => {
      txPersistence = tx;
      const consumerPorts = ports(nativeTx, "sqlite");
      records = await seed(tx, consumerPorts, nativeTx);
      retained = reads(configured, tx);
      if (major === "6")
        rootRead = client.jobQueue.count().then(() => {
          rootFinished = true;
        });
      await assertReads(retained, records);
      await assertReads(reads(consumerPorts, tx), records);
      if (major === "6") expect(rootFinished).toBe(false);
    });
    await rootRead;
    if (major === "6") expect(rootFinished).toBe(true);
    noReads(configured, txPersistence);
    for (const call of [
      () => retained.queue.getJobsByWorkflowRun!(records.run.id),
      () => retained.ledger.get!(records.stage.id, "step"),
      () => retained.ledger.list!(records.stage.id),
      () => retained.blob.get!("reads/direct"),
      () => retained.blob.has!("reads/direct"),
      () => retained.blob.list!("reads/"),
      () => retained.logger.getStats!("reads."),
    ])
      await expect(call()).rejects.toMatchObject({ code: "P2028" });
    expect(await configured.blob.get("reads/direct")).toEqual({
      value: "blob",
    });
  });

  it("rejects other roots and nontransactional scopes", async () => {
    noReads(configured, persistence);
    await new PrismaWorkflowPersistence(client, {
      databaseType: "sqlite",
      skipInteractiveTransactions: true,
    }).withTransaction(async (tx) => noReads(configured, tx));
    await persistence.withTransaction(async (tx) => {
      noReads(ports(foreign, "sqlite"), tx);
      noReads(configured, Object.create(tx));
    });
    await new PrismaWorkflowPersistence(foreign, {
      databaseType: "sqlite",
    }).withTransaction(async (tx) => noReads(configured, tx));
  });

  it("rolls back transaction writes and never moves configured root writes onto a facade", async () => {
    let retained!: ReturnType<typeof reads>;
    const aborted = new Error("abort reads");
    await expect(
      persistence.withTransaction(async (tx) => {
        const records = await seed(tx, ports(nativeTx, "sqlite"), nativeTx);
        retained = reads(configured, tx);
        await assertReads(retained, records);
        expect("enqueue" in retained.queue).toBe(false);
        expect(retained.queue.enqueueParallel).toBeUndefined();
        expect(retained.ledger.update).toBeUndefined();
        expect(retained.blob.put).toBeUndefined();
        expect(retained.logger.logBatchResults).toBeUndefined();
        throw aborted;
      }),
    ).rejects.toBe(aborted);
    expect(await client.workflowRun.count()).toBe(0);
    expect(await client.workflowStep.count()).toBe(0);
    expect(await client.jobQueue.count()).toBe(0);
    expect(await client.aICall.count()).toBe(0);
    expect(await configured.blob.list("")).toEqual([]);
    await expect(retained.blob.get!("reads/direct")).rejects.toMatchObject({
      code: "P2028",
    });
    await configured.blob.put("after", { committed: true });
    expect(await configured.blob.get("after")).toEqual({ committed: true });
  });

  it("preserves the driver deadline and rollback", async () => {
    timeout = 100;
    let retained!: ReturnType<typeof reads>;
    await expect(
      persistence.withTransaction(async (tx) => {
        await ports(nativeTx, "sqlite").blob.put("expired", {
          committed: false,
        });
        retained = reads(configured, tx);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await retained.blob.get!("expired");
      }),
    ).rejects.toMatchObject({ code: "P2028" });
    expect(await configured.blob.has("expired")).toBe(false);
    await expect(retained.blob.has!("expired")).rejects.toMatchObject({
      code: "P2028",
    });
  });

  it.skipIf(major !== "8")(
    "revokes reads when a deadline rejects before its callback settles",
    async () => {
      timeout = 100;
      let release!: () => void;
      let ready!: () => void;
      let settled!: () => void;
      let retained!: ReturnType<typeof reads>;
      let scope!: Persistence;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const finished = new Promise<void>((resolve) => {
        settled = resolve;
      });
      const pending = persistence.withTransaction(async (tx) => {
        scope = tx;
        retained = reads(configured, tx);
        try {
          await ports(nativeTx, "sqlite").blob.put("late", {
            committed: false,
          });
          ready();
          await gate;
          await retained.blob.has!("late");
        } finally {
          settled();
        }
      });
      try {
        await started;
        await expect(pending).rejects.toMatchObject({ code: "P2028" });
        noReads(configured, scope);
        await expect(retained.blob.has!("late")).rejects.toMatchObject({
          code: "P2028",
        });
      } finally {
        release();
        await finished;
      }
      expect(await configured.blob.has("late")).toBe(false);
    },
  );

  it("serves 100 concurrent transaction callbacks through all seven reads", async () => {
    const records = await seed(persistence, configured);
    await Promise.all(
      Array.from({ length: 100 }, () =>
        persistence.withTransaction(async (tx) => {
          const bound = reads(configured, tx);
          const values = await Promise.all([
            bound.queue.getJobsByWorkflowRun!(records.run.id),
            bound.ledger.get!(records.stage.id, "step"),
            bound.ledger.list!(records.stage.id),
            bound.blob.get!("reads/direct"),
            bound.blob.has!("reads/direct"),
            bound.blob.list!("reads/"),
            bound.logger.getStats!("reads."),
          ]);
          expect(values[0]).toHaveLength(1);
          expect(values[4]).toBe(true);
          expect(values[6]).toMatchObject({ totalCalls: 1 });
        }),
      ),
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  `PostgreSQL ${major} transaction read compatibility`,
  () => {
    let client: any;
    let configured: Ports;
    let persistence: PrismaWorkflowPersistence;
    beforeAll(() => {
      if (major === "8") {
        const db = fixtures.createPostgresDb(process.env.DATABASE_URL);
        client = Object.assign(fromPrisma8(db), {
          $disconnect: () => db.close(),
        });
      } else client = fixtures.createPostgresClient(process.env.DATABASE_URL);
      configured = ports(client, "postgresql");
      persistence = new PrismaWorkflowPersistence(client);
    });
    afterAll(() => client?.$disconnect());

    it("keeps configured root reads and returns no transaction facades", async () => {
      const stats = await configured.logger.getStats("reads.");
      noReads(configured, persistence);
      await persistence.withTransaction(async (tx) => {
        await tx.createRun({
          workflowId: "pg-reads",
          workflowName: "pg-reads",
          workflowType: "pg-reads",
          input: {},
        });
        noReads(configured, tx);
        expect(await configured.logger.getStats("reads.")).toEqual(stats);
        expect(await configured.blob.has("pg-reads-missing")).toBe(false);
        expect(
          await configured.queue.getJobsByWorkflowRun("pg-reads-missing"),
        ).toEqual([]);
        expect(await configured.ledger.list("pg-reads-missing")).toEqual([]);
      });
    });
  },
);
