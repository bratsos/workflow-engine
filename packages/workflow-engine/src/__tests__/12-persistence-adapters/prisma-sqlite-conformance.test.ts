/**
 * Runs the published persistence, queue, logger, and ledger conformance suites
 * against a real SQLite file for Prisma 6, 7, or 8, then exercises the Prisma
 * blob store and kernel through those same adapters.
 *
 * Run after installing the fixture dependencies:
 * `eval "$(fnm env --shell bash)"; PRISMA_MAJOR=6 fnm exec --using=24 pnpm test:sqlite`
 * (set PRISMA_MAJOR to 7 or 8 for those fixtures). The Prisma 8 fixture emits
 * its SQLite contract and initializes a fresh file.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { createKernel } from "../../kernel/kernel.js";
import type { Clock } from "../../kernel/ports.js";
import { CollectingEventSink } from "../../kernel/testing/index.js";
import { fromPrisma8 } from "../../persistence/prisma/from-prisma8.js";
import {
  createPrismaAICallLogger,
  createPrismaBlobStore,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
} from "../../persistence/prisma/index.js";
import {
  aiCallLoggerConformanceSuite,
  jobQueueConformanceSuite,
  persistenceConformanceSuite,
  stepLedgerConformanceSuite,
} from "../../testing/persistence-conformance.js";

const major = process.env.PRISMA_MAJOR ?? "7";
const require = createRequire(import.meta.url);
const fixtures = require("../../../../prisma-fixtures/index.cjs");
const api = { describe, it, expect, beforeEach };

describe(`I want the Prisma ${major} SQLite adapters to conform against a real file`, () => {
  let directory: string;
  let prisma: any;

  async function resetAll(): Promise<void> {
    for (const model of [
      "workflowLog",
      "workflowAnnotation",
      "workflowArtifact",
      "workflowStep",
      "jobQueue",
      "outboxEvent",
      "idempotencyKey",
      "aICall",
      "workflowStage",
      "workflowRun",
      "workflowDefinition",
      "workflowBlob",
    ]) {
      await prisma[model].deleteMany();
    }
  }

  async function seedLedgerStages(): Promise<void> {
    await prisma.workflowRun.create({
      data: {
        id: "sqlite-ledger-run",
        workflowId: "sqlite-ledger-workflow",
        workflowName: "SQLite Step Ledger",
        workflowType: "sqlite-step-ledger",
        input: {},
        config: {},
      },
    });
    for (const [index, id] of ["stage-1", "stage-2"].entries()) {
      await prisma.workflowStage.create({
        data: {
          id,
          workflowRunId: "sqlite-ledger-run",
          stageId: id,
          stageName: id,
          stageNumber: index + 1,
          executionGroup: index + 1,
        },
      });
    }
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), `prisma-${major}-sqlite-`));
    const file = join(directory, "workflow.db");
    if (major === "8") {
      const db = await fixtures.createSqliteDb(file);
      try {
        prisma = Object.assign(fromPrisma8(db), {
          $disconnect: () => db.close(),
        });
      } catch (error) {
        db.close();
        throw error;
      }
    } else {
      prisma = fixtures.createSqliteClient(file);
    }
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  persistenceConformanceSuite(
    `PrismaWorkflowPersistence (SQLite ${major})`,
    () =>
      Object.assign(
        createPrismaWorkflowPersistence(prisma, { databaseType: "sqlite" }),
        { reset: resetAll },
      ),
    api,
  );

  jobQueueConformanceSuite(
    `PrismaJobQueue (SQLite ${major})`,
    () =>
      Object.assign(
        createPrismaJobQueue(prisma, {
          workerId: "sqlite-conformance-worker",
          databaseType: "sqlite",
        }),
        { reset: resetAll },
      ),
    api,
  );

  aiCallLoggerConformanceSuite(
    `PrismaAICallLogger (SQLite ${major})`,
    () => Object.assign(createPrismaAICallLogger(prisma), { reset: resetAll }),
    api,
  );

  stepLedgerConformanceSuite(
    `PrismaStepLedger (SQLite ${major})`,
    () => {
      const ledger = createPrismaStepLedger(prisma, {
        databaseType: "sqlite",
      });
      return Object.assign(ledger, {
        reset: async () => {
          await resetAll();
          await seedLedgerStages();
        },
      });
    },
    api,
  );

  describe("PrismaBlobStore (SQLite)", () => {
    beforeEach(resetAll);

    it("puts, reads, checks, lists, overwrites, and deletes real blobs", async () => {
      const store = createPrismaBlobStore(prisma);
      expect(await store.has("suite:item")).toBe(false);
      await store.put("suite:item", { count: 1, nested: ["a"] });
      await store.put("suite:other", { count: 2 });
      await store.put("outside:item", "outside");

      expect(await store.has("suite:item")).toBe(true);
      expect(await store.get("suite:item")).toEqual({
        count: 1,
        nested: ["a"],
      });
      expect(await store.list("suite:")).toEqual(["suite:item", "suite:other"]);

      await store.put("suite:item", { count: 3 });
      expect(await store.get("suite:item")).toEqual({ count: 3 });
      await store.delete("suite:item");
      expect(await store.has("suite:item")).toBe(false);
      await expect(store.get("suite:item")).rejects.toThrow(
        "Blob not found: suite:item",
      );
    });
  });

  describe("kernel end-to-end on SQLite", () => {
    beforeEach(resetAll);

    it("runs two stages, persists step and blob data, flushes events, and replays idempotently", async () => {
      const schema = z.object({ value: z.string() });
      const stage1 = defineStage({
        id: "stage-one",
        name: "Stage One",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) {
          return { output: { value: `${ctx.input.value}-1` } };
        },
      });
      const stage2 = defineStage({
        id: "stage-two",
        name: "Stage Two",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) {
          return { output: { value: `${ctx.input.value}-2` } };
        },
      });
      const workflow = new WorkflowBuilder(
        "sqlite-e2e-workflow",
        "SQLite E2E Workflow",
        "Kernel conformance on a real SQLite file",
        schema,
        schema,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();
      const persistence = createPrismaWorkflowPersistence(prisma, {
        databaseType: "sqlite",
      });
      const jobTransport = createPrismaJobQueue(prisma, {
        workerId: "sqlite-e2e-worker",
        databaseType: "sqlite",
      });
      const blobStore = createPrismaBlobStore(prisma);
      const stepLedger = createPrismaStepLedger(prisma, {
        databaseType: "sqlite",
      });
      const eventSink = new CollectingEventSink();
      const clock: Clock = { now: () => new Date() };
      const kernel = createKernel({
        persistence,
        jobTransport,
        blobStore,
        stepLedger,
        eventSink,
        clock,
        registry: {
          getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
        },
      });

      const created = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "sqlite-e2e-create-key",
        workflowId: workflow.id,
        input: { value: "start" },
      });
      expect(created.status).toBe("PENDING");

      const claimed = await kernel.dispatch({
        type: "run.claimPending",
        workerId: "sqlite-e2e-worker",
        maxClaims: 10,
      });
      expect(
        claimed.claimed.some(
          (run) => run.workflowRunId === created.workflowRunId,
        ),
      ).toBe(true);

      let iterations = 0;
      for (;;) {
        const job = await jobTransport.dequeue();
        if (!job) break;
        if (++iterations > 10) {
          throw new Error("SQLite kernel E2E exceeded 10 job executions");
        }
        const result = await kernel.dispatch({
          type: "job.execute",
          idempotencyKey: `job:${job.jobId}:attempt:${job.attempt}`,
          workflowRunId: job.workflowRunId,
          workflowId: job.workflowId,
          stageId: job.stageId,
          config: {},
        });
        expect(result.outcome).toBe("completed");
        await jobTransport.complete(job.jobId);
        await kernel.dispatch({
          type: "run.transition",
          workflowRunId: created.workflowRunId,
        });
      }

      expect(iterations).toBe(2);
      expect(await persistence.getRun(created.workflowRunId)).toMatchObject({
        status: "COMPLETED",
        output: { value: "start-1-2" },
      });
      expect(await prisma.workflowBlob.count()).toBeGreaterThan(0);

      const flushed = await kernel.dispatch({
        type: "outbox.flush",
        maxEvents: 100,
      });
      expect(flushed.published).toBeGreaterThan(0);
      expect(eventSink.getByType("workflow:completed")).toHaveLength(1);

      const replay = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "sqlite-e2e-create-key",
        workflowId: workflow.id,
        input: { value: "start" },
      });
      expect(replay.workflowRunId).toBe(created.workflowRunId);
    });
  });
});
