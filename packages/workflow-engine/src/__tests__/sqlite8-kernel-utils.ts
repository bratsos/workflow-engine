import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineAsyncBatchStage, defineStage } from "../core/stage-factory.js";
import { WorkflowBuilder } from "../core/workflow.js";
import { createKernel, type KernelConfig } from "../kernel/kernel.js";
import { CollectingEventSink } from "../kernel/testing/index.js";
import {
  createPrismaAICallLogger,
  createPrismaBlobStore,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "../persistence/prisma/index.js";
import { createPostgresClient } from "./utils/postgres-client.js";

export const sqlite = process.env.SQLITE8_KERNEL_SQLITE === "1";
export const realDatabase = sqlite || Boolean(process.env.DATABASE_URL);
const schema = z.object({ value: z.string() });

export function kernelWorkflow(pollError?: string, durable = false) {
  const stage = defineAsyncBatchStage({
    id: "first",
    name: "First",
    mode: "async-batch",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      if (durable) {
        const value = await ctx.step.run("work", async () => ctx.input.value);
        ctx.log("INFO", "stored durable result");
        return { output: { value } };
      }
      return { output: ctx.input };
    },
    async checkCompletion() {
      return pollError
        ? { ready: false, error: pollError }
        : { ready: true, output: { value: "polled" } };
    },
  });
  const next = defineStage({
    id: "second",
    name: "Second",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
  return new WorkflowBuilder(
    "sqlite8-kernel",
    "Kernel",
    "kernel",
    schema,
    schema,
  )
    .pipe(stage)
    .pipe(next)
    .build();
}

export function override<T extends object>(target: T, methods: Partial<T>): T {
  return new Proxy(target, {
    get(object, key) {
      if (key in methods) return Reflect.get(methods, key);
      const value = Reflect.get(object, key);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

export async function kernelDatabase() {
  let directory: string | undefined;
  let client: any;
  if (sqlite) {
    directory = await mkdtemp(join(tmpdir(), "sqlite8-kernel-"));
    const fixture = createRequire(import.meta.url)(
      "../../../prisma-fixtures/index.cjs",
    );
    const file = join(directory, "kernel.db");
    if (process.env.PRISMA_MAJOR === "8") {
      const db = await fixture.createSqliteDb(file);
      client = Object.assign(fromPrisma8(db), {
        $disconnect: () => db.close(),
      });
    } else {
      client = fixture.createSqliteClient(file);
    }
  } else {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("connection_limit", "10");
    client = createPostgresClient(url.toString());
  }
  const options = {
    databaseType: sqlite ? ("sqlite" as const) : ("postgresql" as const),
  };
  const persistence = createPrismaWorkflowPersistence(client, options);
  const createLogger: (
    client: Parameters<typeof createPrismaAICallLogger>[0],
    options?: { databaseType: "postgresql" | "sqlite" },
  ) => ReturnType<typeof createPrismaAICallLogger> = createPrismaAICallLogger;
  const aiLogger = createLogger(client, options);
  const jobTransport = createPrismaJobQueue(client, {
    ...options,
    workerId: "kernel-worker",
  });
  const stepLedger = createPrismaStepLedger(client, options);
  const blobStore = createPrismaBlobStore(client);
  const workflow = kernelWorkflow();
  const clock = { now: () => new Date() };
  const config: KernelConfig = {
    persistence,
    jobTransport,
    stepLedger,
    blobStore,
    clock,
    eventSink: new CollectingEventSink(),
    registry: {
      getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
    },
  };
  return {
    client,
    persistence,
    aiLogger,
    jobTransport,
    stepLedger,
    blobStore,
    workflow,
    clock,
    kernel: createKernel(config),
    makeKernel: (changes: Partial<KernelConfig> = {}) =>
      createKernel({ ...config, ...changes }),
    async seed(
      status: "RUNNING" | "COMPLETED" = "RUNNING",
      stageStatus = "PENDING",
    ) {
      const id = crypto.randomUUID();
      await persistence.createRun({
        id,
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowType: "kernel",
        input: { value: "seed" },
      });
      await persistence.updateRun(id, {
        status,
        ...(status === "COMPLETED"
          ? { completedAt: new Date("2020-01-01T00:00:00Z") }
          : {}),
      });
      const stage = await persistence.createStage({
        workflowRunId: id,
        stageId: "first",
        stageName: "First",
        stageNumber: 1,
        executionGroup: 1,
        status: stageStatus as any,
      });
      if (stageStatus === "SUSPENDED")
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date("2020-01-01T00:00:00Z"),
          pollInterval: 1000,
          suspendedState: { batchId: id },
        });
      const jobId = await jobTransport.enqueue({
        workflowRunId: id,
        workflowId: workflow.id,
        stageId: "first",
      });
      if (stageStatus === "SUSPENDED")
        await jobTransport.suspend(jobId, new Date("2020-01-01T00:00:00Z"));
      return { id, stage, jobId };
    },
    async reset() {
      for (const table of [
        "job_queue",
        "outbox_events",
        "idempotency_keys",
        "workflow_annotations",
        "workflow_artifacts",
        "workflow_logs",
        "workflow_steps",
        "workflow_stages",
        "workflow_runs",
        "workflow_blobs",
        "ai_calls",
      ])
        await client.$executeRawUnsafe(`DELETE FROM "${table}"`);
    },
    async close() {
      try {
        await client.$disconnect();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export type KernelDatabase = Awaited<ReturnType<typeof kernelDatabase>>;
