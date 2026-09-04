import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { PrismaClient as PrismaClientType } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { defineWorkflow } from "../../core/workflow.js";
import { executeJobWithHeartbeat } from "../../kernel/helpers/host-support.js";
import { createKernel } from "../../kernel/kernel.js";
import type { Clock } from "../../kernel/ports.js";
import {
  CollectingEventSink,
  InMemoryBlobStore,
} from "../../kernel/testing/index.js";
import {
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
} from "../../persistence/prisma/index.js";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("I want SQL enqueue to agree with run.create", () => {
    it("skipped - set DATABASE_URL to run against a real Postgres database", () => {});
  });
} else {
  describe("I want SQL enqueue to agree with run.create", () => {
    const require = createRequire(import.meta.url);
    const { PrismaClient } = require("@prisma/client");
    const prisma: PrismaClientType = new PrismaClient({
      datasourceUrl: DATABASE_URL,
    });

    async function truncateAll() {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "job_queue", "workflow_annotations", "workflow_artifacts", "workflow_logs", "workflow_stages", "workflow_runs", "ai_calls", "outbox_events", "idempotency_keys", "workflow_definitions" RESTART IDENTITY CASCADE`,
      );
    }

    // Prisma sends a JS number as bigint and a JS null as `unknown`, so the
    // scalar arguments are cast at the call site rather than in the function.
    const SELECT_ENQUEUE =
      "SELECT workflow_engine_enqueue($1::text, $2::text, $3::text, $4::jsonb, $5::jsonb, $6::integer, $7::text) AS id";

    beforeAll(async () => {
      const sql = await readFile(
        new URL("../../../sql/enqueue.sql", import.meta.url),
        "utf8",
      );
      for (const statement of sql
        .split(/(?<=\$\$;)\s*/)
        .map((s) => s.trim())
        .filter(Boolean)) {
        await prisma.$executeRawUnsafe(statement);
      }
    });

    beforeEach(async () => {
      await truncateAll();
    });

    afterAll(async () => {
      await truncateAll();
      await prisma.$disconnect();
    });

    const echoStage = defineStage({
      id: "echo",
      name: "Echo",
      schemas: {
        input: z.object({ value: z.string() }),
        output: z.object({ text: z.string() }),
        config: z.object({
          prefix: z.string().default("="),
        }),
      },
      async execute(ctx) {
        return { output: { text: `${ctx.config.prefix}${ctx.input.value}` } };
      },
    });

    const workflow = defineWorkflow({
      id: "sql-enqueue-wf",
      name: "SQL Enqueue Workflow",
      description: "Echoes input value with prefix",
      input: z.object({ value: z.string() }),
    })
      .pipe(echoStage)
      .build();

    const persistence = createPrismaWorkflowPersistence(prisma);
    const jobQueue = createPrismaJobQueue(prisma, {
      workerId: "sql-enqueue-worker",
    });
    const blobStore = new InMemoryBlobStore();
    const eventSink = new CollectingEventSink();
    const clock: Clock = { now: () => new Date() };

    const kernel = createKernel({
      persistence,
      jobTransport: jobQueue,
      blobStore,
      eventSink,
      clock,
      registry: {
        getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
      },
    });

    it("creates the same run row as run.create", async () => {
      const tsResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "ts-1",
        workflowId: workflow.id,
        input: { value: "hello" },
      });

      const [sqlRow] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        SELECT_ENQUEUE,
        "sql-1",
        workflow.id,
        workflow.name,
        JSON.stringify({ value: "hello" }),
        JSON.stringify(workflow.getDefaultConfig()),
        5,
        workflow.definitionVersion,
      );

      const tsRun = await prisma.workflowRun.findUnique({
        where: { id: tsResult.workflowRunId },
      });
      const sqlRun = await prisma.workflowRun.findUnique({
        where: { id: sqlRow.id },
      });

      expect(tsRun).not.toBeNull();
      expect(sqlRun).not.toBeNull();

      const toComparable = (row: NonNullable<typeof tsRun>) => ({
        workflowId: row.workflowId,
        workflowName: row.workflowName,
        workflowType: row.workflowType,
        status: row.status,
        input: row.input,
        config: row.config,
        priority: row.priority,
        definitionVersion: row.definitionVersion,
        version: row.version,
        totalCost: row.totalCost,
        totalTokens: row.totalTokens,
        redriveCount: row.redriveCount,
        output: row.output,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        metadata: row.metadata,
      });

      expect(toComparable(sqlRun!)).toEqual(toComparable(tsRun!));
    });

    it("records the same idempotency result and outbox event", async () => {
      const tsResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "ts-1",
        workflowId: workflow.id,
        input: { value: "hello" },
      });

      const [sqlRow] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        SELECT_ENQUEUE,
        "sql-1",
        workflow.id,
        workflow.name,
        JSON.stringify({ value: "hello" }),
        JSON.stringify(workflow.getDefaultConfig()),
        5,
        workflow.definitionVersion,
      );

      const tsRunId = tsResult.workflowRunId;
      const sqlRunId = sqlRow.id;

      const idempotencyKeys = await prisma.idempotencyKey.findMany({
        orderBy: { key: "asc" },
      });
      expect(idempotencyKeys).toHaveLength(2);

      const tsKey = idempotencyKeys.find(
        (k: { key: string }) => k.key === "ts-1",
      );
      const sqlKey = idempotencyKeys.find(
        (k: { key: string }) => k.key === "sql-1",
      );

      expect(tsKey).toBeDefined();
      expect(sqlKey).toBeDefined();
      expect(tsKey?.commandType).toBe("run.create");
      expect(sqlKey?.commandType).toBe("run.create");
      expect(tsKey?.result).toEqual({
        workflowRunId: tsRunId,
        status: "PENDING",
        definitionVersion: workflow.definitionVersion,
      });
      expect(sqlKey?.result).toEqual({
        workflowRunId: sqlRunId,
        status: "PENDING",
        definitionVersion: workflow.definitionVersion,
      });

      const outboxEvents = await prisma.outboxEvent.findMany();
      expect(outboxEvents).toHaveLength(2);

      const tsEvent = outboxEvents.find(
        (e: { workflowRunId: string }) => e.workflowRunId === tsRunId,
      );
      const sqlEvent = outboxEvents.find(
        (e: { workflowRunId: string }) => e.workflowRunId === sqlRunId,
      );

      expect(tsEvent).toBeDefined();
      expect(sqlEvent).toBeDefined();

      expect(tsEvent?.eventType).toBe("workflow:created");
      expect(tsEvent?.sequence).toBe(1);
      expect(tsEvent?.causationId).toBe("ts-1");
      expect(tsEvent?.payload).toMatchObject({
        type: "workflow:created",
        workflowRunId: tsRunId,
        workflowId: "sql-enqueue-wf",
      });
      expect(
        typeof (tsEvent?.payload as { timestamp: unknown }).timestamp,
      ).toBe("string");

      expect(sqlEvent?.eventType).toBe("workflow:created");
      expect(sqlEvent?.sequence).toBe(1);
      expect(sqlEvent?.causationId).toBe("sql-1");
      expect(sqlEvent?.payload).toMatchObject({
        type: "workflow:created",
        workflowRunId: sqlRunId,
        workflowId: "sql-enqueue-wf",
      });

      const sqlPayload = sqlEvent?.payload as { timestamp: string };
      expect(sqlPayload.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it("a SQL-created run executes to the same output as a TypeScript-created one", async () => {
      const tsResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "ts-exec",
        workflowId: workflow.id,
        input: { value: "world" },
      });

      const [sqlRow] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        SELECT_ENQUEUE,
        "sql-exec",
        workflow.id,
        workflow.name,
        JSON.stringify({ value: "world" }),
        "{}",
        5,
        workflow.definitionVersion,
      );

      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "sql-enqueue-worker",
        maxClaims: 10,
      });

      let jobsExecuted = 0;
      for (;;) {
        const job = await jobQueue.dequeue();
        if (!job) break;
        if (++jobsExecuted > 20) {
          throw new Error("Bounded job loop exceeded 20 iterations");
        }
        await executeJobWithHeartbeat(kernel, {
          jobTransport: jobQueue,
          job,
        });
      }

      const tsRun = await prisma.workflowRun.findUnique({
        where: { id: tsResult.workflowRunId },
      });
      const sqlRun = await prisma.workflowRun.findUnique({
        where: { id: sqlRow.id },
      });

      expect(tsRun?.status).toBe("COMPLETED");
      expect(sqlRun?.status).toBe("COMPLETED");
      expect(tsRun?.output).toEqual({ text: "=world" });
      expect(sqlRun?.output).toEqual(tsRun?.output);
    });

    it("returns the same run id on a replay instead of creating a second run", async () => {
      const [first] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        SELECT_ENQUEUE,
        "replay-key",
        workflow.id,
        workflow.name,
        JSON.stringify({ value: "test" }),
        "{}",
        5,
        null,
      );

      const [second] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        SELECT_ENQUEUE,
        "replay-key",
        workflow.id,
        workflow.name,
        JSON.stringify({ value: "test" }),
        "{}",
        5,
        null,
      );

      expect(first.id).toBeTruthy();
      expect(second.id).toBe(first.id);
      expect(await prisma.workflowRun.count()).toBe(1);
    });

    it("creates the run unpinned when no definition version is given", async () => {
      const [row] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        SELECT_ENQUEUE,
        "unpinned-key",
        workflow.id,
        workflow.name,
        JSON.stringify({ value: "unpinned" }),
        "{}",
        5,
        null,
      );

      const run = await prisma.workflowRun.findUnique({
        where: { id: row.id },
      });
      expect(run?.definitionVersion).toBeNull();

      const claimResult = await kernel.dispatch({
        type: "run.claimPending",
        workerId: "sql-enqueue-worker",
        maxClaims: 10,
      });

      expect(claimResult.claimed.some((c) => c.workflowRunId === row.id)).toBe(
        true,
      );
    });

    it("refuses to pin a run to a definition version that was never registered", async () => {
      await expect(
        prisma.$queryRawUnsafe<Array<{ id: string }>>(
          SELECT_ENQUEUE,
          "bogus-key",
          workflow.id,
          workflow.name,
          JSON.stringify({ value: "bogus" }),
          "{}",
          5,
          "nonexistent-definition-version",
        ),
      ).rejects.toThrow(/workflow_definitions/);
    });
  });
}
