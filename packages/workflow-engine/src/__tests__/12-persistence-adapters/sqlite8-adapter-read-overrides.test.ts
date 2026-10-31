import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Persistence } from "../../kernel/ports.js";
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
type Read = (...args: any[]) => Promise<any>;
const cases = [
  {
    name: "queue.getJobsByWorkflowRun",
    Base: PrismaJobQueue,
    method: "getJobsByWorkflowRun",
    args: ["policy-run"],
    custom: async (read: Read, args: any[], policy: string) =>
      (await read(...args)).filter((row: any) => row.stageId === policy),
    check: (rows: any) =>
      expect(rows.map((row: any) => row.stageId)).toEqual(["visible"]),
  },
  {
    name: "ledger.get",
    Base: PrismaStepLedger,
    method: "get",
    args: ["policy-stage", "hidden"],
    custom: async (read: Read, args: any[], policy: string) => {
      const row = await read(...args);
      return row?.stepId === policy ? row : null;
    },
    check: (row: any) => expect(row).toBeNull(),
  },
  {
    name: "ledger.list",
    Base: PrismaStepLedger,
    method: "list",
    args: ["policy-stage"],
    custom: async (read: Read, args: any[], policy: string) =>
      (await read(...args)).filter((row: any) => row.stepId === policy),
    check: (rows: any) =>
      expect(rows.map((row: any) => row.stepId)).toEqual(["visible"]),
  },
  {
    name: "blob.get",
    Base: PrismaBlobStore,
    method: "get",
    args: ["visible"],
    custom: async (read: Read, args: any[], policy: string) => {
      expect(policy).toBe("visible");
      return (await read(...args)).envelope;
    },
    check: (data: any) => expect(data).toEqual({ decoded: true }),
  },
  {
    name: "blob.has",
    Base: PrismaBlobStore,
    method: "has",
    args: ["hidden"],
    custom: async (read: Read, args: any[], policy: string) =>
      (await read(...args)) && args[0] === policy,
    check: (exists: any) => expect(exists).toBe(false),
  },
  {
    name: "blob.list",
    Base: PrismaBlobStore,
    method: "list",
    args: [""],
    custom: async (read: Read, args: any[], policy: string) =>
      (await read(...args)).filter((key: string) => key === policy),
    check: (keys: any) => expect(keys).toEqual(["visible"]),
  },
  {
    name: "logger.getStats",
    Base: PrismaAICallLogger,
    method: "getStats",
    args: ["policy."],
    custom: async (read: Read, args: any[], policy: string) =>
      read(`${args[0]}${policy}.`),
    check: (stats: any) =>
      expect(stats).toMatchObject({ totalCalls: 1, totalCost: 1 }),
  },
];
type Case = (typeof cases)[number];

