/**
 * A job delivered again after its stage already ended FAILED (the final
 * attempt, or a deterministic error, settled it and only the acknowledgement
 * was lost) is a dead job: it must not reset the stage or run any step body,
 * through kernel.dispatch and the host path both hosts share, on the in-memory
 * ports and, with SQLITE8_KERNEL_SQLITE=1 or DATABASE_URL, on the Prisma ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../core/stage-factory.js";
import { WorkflowBuilder } from "../core/workflow.js";
import { executeJobWithHeartbeat } from "../kernel/helpers/host-support.js";
import { createKernel, type KernelConfig } from "../kernel/kernel.js";
import {
  CollectingEventSink,
  InMemoryBlobStore,
} from "../kernel/testing/index.js";
import {
  InMemoryJobQueue,
  InMemoryStepLedger,
  InMemoryWorkflowPersistence,
} from "../testing/index.js";
import {
  type KernelDatabase,
  kernelDatabase,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";

const schema = z.object({});
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe(`redelivery of an exhausted job on ${realDatabase ? (sqlite ? "SQLite" : "Postgres") : "memory"}`, () => {
  let db: KernelDatabase | undefined;
  let ports: Pick<
    KernelConfig,
    "persistence" | "jobTransport" | "stepLedger" | "blobStore"
  >;

  beforeAll(async () => {
    if (realDatabase) db = await kernelDatabase();
  }, 120_000);
  beforeEach(async () => {
    await db?.reset();
    ports = db
      ? {
          persistence: db.persistence,
          jobTransport: db.jobTransport,
          stepLedger: db.stepLedger,
          blobStore: db.blobStore,
        }
      : {
          persistence: new InMemoryWorkflowPersistence(),
          jobTransport: new InMemoryJobQueue(),
          stepLedger: new InMemoryStepLedger(),
          blobStore: new InMemoryBlobStore(),
        };
  });
  afterAll(async () => {
    await db?.close();
  });

  /**
   * One stage: a durable receipt, then `error(entry)` thrown, or success when
   * it returns `undefined`.
   */
  function receiptWorkflow(
    onReclaim: "rerun" | "fail",
    error: (entry: number) => unknown,
  ) {
    const seen = { bodies: 0, receipts: 0 };
    const workflow = new WorkflowBuilder(
      "exhausted-redelivery",
      "Exhausted redelivery",
      "exhausted-redelivery",
      schema,
      z.any(),
    )
      .pipe(
        defineStage({
          id: "s",
          name: "S",
          schemas: { input: schema, output: z.any(), config: schema },
          async execute(ctx) {
            seen.bodies++;
            await ctx.step.run(
              "receipt",
              async () => {
                seen.receipts++;
                return seen.receipts;
              },
              { onReclaim },
            );
            const failure = error(seen.bodies);
            if (failure !== undefined) throw failure;
            return { output: { receipts: seen.receipts } };
          },
        }),
      )
      .build();
    return { workflow, seen };
  }

  const ordinary = () => new Error("provider unavailable");
  const deterministic = () => z.number().safeParse("x").error!;

  type Case = [
    name: string,
    onReclaim: "rerun" | "fail",
    executed: number,
    budget: number,
    error: (entry: number) => unknown,
  ];
  const schedules: [string, number, number, (entry: number) => unknown][] = [
    [
      "a lost ack at the last attempt, then a delivery past the budget",
      2,
      2,
      ordinary,
    ],
    [
      "a deterministic failure on attempt 1, then a delivery within the budget",
      1,
      3,
      deterministic,
    ],
    ["a lost lease on the only attempt", 1, 1, ordinary],
    [
      "a deterministic failure on attempt 1 of 3 whose ack is lost, then a transient error on delivery 2",
      1,
      3,
      (entry) => (entry === 1 ? deterministic() : ordinary()),
    ],
  ];
  const cases = schedules.flatMap(([name, ...rest]) =>
    (["rerun", "fail"] as const).map(
      (onReclaim): Case => [name, onReclaim, ...rest],
    ),
  );

  it.each(
    cases,
  )("%s (onReclaim %s) ends the job without running the stage again", async (_name, onReclaim, executed, budget, error) => {
    const { workflow, seen } = receiptWorkflow(onReclaim, error);
    const kernel = createKernel({
      ...ports,
      eventSink: new CollectingEventSink(),
      clock: { now: () => new Date() },
      registry: { getWorkflow: () => workflow },
    });
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      workflowId: workflow.id,
      input: {},
      idempotencyKey: crypto.randomUUID(),
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w" });

    // Each delivery settles the stage; the acknowledgement is lost and the
    // lease reaped, as a crash between the stage write and the host's
    // `jobTransport.fail` leaves it.
    for (let attempt = 1; attempt <= executed; attempt++) {
      const job = (await ports.jobTransport.dequeue())!;
      expect(job.attempt).toBe(attempt);
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: workflow.id,
        stageId: "s",
        config: {},
        attempt,
        maxAttempts: budget,
        idempotencyKey: `job:${job.jobId}:attempt:${attempt}`,
      });
      await sleep(20);
      await expect(
        kernel.dispatch({ type: "lease.reapStale", staleThresholdMs: 0 }),
      ).resolves.toMatchObject({ released: 1 });
    }
    expect(seen).toEqual({ bodies: executed, receipts: 1 });
    const stage = (await ports.persistence.getStage(workflowRunId, "s"))!;
    expect(stage.status).toBe("FAILED");
    const ledger = await ports.stepLedger!.list(stage.id);
    const events = async () =>
      (await ports.persistence.getUnpublishedOutboxEvents(1000))
        .filter((row) => row.workflowRunId === workflowRunId)
        .map((row) => row.eventType);
    const eventsBefore = await events();

    const job = (await ports.jobTransport.dequeue())!;
    expect(job.attempt).toBe(executed + 1);
    const outcome = await executeJobWithHeartbeat(kernel, {
      jobTransport: ports.jobTransport,
      job: {
        jobId: job.jobId,
        workflowRunId,
        workflowId: workflow.id,
        stageId: "s",
        attempt: job.attempt,
        maxAttempts: budget,
        payload: job.payload,
        startedAt: job.startedAt,
      },
    });

    expect(outcome).toMatchObject({
      outcome: "failed",
      error: stage.errorMessage,
      willRetry: false,
    });
    // No step body ran and nothing the first deliveries wrote changed.
    expect(seen).toEqual({ bodies: executed, receipts: 1 });
    expect(await ports.persistence.getStage(workflowRunId, "s")).toEqual(stage);
    expect(await ports.stepLedger!.list(stage.id)).toEqual(ledger);
    // The job is failed, and the run fails once with the stage's error; no
    // stage event repeats.
    expect(
      (await ports.jobTransport.getJobsByWorkflowRun(workflowRunId))[0]?.status,
    ).toBe("FAILED");
    expect((await ports.persistence.getRun(workflowRunId))?.status).toBe(
      "FAILED",
    );
    expect((await events()).slice(eventsBefore.length)).toEqual([
      "workflow:failed",
    ]);
    // No retry is scheduled, whatever budget the queue still holds.
    await expect(ports.jobTransport.dequeue()).resolves.toBeNull();
  });

  /** A run whose only attempt fails the stage for good, acknowledged. */
  async function failedRun() {
    const { workflow, seen } = receiptWorkflow("rerun", (entry) =>
      entry === 1 ? ordinary() : undefined,
    );
    const kernel = createKernel({
      ...ports,
      eventSink: new CollectingEventSink(),
      clock: { now: () => new Date() },
      registry: { getWorkflow: () => workflow },
    });
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      workflowId: workflow.id,
      input: {},
      idempotencyKey: crypto.randomUUID(),
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    const deliver = async () => {
      const job = (await ports.jobTransport.dequeue())!;
      return executeJobWithHeartbeat(kernel, {
        jobTransport: ports.jobTransport,
        job: {
          jobId: job.jobId,
          workflowRunId,
          workflowId: workflow.id,
          stageId: "s",
          attempt: job.attempt,
          maxAttempts: 1,
          payload: job.payload,
          startedAt: job.startedAt,
        },
      });
    };
    await expect(deliver()).resolves.toMatchObject({ outcome: "failed" });
    expect((await ports.persistence.getRun(workflowRunId))?.status).toBe(
      "FAILED",
    );
    expect((await ports.persistence.getStage(workflowRunId, "s"))?.status).toBe(
      "FAILED",
    );
    return { kernel, workflowRunId, seen, deliver };
  }

  it.each([
    ["run.redrive from the last failure", { type: "run.redrive" }],
    [
      "run.redrive from the start",
      { type: "run.redrive", from: { kind: "start" } },
    ],
    [
      "run.redrive from the stage",
      { type: "run.redrive", from: { kind: "stage", stageId: "s" } },
    ],
    ["run.rerunFrom", { type: "run.rerunFrom", fromStageId: "s" }],
  ] as const)("%s still runs a failed stage through a delivered job", async (_name, command) => {
    const { kernel, workflowRunId, seen, deliver } = await failedRun();

    await kernel.dispatch({ ...command, workflowRunId } as never);
    // The command reopened the stage and queued a job of its own.
    await expect(deliver()).resolves.toMatchObject({ outcome: "completed" });

    expect(seen.bodies).toBe(2);
    expect((await ports.persistence.getRun(workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });

  it("still starts a stage again when a caller dispatches it without an attempt", async () => {
    const { workflow, seen } = receiptWorkflow("rerun", ordinary);
    const kernel = createKernel({
      ...ports,
      eventSink: new CollectingEventSink(),
      clock: { now: () => new Date() },
      registry: { getWorkflow: () => workflow },
    });
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      workflowId: workflow.id,
      input: {},
      idempotencyKey: crypto.randomUUID(),
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    const execute = () =>
      kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: workflow.id,
        stageId: "s",
        config: {},
      });

    await expect(execute()).resolves.toMatchObject({ outcome: "failed" });
    await expect(execute()).resolves.toMatchObject({ outcome: "failed" });
    expect(seen.bodies).toBe(2);
  });
});
