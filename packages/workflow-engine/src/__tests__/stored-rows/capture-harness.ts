import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelEvent } from "../../kernel/events.js";
import {
  executeJobWithHeartbeat,
  runMaintenanceTick,
} from "../../kernel/helpers/index.js";
import { createKernel, createWorkflowRegistry } from "../../kernel/kernel.js";
import type { OutboxDeliveryMetadata } from "../../kernel/ports.js";
import { CollectingEventSink, FakeClock } from "../../kernel/testing/index.js";
import {
  createPrismaAICallLogger,
  createPrismaBlobStore,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
} from "../../persistence/prisma/index.js";
import {
  aiFactoryForScenario,
  createScenario,
  STORED_ROW_SCENARIOS,
} from "./scenarios.js";
import {
  captureRows,
  clearRows,
  readPrismaSchema,
  type StoredRowsSnapshot,
} from "./snapshot.js";

const schemaPath = resolve(
  new URL("../../../prisma/schema.prisma", import.meta.url).pathname,
);
const packagePath = resolve(
  new URL("../../../package.json", import.meta.url).pathname,
);
const currentSchema = readPrismaSchema(schemaPath);
const releaseVersion = (
  JSON.parse(readFileSync(packagePath, "utf8")) as { version: string }
).version;

export interface CaptureDatabase {
  client: Record<string, any>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

interface Runtime {
  client: Record<string, any>;
  kernel: ReturnType<typeof createKernel>;
  persistence: ReturnType<typeof createPrismaWorkflowPersistence>;
  jobTransport: ReturnType<typeof createPrismaJobQueue>;
  clock: FakeClock;
  eventSink: CollectingEventSink;
  deliveries: Array<{ event: KernelEvent; eventId: string }>;
}

export async function openCaptureDatabase(): Promise<CaptureDatabase> {
  const helperPath = fileURLToPath(
    new URL("../sqlite8-kernel-utils.ts", import.meta.url),
  );
  if (existsSync(helperPath)) {
    const helper = await import("../sqlite8-kernel-utils.js");
    const db = await helper.kernelDatabase();
    return { client: db.client, reset: db.reset, close: db.close };
  }

  const major = Number(process.env.PRISMA_MAJOR ?? "7");
  const isSqlite = process.env.SQLITE8_KERNEL_SQLITE === "1";
  const fixturePath = fileURLToPath(
    new URL("../../../../prisma-fixtures/index.cjs", import.meta.url),
  );
  if (!existsSync(fixturePath)) {
    if (isSqlite)
      throw new Error(`This release has no SQLite fixture: ${releaseVersion}`);
    if (!process.env.DATABASE_URL)
      throw new Error("Postgres capture requires DATABASE_URL");
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set("connection_limit", "10");
    const { PrismaClient } = createRequire(import.meta.url)("@prisma/client");
    const client = new PrismaClient({ datasourceUrl: url.toString() });
    return {
      client,
      reset: () => clearRows(client),
      async close() {
        await client.$disconnect();
      },
    };
  }
  const fixture = createRequire(import.meta.url)(fixturePath);
  let directory: string | undefined;
  let client: Record<string, any>;
  if (isSqlite) {
    directory = await mkdtemp(join(tmpdir(), "stored-rows-"));
    const file = join(directory, "stored-rows.db");
    if (major === 8) {
      const db = fixture.createSqliteDb(file);
      const { fromPrisma8 } = await import("../../persistence/prisma/index.js");
      client = Object.assign(fromPrisma8(db), {
        $disconnect: () => db.close(),
      });
    } else {
      client = fixture.createSqliteClient(file);
    }
  } else {
    if (!process.env.DATABASE_URL)
      throw new Error("Postgres capture requires DATABASE_URL");
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set("connection_limit", "10");
    if (major === 8) {
      const db = fixture.createPostgresDb(url.toString());
      const { fromPrisma8 } = await import("../../persistence/prisma/index.js");
      client = Object.assign(fromPrisma8(db), {
        $disconnect: () => db.close(),
      });
    } else {
      client = fixture.createPostgresClient(url.toString());
    }
  }

  return {
    client,
    reset: () => clearRows(client),
    async close() {
      try {
        await client.$disconnect();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

function createRuntime(
  client: Record<string, any>,
  scenario: ReturnType<typeof createScenario>,
  clock = new FakeClock(new Date()),
): Runtime {
  const databaseType =
    process.env.SQLITE8_KERNEL_SQLITE === "1" ? "sqlite" : "postgresql";
  const options = { databaseType } as const;
  const persistence = createPrismaWorkflowPersistence(client as any, options);
  const jobTransport = createPrismaJobQueue(client as any, {
    ...options,
    workerId: "stored-rows-host",
    now: () => clock.now(),
  });
  const stepLedger = createPrismaStepLedger(client as any, options);
  const blobStore = createPrismaBlobStore(client as any);
  const aiLogger = createPrismaAICallLogger(client as any, options);
  const eventSink = new CollectingEventSink();
  const deliveries: Array<{ event: KernelEvent; eventId: string }> = [];
  const emit = eventSink.emit.bind(eventSink);
  eventSink.emit = async (
    event: KernelEvent,
    delivery?: OutboxDeliveryMetadata,
  ) => {
    await emit(event);
    if (delivery) deliveries.push({ event, eventId: delivery.eventId });
  };
  const kernel = createKernel({
    persistence,
    jobTransport,
    stepLedger,
    blobStore,
    clock,
    eventSink,
    registry: createWorkflowRegistry([scenario.workflow]),
    services: { aiLogger, ai: aiFactoryForScenario(scenario) },
  });
  return {
    client,
    kernel,
    persistence,
    jobTransport,
    clock,
    eventSink,
    deliveries,
  };
}

/** One host round matching the liveness-sweep test's claim/execute/poll order. */
export async function hostTick(runtime: Runtime): Promise<boolean> {
  const { kernel, jobTransport } = runtime;
  let worked = false;
  const claim = await kernel.dispatch({
    type: "run.claimPending",
    workerId: "stored-rows-host",
    maxClaims: 50,
  });
  worked ||= claim.claimed.length > 0;

  for (;;) {
    const job = await jobTransport.dequeue();
    if (!job) break;
    worked = true;
    await executeJobWithHeartbeat(kernel, {
      jobTransport,
      job: {
        jobId: job.jobId,
        workflowRunId: job.workflowRunId,
        workflowId: job.workflowId,
        stageId: job.stageId,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        payload: job.payload,
        startedAt: job.startedAt,
      },
      jobHeartbeatIntervalMs: 2 ** 30,
      logPrefix: "[StoredRows]",
    });
  }

  // The standard maintenance helper supplies the host's suspended-stage
  // poll, lease/stuck reapers, and transactional outbox flush. Its second
  // claim is empty for these one-run fixtures.
  const maintenance = await runMaintenanceTick(kernel, {
    workerId: "stored-rows-host",
    maxClaimsPerTick: 50,
    maxSuspendedChecksPerTick: 50,
    maxOutboxFlushPerTick: 500,
  });
  worked ||= maintenance.claimed > 0;
  if (!worked) runtime.clock.advance(1_000);
  return worked;
}

async function createRun(
  runtime: Runtime,
  scenario: ReturnType<typeof createScenario>,
) {
  const created = await runtime.kernel.dispatch({
    type: "run.create",
    idempotencyKey: `stored-rows:${scenario.id}`,
    workflowId: scenario.workflow.id,
    input: { value: "seed" },
  });
  return created.workflowRunId;
}

async function setupScenario(
  runtime: Runtime,
  scenario: ReturnType<typeof createScenario>,
) {
  const workflowRunId = await createRun(runtime, scenario);
  if (scenario.id === "pending-unclaimed") return workflowRunId;

  await runtime.kernel.dispatch({
    type: "run.claimPending",
    workerId: "stored-rows-host",
  });
  if (scenario.prepareCapture) {
    await scenario.prepareCapture(runtime.client, workflowRunId);
  }

  if (scenario.id !== "running-queued") {
    for (let i = 0; i < 6; i++) {
      const run = await runtime.persistence.getRun(workflowRunId);
      if (run?.status === "FAILED" || run?.status === "COMPLETED") break;
      await hostTick(runtime);
      if (
        [
          "wait-for",
          "sleep",
          "wait-for-signal",
          "completed-step-checkpoint",
          "legacy-async-batch",
          "ai-map-poll",
          "parallel-partial",
        ].includes(scenario.id)
      )
        break;
    }
  }
  if (scenario.id === "unpublished-outbox") {
    const now = runtime.clock.now();
    const event = (probe: string) => ({
      workflowRunId,
      eventType: "workflow:started",
      payload: {
        type: "workflow:started",
        timestamp: now.toISOString(),
        workflowRunId,
        probe,
      },
      causationId: `stored-rows:${probe}`,
      occurredAt: now,
    });
    await runtime.persistence.appendOutboxEvents([event("published-probe")]);
    await runtime.kernel.dispatch({ type: "outbox.flush", maxEvents: 500 });
    await runtime.persistence.appendOutboxEvents([event("unpublished-probe")]);
  }
  return workflowRunId;
}

async function assertCapturedPoint(
  client: Record<string, any>,
  scenarioId: string,
  workflowRunId: string,
) {
  const run = await client.workflowRun.findUnique({
    where: { id: workflowRunId },
  });
  const stages = await client.workflowStage.findMany({
    where: { workflowRunId },
  });
  const jobs = await client.jobQueue.findMany({ where: { workflowRunId } });
  const steps = await client.workflowStep.findMany({
    where: { stage: { workflowRunId } },
  });
  const statusByScenario: Record<
    string,
    { run: string; stage?: string; job?: string }
  > = {
    "pending-unclaimed": { run: "PENDING" },
    "running-queued": { run: "RUNNING", stage: "PENDING", job: "PENDING" },
    "wait-for": { run: "RUNNING", stage: "SUSPENDED" },
    sleep: { run: "RUNNING", stage: "SUSPENDED" },
    "wait-for-signal": { run: "RUNNING", stage: "SUSPENDED" },
    "completed-step-checkpoint": { run: "RUNNING", stage: "SUSPENDED" },
    "legacy-async-batch": { run: "RUNNING", stage: "SUSPENDED" },
    "ai-map-poll": { run: "RUNNING", stage: "SUSPENDED" },
    "failed-redrive": { run: "FAILED", stage: "FAILED", job: "FAILED" },
    "parallel-partial": { run: "RUNNING", stage: "SUSPENDED" },
    "unpublished-outbox": { run: "COMPLETED" },
  };
  const expected = statusByScenario[scenarioId]!;
  if (run?.status !== expected.run) {
    throw new Error(
      `${scenarioId} capture stopped at run ${run?.status}, expected ${expected.run}`,
    );
  }
  if (
    expected.stage &&
    !stages.some((stage: any) => stage.status === expected.stage)
  ) {
    throw new Error(
      `${scenarioId} capture did not contain a ${expected.stage} stage`,
    );
  }
  if (expected.job && !jobs.some((job: any) => job.status === expected.job)) {
    throw new Error(
      `${scenarioId} capture did not contain a ${expected.job} job`,
    );
  }
  if (scenarioId === "pending-unclaimed" && stages.length !== 0) {
    throw new Error(
      "pending-unclaimed must not have a stage before a host claims the run",
    );
  }
  if (scenarioId === "running-queued" && jobs.length !== 1) {
    throw new Error(
      `running-queued expected one queued job, found ${jobs.length}`,
    );
  }
  if (
    scenarioId === "parallel-partial" &&
    !stages.some((stage: any) => stage.status === "COMPLETED")
  ) {
    throw new Error("parallel-partial must include a completed sibling stage");
  }
  if (
    scenarioId === "ai-map-poll" &&
    !steps.some(
      (step: any) =>
        step.stepId === "items:poll" && step.status !== "completed",
    )
  ) {
    throw new Error(
      "ai-map-poll must leave the ctx.step.ai.map :poll ledger row unfinished",
    );
  }
  if (scenarioId === "completed-step-checkpoint") {
    const blobs = await client.workflowBlob.findMany({});
    if (!blobs.some((blob: any) => JSON.stringify(blob.data).length > 64_000)) {
      throw new Error(
        "completed-step-checkpoint did not spill its large step result to WorkflowBlob",
      );
    }
    if (
      !steps.some(
        (step: any) =>
          step.stepId === "large-result" && step.status === "completed",
      )
    ) {
      throw new Error(
        "completed-step-checkpoint did not persist its completed run step",
      );
    }
  }
  if (scenarioId === "unpublished-outbox") {
    const outbox = await client.outboxEvent.findMany({
      where: { workflowRunId },
    });
    if (
      !outbox.some((event: any) => event.publishedAt !== null) ||
      !outbox.some((event: any) => event.publishedAt === null)
    ) {
      throw new Error(
        "unpublished-outbox must contain both published and unpublished rows",
      );
    }
  }
}

export async function captureScenario(
  client: Record<string, any>,
  scenarioId: string,
  database: "postgresql" | "sqlite",
  prismaMajor = Number(process.env.PRISMA_MAJOR ?? "7"),
): Promise<StoredRowsSnapshot> {
  await clearRows(client);
  const scenario = createScenario(scenarioId);
  const runtime = createRuntime(client, scenario);
  const workflowRunId = await setupScenario(runtime, scenario);
  await assertCapturedPoint(client, scenarioId, workflowRunId);
  return captureRows(client, currentSchema, {
    release: releaseVersion,
    database,
    prismaMajor,
    scenario: scenarioId,
    inFlightPoint: scenario.inFlightPoint,
    expectedFinalOutcome: scenario.expectedFinalOutcome,
    skippedScenarios: [],
    captureTime: runtime.clock.now().toISOString(),
  });
}

export async function captureAllScenarios(
  client: Record<string, any>,
  database: "postgresql" | "sqlite",
  prismaMajor = Number(process.env.PRISMA_MAJOR ?? "7"),
) {
  const snapshots = new Map<string, StoredRowsSnapshot>();
  for (const scenario of STORED_ROW_SCENARIOS) {
    snapshots.set(
      scenario,
      await captureScenario(client, scenario, database, prismaMajor),
    );
  }
  return snapshots;
}

export async function driveToTerminal(
  runtime: Runtime,
  workflowRunId: string,
  maxTicks = 100,
) {
  for (let tick = 0; tick < maxTicks; tick++) {
    const run = await runtime.persistence.getRun(workflowRunId);
    if (run && ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status))
      return run;
    runtime.clock.advance(60_000);
    await hostTick(runtime);
  }
  const run = await runtime.persistence.getRun(workflowRunId);
  throw new Error(
    `Run ${workflowRunId} did not become terminal after ${maxTicks} host ticks (status ${run?.status})`,
  );
}

export function createReplayRuntime(
  client: Record<string, any>,
  scenario: ReturnType<typeof createScenario>,
  clockNow: Date,
) {
  return createRuntime(client, scenario, new FakeClock(clockNow));
}

export function storedRowsReleaseVersion() {
  return releaseVersion;
}

export function storedRowsDatabase() {
  return process.env.SQLITE8_KERNEL_SQLITE === "1" ? "sqlite" : "postgresql";
}