function customPort(
  spec: Case,
  client: any,
  databaseType: "sqlite" | "postgresql",
  style: "subclass" | "instance" | "proxy",
  explicit = false,
): any {
  const Base = spec.Base as any;
  const options = { databaseType };
  const method = spec.method;
  if (style === "subclass") {
    if (!explicit) {
      return new (class extends Base {
        constructor(...args: any[]) {
          super(...args);
        }
        #policy = "visible";
        async [method](...args: any[]) {
          return spec.custom(
            (...values) => super[method](...values),
            args,
            this.#policy,
          );
        }
      })(client, options);
    }
    return new (class extends Base {
      #policy = "visible";
      #provider: any;
      constructor() {
        super(client, options);
        this.#provider = new Base(client, options);
      }
      async [method](...args: any[]) {
        return spec.custom(
          (...values) => super[method](...values),
          args,
          this.#policy,
        );
      }
      transactionReads(persistence: Persistence) {
        const reads = this.#provider.transactionReads(persistence);
        if (!reads) return undefined;
        return {
          ...reads,
          [method]: (...args: any[]) =>
            spec.custom(reads[method], args, this.#policy),
        };
      }
    })();
  }
  if (style === "proxy") {
    const target = new Base(client, options);
    const read = target[method].bind(target);
    const provider = new Base(client, options);
    return new Proxy(target, {
      get(object, key, receiver) {
        if (key === method)
          return (...args: any[]) => spec.custom(read, args, "visible");
        if (key === "transactionReads" && explicit)
          return (persistence: Persistence) => {
            const reads = provider.transactionReads(persistence);
            return (
              reads && {
                ...reads,
                [method]: (...args: any[]) =>
                  spec.custom(reads[method], args, "visible"),
              }
            );
          };
        return Reflect.get(object, key, receiver);
      },
    });
  }
  const port = new Base(client, options);
  const read = port[method].bind(port);
  port[method] = (...args: any[]) => spec.custom(read, args, "visible");
  if (explicit) {
    const provider = new Base(client, options);
    port.transactionReads = (persistence: Persistence) => {
      const reads = provider.transactionReads(persistence);
      return (
        reads && {
          ...reads,
          [method]: (...args: any[]) =>
            spec.custom(reads[method], args, "visible"),
        }
      );
    };
  }
  return port;
}

async function seed(client: any) {
  await client.workflowRun.create({
    data: {
      id: "policy-run",
      workflowId: "policy",
      workflowName: "policy",
      workflowType: "policy",
      input: {},
      config: {},
    },
  });
  await client.workflowStage.create({
    data: {
      id: "policy-stage",
      workflowRunId: "policy-run",
      stageId: "stage",
      stageName: "stage",
      stageNumber: 1,
      executionGroup: 0,
    },
  });
  await client.jobQueue.createMany({
    data: ["visible", "hidden"].map((stageId) => ({
      workflowRunId: "policy-run",
      stageId,
      payload: { _workflowId: "policy" },
    })),
  });
  await client.workflowStep.createMany({
    data: ["visible", "hidden"].map((stepId, seq) => ({
      stageRecordId: "policy-stage",
      stepId,
      seq,
      kind: "run",
      status: "completed",
    })),
  });
  const blob = new PrismaBlobStore(client);
  await blob.put("visible", { envelope: { decoded: true } });
  await blob.put("hidden", { envelope: { decoded: false } });
  await client.aICall.createMany({
    data: ["visible", "hidden"].map((topic, index) => ({
      topic: `policy.${topic}.call`,
      callType: "text",
      modelKey: "model",
      modelId: "model",
      prompt: "p",
      response: "r",
      inputTokens: 1,
      outputTokens: 1,
      cost: index === 0 ? 1 : 100,
    })),
  });
}

async function sqliteClient(file: string) {
  if (major === "8") {
    const db = await fixtures.createSqliteDb(file);
    return Object.assign(fromPrisma8(db), { $disconnect: () => db.close() });
  }
  const client = fixtures.createSqliteClient(file);
  if (major !== "6") return client;
  await client.$disconnect();
  return new client.constructor({
    datasourceUrl: `file:${file}?connection_limit=1`,
  });
}

describe(`SQLite ${major} configured read overrides`, () => {
  let directory: string;
  let client: any;
  let foreign: any;
  let persistence: PrismaWorkflowPersistence;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "sqlite8-adapter-overrides-"));
    client = await sqliteClient(join(directory, "own.db"));
    foreign = await sqliteClient(join(directory, "foreign.db"));
    persistence = new PrismaWorkflowPersistence(client, {
      databaseType: "sqlite",
    });
    await seed(client);
  }, 60_000);
  afterAll(async () => {
    await client?.$disconnect();
    await foreign?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  for (const style of ["subclass", "instance", "proxy"] as const) {
    it.each(
      cases,
    )(`${style} $name opts out instead of bypassing its policy`, async (spec) => {
      const port = customPort(spec, client, "sqlite", style);
      expect(port.transactionReads(persistence)).toBeUndefined();
      spec.check(await port[spec.method](...spec.args));
      await persistence.withTransaction(async (tx) => {
        expect(port.transactionReads(tx)).toBeUndefined();
        // Native 6 has one occupied connection; its custom provider must bind explicitly.
        if (major !== "6") {
          const selected = port.transactionReads(tx) ?? port;
          spec.check(await selected[spec.method](...spec.args));
        }
      });
      await new PrismaWorkflowPersistence(foreign, {
        databaseType: "sqlite",
      }).withTransaction(async (tx) => {
        expect(port.transactionReads(tx)).toBeUndefined();
      });
    });

    it.each(
      cases,
    )(`${style} $name can explicitly compose a transaction reader with its policy`, async (spec) => {
      const port = customPort(spec, client, "sqlite", style, true);
      expect(port.transactionReads(persistence)).toBeUndefined();
      await persistence.withTransaction(async (tx) => {
        const selected = port.transactionReads(tx);
        expect(selected).toBeDefined();
        spec.check(await selected[spec.method](...spec.args));
      });
      await new PrismaWorkflowPersistence(foreign, {
        databaseType: "sqlite",
      }).withTransaction(async (tx) => {
        expect(port.transactionReads(tx)).toBeUndefined();
      });
    });
  }

  it.each(
    cases,
  )("$name accessor overrides are not evaluated by automatic binding", async (spec) => {
    const Base = spec.Base as any;
    const port = new Base(client, { databaseType: "sqlite" });
    Object.defineProperty(port, spec.method, {
      get() {
        throw new Error("custom read accessor");
      },
    });
    expect(port.transactionReads(persistence)).toBeUndefined();
    await persistence.withTransaction(async (tx) =>
      expect(port.transactionReads(tx)).toBeUndefined(),
    );
  });
  it.each(
    cases,
  )("unmodified inherited $name retains automatic binding", async (spec) => {
    const Base = spec.Base as any;
    const port = new (class extends Base {
      constructor(...args: any[]) {
        super(...args);
      }
    })(client, {
      databaseType: "sqlite",
    });
    await persistence.withTransaction(async (tx) => {
      expect(port.transactionReads(tx)).toBeDefined();
      await port.transactionReads(tx)[spec.method](...spec.args);
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  `PostgreSQL ${major} configured overrides`,
  () => {
    let client: any;
    beforeAll(() => {
      if (major === "8") {
        const db = fixtures.createPostgresDb(process.env.DATABASE_URL);
        client = Object.assign(fromPrisma8(db), {
          $disconnect: () => db.close(),
        });
      } else client = fixtures.createPostgresClient(process.env.DATABASE_URL);
    });
    afterAll(() => client?.$disconnect());
    it("offers no automatic or explicit base-provider facade in PostgreSQL scopes", async () => {
      const persistence = new PrismaWorkflowPersistence(client);
      for (const spec of cases) {
        const Base = spec.Base as any;
        const port = new Base(client, { databaseType: "postgresql" });
        Object.defineProperty(port, spec.method, {
          get() {
            throw new Error("custom read accessor");
          },
        });
        expect(port.transactionReads(persistence)).toBeUndefined();
        await persistence.withTransaction(async (tx) =>
          expect(port.transactionReads(tx)).toBeUndefined(),
        );
      }
      for (const spec of cases)
        for (const style of ["subclass", "instance", "proxy"] as const)
          for (const explicit of [false, true]) {
            const port = customPort(
              spec,
              client,
              "postgresql",
              style,
              explicit,
            );
            expect(port.transactionReads(persistence)).toBeUndefined();
            await persistence.withTransaction(async (tx) =>
              expect(port.transactionReads(tx)).toBeUndefined(),
            );
          }
    });
  },
);
