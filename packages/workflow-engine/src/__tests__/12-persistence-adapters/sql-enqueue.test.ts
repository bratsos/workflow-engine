import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Client } from "pg";
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
  fromPrisma8,
  type PrismaWorkflowPersistenceOptions,
} from "../../persistence/prisma/index.js";
import {
  type EnginePrismaClient,
  rawFor,
} from "../../persistence/prisma/prisma-client-type.js";
import { override } from "../sqlite8-kernel-utils.js";
import { createPostgresClient, isPrisma8 } from "../utils/postgres-client.js";

/**
 * Typed structurally, like the adapters themselves, so this file typechecks
 * without a generated `@prisma/client` (CI typechecks before generating one).
 */
type TestClient = EnginePrismaClient & {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $disconnect(): Promise<void>;
};

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("I want SQL enqueue to agree with run.create", () => {
    it("skipped - set DATABASE_URL to run against a real Postgres database", () => {});
  });
} else {
  describe("I want SQL enqueue to agree with run.create", () => {
    const prisma: TestClient = createPostgresClient(DATABASE_URL);

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
      const installer = new Client({ connectionString: DATABASE_URL });
      await installer.connect();
      try {
        // Start with the released signature, including the original defaults.
        await installer.query(`
          CREATE OR REPLACE FUNCTION workflow_engine_enqueue(
            p_idempotency_key text, p_workflow_id text, p_workflow_name text,
            p_input jsonb, p_config jsonb DEFAULT '{}'::jsonb,
            p_priority integer DEFAULT 5, p_definition_version text DEFAULT NULL
          ) RETURNS text LANGUAGE sql AS $$ SELECT 'old overload'::text $$;
        `);
        await installer.query(sql);
      } finally {
        await installer.end();
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

    const workerId = "sql-enqueue-worker";
    function makeKernel(
      client: EnginePrismaClient,
      options?: PrismaWorkflowPersistenceOptions,
    ) {
      const jobTransport = createPrismaJobQueue(client, { workerId });
      const clock: Clock = { now: () => new Date() };
      return {
        jobTransport,
        kernel: createKernel({
          persistence: createPrismaWorkflowPersistence(client, options),
          jobTransport,
          blobStore: new InMemoryBlobStore(),
          eventSink: new CollectingEventSink(),
          clock,
          registry: {
            getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
          },
        }),
      };
    }
    const { kernel, jobTransport: jobQueue } = makeKernel(prisma);

    async function withListener(
      test: (
        writer: Client,
        received: string[],
        flush: () => Promise<void>,
      ) => Promise<void>,
    ) {
      const writer = new Client({ connectionString: DATABASE_URL });
      const listener = new Client({ connectionString: DATABASE_URL });
      const received: string[] = [];
      let barriers = 0;
      let sent = 0;
      listener.on("notification", ({ channel, payload }) => {
        if (channel === "workflow_engine_runs" && payload !== undefined) {
          received.push(payload);
        } else if (channel === "workflow_engine_test_barrier") {
          barriers++;
        }
      });
      try {
        await writer.connect();
        await listener.connect();
        await listener.query("LISTEN workflow_engine_runs");
        await listener.query("LISTEN workflow_engine_test_barrier");
        await test(writer, received, async () => {
          const barrier = ++sent;
          await writer.query(
            "SELECT pg_notify('workflow_engine_test_barrier', '')",
          );
          // The listener has read everything queued before the barrier.
          await vi.waitFor(() => expect(barriers).toBe(barrier));
        });
      } finally {
        await Promise.all([writer.end(), listener.end()]);
      }
    }

    it("stores tenant attribution and notifies once on commit, with no wake on rollback or replay", async () => {
      await withListener(async (writer, received, flush) => {
        const enqueue = (key: string) =>
          writer.query<{ id: string }>(
            "SELECT workflow_engine_enqueue($1, $2, $3, $4, $5, $6, $7, $8, $9) AS id",
            [
              key,
              workflow.id,
              workflow.name,
              '{"value":"test"}',
              "{}",
              5,
              null,
              "tenant-a",
              '{"queue":"batch"}',
            ],
          );

        await writer.query("BEGIN");
        await enqueue("rolled-back");
        await writer.query("ROLLBACK");
        await flush();
        expect(received).toEqual([]);
        expect(await prisma.workflowRun.count()).toBe(0);

        await writer.query("BEGIN");
        const {
          rows: [first],
        } = await enqueue("committed");
        expect(received).toEqual([]);
        expect(await prisma.workflowRun.count()).toBe(0);
        await writer.query("COMMIT");
        await flush();
        expect(received).toEqual([first.id]);

        expect(
          await prisma.workflowRun.findUnique({ where: { id: first.id } }),
        ).toMatchObject({
          tenantId: "tenant-a",
          labels: { queue: "batch" },
        });
        expect(
          await prisma.idempotencyKey.findFirst({
            where: { key: "committed", commandType: "run.create" },
          }),
        ).toMatchObject({
          workflowRunId: first.id,
        });

        const {
          rows: [replay],
        } = await enqueue("committed");
        await flush();
        expect(replay.id).toBe(first.id);
        expect(received).toEqual([first.id]);
      });
    });

    it("notifies once for run.create, even when dispatched twice with one key", async () => {
      await withListener(async (_writer, received, flush) => {
        const command = {
          type: "run.create",
          workflowId: workflow.id,
          idempotencyKey: "kernel-wake",
          input: { value: "test" },
        } as const;
        await expect(
          prisma.$transaction!(async (tx: EnginePrismaClient) => {
            await makeKernel(tx).kernel.dispatch(command);
            throw new Error("roll back run.create");
          }),
        ).rejects.toThrow("roll back run.create");
        await flush();
        expect(received).toEqual([]);
        expect(await prisma.workflowRun.count()).toBe(0);

        const { workflowRunId } = await kernel.dispatch(command);
        expect(await kernel.dispatch(command)).toMatchObject({ workflowRunId });
        await flush();
        expect(received).toEqual([workflowRunId]);
      });
    });

    it("rejects nonportable SQL labels without leaving a run, key or notification", async () => {
      await withListener(async (writer, received, flush) => {
        const enqueue = (labels?: string) =>
          writer.query<{ id: string }>(
            "SELECT workflow_engine_enqueue($1, $2, $3, $4, NULL, NULL, NULL, NULL, $5) AS id",
            [
              "label-check",
              workflow.id,
              workflow.name,
              '{"value":"test"}',
              labels,
            ],
          );
        for (const labels of [
          "null",
          "[]",
          '"value"',
          "true",
          "1",
          '{"queue":1}',
          '{"queue":null}',
          '{"queue":{}}',
          '{"queue":[]}',
          '{"queue":["value"]}',
          '{"__proto__":"value"}',
        ]) {
          await expect(enqueue(labels)).rejects.toMatchObject({
            code: "22023",
          });
        }
        for (const labels of ['{"\\u0000":"value"}', '{"\\uD800":"value"}']) {
          await expect(enqueue(labels)).rejects.toMatchObject({
            code: expect.stringMatching(/^22/),
          });
        }
        await flush();
        expect(received).toEqual([]);
        expect(await prisma.workflowRun.count()).toBe(0);
        expect(await prisma.idempotencyKey.count()).toBe(0);

        const labels =
          '{"constructor":"ordinary","set":"value","toJSON":"ordinary","queue-🔔":"ready-🔔"}';
        const {
          rows: [created],
        } = await enqueue(labels);
        const {
          rows: [replay],
        } = await enqueue('{"queue":[]}');
        expect(replay?.id).toBe(created?.id);
        expect(
          await prisma.workflowRun.findUnique({
            where: { id: created?.id },
          }),
        ).toMatchObject({ labels: JSON.parse(labels) });
        await flush();
        expect(received).toEqual([created?.id]);
        await expect(
          writer.query(
            "SELECT workflow_engine_enqueue('empty-map', $1, $2, $3, NULL, NULL, NULL, NULL, '{}')",
            [workflow.id, workflow.name, '{"value":"test"}'],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });
      });
    });

    it.each([
      "$executeRaw",
      "$executeRawUnsafe",
      "delegate-only",
    ] as const)("respects the raw capabilities of a caller-owned %s view", async (method) => {
      await withListener(async (_writer, received, flush) => {
        const workflowRunId = await prisma.$transaction!(
          async (tx: EnginePrismaClient) => {
            const facade = override(tx, {
              $queryRaw: undefined,
              $queryRawUnsafe: undefined,
              $withColumns: undefined,
              $transaction: undefined,
              ...(method !== "$executeRaw" && { $executeRaw: undefined }),
              ...(method !== "$executeRawUnsafe" && {
                $executeRawUnsafe: undefined,
              }),
            });
            const { kernel } = makeKernel(facade, {
              transactionView: true,
              definitionVersioning: method === "$executeRaw",
            });
            const command = {
              type: "run.create",
              workflowId: workflow.id,
              idempotencyKey: "facade-wake",
              input: { value: "test" },
            } as const;
            const { workflowRunId } = await kernel.dispatch(command);
            expect(await kernel.dispatch(command)).toMatchObject({
              workflowRunId,
            });
            expect(received).toEqual([]);
            return workflowRunId;
          },
        );
        await flush();
        expect(received).toEqual(
          method === "delegate-only" ? [] : [workflowRunId],
        );
        expect(await prisma.workflowRun.count()).toBe(1);
      });
    });

    it("keeps the seven-argument signature, which creates an unattributed run with its own body", async () => {
      const writer = new Client({ connectionString: DATABASE_URL });
      await writer.connect();
      try {
        const { rows } = await writer.query(
          "SELECT to_regprocedure('workflow_engine_enqueue(text,text,text,jsonb,jsonb,integer,text)') IS NOT NULL AS seven, to_regprocedure('workflow_engine_enqueue(text,text,text,jsonb,jsonb,integer,text,text,jsonb)') IS NOT NULL AS nine",
        );
        expect(rows).toEqual([{ seven: true, nine: true }]);
        const {
          rows: [created],
        } = await writer.query(SELECT_ENQUEUE, [
          "seven-arguments",
          workflow.id,
          workflow.name,
          '{"value":"test"}',
          "{}",
          5,
          null,
        ]);
        expect(
          await prisma.workflowRun.findUnique({ where: { id: created.id } }),
        ).toMatchObject({ tenantId: null, labels: null });
        await expect(
          writer.query(SELECT_ENQUEUE, [
            "",
            workflow.id,
            workflow.name,
            '{"value":"test"}',
            "{}",
            5,
            null,
          ]),
        ).rejects.toMatchObject({
          code: "P0001",
          message: expect.stringContaining("an idempotency key is required"),
        });
      } finally {
        await writer.end();
      }
    });

    it.skipIf(!isPrisma8)(
      "creates and claims runs with a renamed Postgres status enum",
      async () => {
        const fixture = createRequire(import.meta.url)(
          "../../../../prisma-fixtures/v8/index.cjs",
        );
        const db = fixture.createPostgresDb(DATABASE_URL, {
          statusEnumName: "WorkflowStatus",
        });
        const standard = fixture.createPostgresDb(DATABASE_URL);
        try {
          expect(db.contract.storage.storageHash).not.toBe(
            standard.contract.storage.storageHash,
          );
          await prisma.$executeRawUnsafe(
            'ALTER TYPE "Status" RENAME TO "WorkflowStatus"',
          );
          try {
            const renamed = fromPrisma8(db);
            const { kernel, jobTransport } = makeKernel(renamed, {
              statusEnumName: "WorkflowStatus",
            });
            const { workflowRunId } = await kernel.dispatch({
              type: "run.create",
              workflowId: workflow.id,
              idempotencyKey: "renamed-kernel",
              input: { value: "test" },
            });
            const [sqlRun] = await rawFor(renamed, { id: "text" })
              .$queryRawUnsafe!<Array<{ id: string }>>(
              SELECT_ENQUEUE,
              "renamed-sql",
              workflow.id,
              workflow.name,
              '{"value":"test"}',
              "{}",
              5,
              null,
            );
            const { claimed } = await kernel.dispatch({
              type: "run.claimPending",
              workerId,
              maxClaims: 2,
            });
            expect(claimed.map((run) => run.workflowRunId).sort()).toEqual(
              [workflowRunId, sqlRun.id].sort(),
            );
            const job = await jobTransport.dequeue();
            if (!job)
              throw new Error(
                "Expected a first-stage job with the renamed status enum",
              );
            await executeJobWithHeartbeat(kernel, { jobTransport, job });
            expect(
              await renamed.workflowRun.findUnique({
                where: { id: job.workflowRunId },
              }),
            ).toMatchObject({
              status: "COMPLETED",
            });
          } finally {
            await prisma.$executeRawUnsafe(
              'ALTER TYPE "WorkflowStatus" RENAME TO "Status"',
            );
          }
        } finally {
          await Promise.all([db.close(), standard.close()]);
        }
      },
    );

    it("creates the same run row as run.create", async () => {
      const tsResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "ts-1",
        workflowId: workflow.id,
        input: { value: "hello" },
      });

      const [sqlRow] = await rawFor(prisma, { id: "text" }).$queryRawUnsafe<
        Array<{ id: string }>
      >(
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

      const [sqlRow] = await rawFor(prisma, { id: "text" }).$queryRawUnsafe<
        Array<{ id: string }>
      >(
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

      const outboxEvents = await prisma.outboxEvent.findMany({});
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

      const [sqlRow] = await rawFor(prisma, { id: "text" }).$queryRawUnsafe<
        Array<{ id: string }>
      >(
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
      const [first] = await rawFor(prisma, { id: "text" }).$queryRawUnsafe<
        Array<{ id: string }>
      >(
        SELECT_ENQUEUE,
        "replay-key",
        workflow.id,
        workflow.name,
        JSON.stringify({ value: "test" }),
        "{}",
        5,
        null,
      );

      const [second] = await rawFor(prisma, { id: "text" }).$queryRawUnsafe<
        Array<{ id: string }>
      >(
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
      const [row] = await rawFor(prisma, { id: "text" }).$queryRawUnsafe<
        Array<{ id: string }>
      >(
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
        rawFor(prisma, { id: "text" }).$queryRawUnsafe<Array<{ id: string }>>(
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
