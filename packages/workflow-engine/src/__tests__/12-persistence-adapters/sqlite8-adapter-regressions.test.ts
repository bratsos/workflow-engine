import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DefinitionRegistrationRetryableError } from "../../persistence/interface.js";
import {
  createPrismaAICallLogger,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "../../persistence/prisma/index.js";
import { rawFor } from "../../persistence/prisma/prisma-client-type.js";
import { isSqliteBusy } from "../../persistence/prisma/sql-errors.js";

const major = process.env.PRISMA_MAJOR ?? "7";
const fixtures = createRequire(import.meta.url)(
  "../../../../prisma-fixtures/index.cjs",
);
const options = { databaseType: "sqlite" } as const;
const definition = {
  workflowId: "adapter-test",
  version: "v1",
  snapshot: {} as any,
  structureHash: "hash",
};

const constructors = [
  ["persistence", createPrismaWorkflowPersistence],
  ["queue", createPrismaJobQueue],
  ["ledger", createPrismaStepLedger],
  ["logger", createPrismaAICallLogger],
] as const;

describe(`SQLite adapter regressions on Prisma ${major}`, () => {
  let directory: string;
  let file: string;
  let prisma: any;
  let db: any;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "sqlite8-adapter-"));
    file = join(directory, "workflow.db");
    if (major === "8") {
      db = await fixtures.createSqliteDb(file);
      prisma = Object.assign(fromPrisma8(db), {
        $disconnect: () => db.close(),
      });
    } else {
      prisma = fixtures.createSqliteClient(file);
    }
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.aICall.deleteMany();
    await prisma.workflowDefinition.deleteMany();
  });

  it("checks unrecorded, column and legacy metadata batch IDs", async () => {
    const logger = createPrismaAICallLogger(prisma, options);
    expect(await logger.isRecorded("missing")).toBe(false);
    const call = {
      topic: "adapter-test",
      callType: "text",
      modelKey: "model",
      modelId: "model",
      prompt: "prompt",
      response: "response",
      inputTokens: 1,
      outputTokens: 2,
      cost: 0,
      requestId: "request-1",
    };
    await logger.logBatchResults("column-batch", [call]);
    await logger.logBatchResults("column-batch", [call]);
    expect(await prisma.aICall.count()).toBe(1);
    await prisma.aICall.create({
      data: { ...call, metadata: { batchId: "legacy-batch" } },
    });
    expect(await logger.isRecorded("column-batch")).toBe(true);
    expect(await logger.isRecorded("legacy-batch")).toBe(true);
    expect(await logger.isRecorded("missing")).toBe(false);
  });

  it("registers definitions with raw timestamps matching model reads and filters", async () => {
    const persistence = createPrismaWorkflowPersistence(prisma, options);
    const before = new Date();
    const registered = await persistence.withTransaction((tx) =>
      tx.insertDefinitionIfAbsent(definition),
    );
    const after = new Date();
    expect(registered?.createdAt).toBeInstanceOf(Date);
    expect(registered!.createdAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(registered!.createdAt.getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
    expect(
      await prisma.workflowDefinition.count({
        where: { createdAt: { gte: before, lte: after } },
      }),
    ).toBe(1);
    const [row] = (await rawFor(prisma, { encoding: "text" }).$queryRawUnsafe!(
      'SELECT typeof("createdAt") AS encoding FROM "workflow_definitions"',
    )) as Array<{ encoding: string }>;
    expect(row!.encoding).toBe(major === "6" ? "integer" : "text");
    expect(
      await persistence.insertDefinitionIfAbsent({
        ...definition,
        structureHash: "ignored",
      }),
    ).toEqual(registered);
  });

  it("marks an external writer collision retryable and succeeds after it releases the file", async () => {
    await rawFor(prisma, { timeout: "int" }).$queryRawUnsafe!(
      "PRAGMA busy_timeout = 1",
    );
    // A separate process owns the lock: closing an unrelated SQLite connection
    // in this process must not release the holder's POSIX file locks.
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      process.stdin.once("data", () => { db.exec("ROLLBACK"); db.close(); });
    `,
        file,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const exited = once(holder, "exit");
    try {
      await Promise.race([
        once(holder.stdout, "data"),
        exited.then(() => {
          throw new Error(
            "SQLite lock holder exited before acquiring its lock",
          );
        }),
      ]);
      const persistence = createPrismaWorkflowPersistence(prisma, options);
      const failure = await persistence
        .insertDefinitionIfAbsent(definition)
        .catch((error) => error);
      expect(failure).toBeInstanceOf(DefinitionRegistrationRetryableError);
      expect(failure.retryable).toBe(true);
      expect(isSqliteBusy(failure.cause)).toBe(true);
    } finally {
      if (
        holder.pid &&
        holder.exitCode === null &&
        holder.signalCode === null
      ) {
        holder.stdin.end("release");
        await exited;
      }
    }
    expect(
      await createPrismaWorkflowPersistence(
        prisma,
        options,
      ).insertDefinitionIfAbsent(definition),
    ).toMatchObject(definition);
  }, 15_000);

  describe.skipIf(major !== "8")("Prisma 8 SQLite client", () => {
    it("marks a stale snapshot in an external transaction retryable", async () => {
      await rawFor(prisma, { journal_mode: "text" }).$queryRawUnsafe!(
        "PRAGMA journal_mode = WAL",
      );
      const persistence = createPrismaWorkflowPersistence(prisma, options);
      await db.transaction(async (tx: any) => {
        const wrapped = fromPrisma8(tx, { contract: db.contract });
        const external = createPrismaWorkflowPersistence(wrapped, options);
        await external.getDefinition(definition.workflowId, definition.version);
        await persistence.insertDefinitionIfAbsent(definition);
        const failure = await external
          .insertDefinitionIfAbsent({ ...definition, version: "stale" })
          .catch((error) => error);
        expect(failure).toBeInstanceOf(DefinitionRegistrationRetryableError);
        expect(isSqliteBusy(failure.cause)).toBe(true);
        expect(failure.cause.cause.errcode).toBe(517);
      });
      expect(
        await persistence.getDefinition(definition.workflowId, "stale"),
      ).toBeNull();
      expect(
        await persistence.insertDefinitionIfAbsent({
          ...definition,
          version: "stale",
        }),
      ).toMatchObject({ version: "stale" });
    });

    it.each(
      constructors,
    )("%s rejects default and explicit PostgreSQL options before SQL", (_name, create) => {
      expect(() => create(prisma)).toThrow('Set databaseType: "sqlite"');
      expect(() => create(prisma, { databaseType: "postgresql" })).toThrow(
        'Set databaseType: "sqlite"',
      );
      expect(() => create(prisma, options)).not.toThrow();
    });

    it("validates transaction and raw-column views", async () => {
      expect(prisma.$databaseType).toBe("sqlite");
      expect(prisma.$withColumns({ encoding: "text" }).$databaseType).toBe(
        "sqlite",
      );
      await prisma.$transaction(async (tx: any) => {
        expect(tx.$databaseType).toBe("sqlite");
        for (const [, create] of constructors) {
          expect(() => create(tx)).toThrow('Set databaseType: "sqlite"');
          expect(() => create(tx, options)).not.toThrow();
        }
      });
    });
  });
});

describe.skipIf(major !== "8" || !process.env.DATABASE_URL)(
  "PostgreSQL contract target validation",
  () => {
    let db: any;
    let prisma: any;
    beforeAll(async () => {
      db = fixtures.createPostgresDb(process.env.DATABASE_URL);
      prisma = fromPrisma8(db);
      expect(
        await rawFor(prisma, { n: "int" }).$queryRawUnsafe!("SELECT 1 AS n"),
      ).toEqual([{ n: 1 }]);
    });
    afterAll(() => db?.close());

    it.each(
      constructors,
    )("%s names the PostgreSQL option before executing SQL", (_name, create) => {
      expect(prisma.$databaseType).toBe("postgresql");
      expect(() => create(prisma, options)).toThrow(
        'Set databaseType: "postgresql"',
      );
      expect(() => create(prisma)).not.toThrow();
    });
  },
);
