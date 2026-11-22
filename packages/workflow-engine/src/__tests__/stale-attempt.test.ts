/**
 * An attempt that was overtaken while its body ran (its run was cancelled and
 * a redrive or rerunFrom reopened the stage, with a job of its own) commits
 * nothing when the body settles: not the failure, the retry, the suspension
 * or the completion. Through kernel.dispatch and the host path both hosts
 * share, on the in-memory ports and, with SQLITE8_KERNEL_SQLITE=1 or
 * DATABASE_URL, on the Prisma ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../core/stage-factory.js";
import { WorkflowBuilder } from "../core/workflow.js";
import { executeJobWithHeartbeat } from "../kernel/helpers/host-support.js";
import { createKernel, type KernelConfig } from "../kernel/kernel.js";
import type { DequeueResult } from "../kernel/ports.js";
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
const budget = 3;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

const endings = {
  "fails for good": () => {
    throw z.number().safeParse("x").error;
  },
  "fails with a retry left": () => {
    throw new Error("provider unavailable");
  },
  completes: () => ({ output: { stale: true } }),
  suspends: (ctx: { step: { sleep(id: string, ms: number): Promise<void> } }) =>
    ctx.step.sleep("nap", 600_000),
} as const;

describe(`a stale attempt on ${realDatabase ? (sqlite ? "SQLite" : "Postgres") : "memory"}`, () => {
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
   * Entry 1 is the attempt that gets overtaken: it holds in its body until
   * `release`, then settles as `ending`. With `secondFails`, entry 2 fails
   * for good (the run ends FAILED before a rerunFrom). Later entries succeed.
   */
  async function overtaken(ending: keyof typeof endings, secondFails = false) {
    const held = gate();
    const release = gate();
    let entries = 0;
    const workflow = new WorkflowBuilder(
      "stale-attempt",
      "Stale attempt",
      "stale-attempt",
      schema,
      z.any(),
    )
      .pipe(
        defineStage({
          id: "s",
          name: "S",
          schemas: { input: schema, output: z.any(), config: schema },
          async execute(ctx) {
            const entry = ++entries;
            await ctx.step.run("receipt", async () => entry);
            if (entry === 1) {
              held.open();
              await release.opened;
              return (await endings[ending](ctx as never)) as never;
            }
            if (entry === 2 && secondFails) throw endings["fails for good"]();
            return { output: { entry } };
          },
        }),
      )
      .build();
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
    const deliver = (job: DequeueResult) =>
      executeJobWithHeartbeat(kernel, {
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
    const events = async () =>
      (await ports.persistence.getUnpublishedOutboxEvents(1000))
        .filter((row) => row.workflowRunId === workflowRunId)
        .map((row) => row.eventType);
    const first = (await ports.jobTransport.dequeue())!;
    const stale = deliver(first);
    await held.opened;
    return {
      kernel,
      workflowRunId,
      deliver,
      events,
      stale,
      release: release.open,
      entries: () => entries,
    };
  }

  const redrives = [
    ["a redrive of the stage", { kind: "stage", stageId: "s" }],
    ["a redrive from the last failure", { kind: "lastFailure" }],
  ] as const;

  it.each(
    Object.keys(endings).flatMap((ending) =>
      redrives.map(([name, from]) => [ending, name, from] as const),
    ),
  )("commits nothing when it %s after a cancel and %s", async (ending, _name, from) => {
    const t = await overtaken(ending as keyof typeof endings);
    await t.kernel.dispatch({
      type: "run.cancel",
      workflowRunId: t.workflowRunId,
    });
    await t.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: t.workflowRunId,
      from,
    });
    const redriven = (await ports.jobTransport.dequeue())!;
    const stage = (await ports.persistence.getStage(t.workflowRunId, "s"))!;
    expect(stage.status).toBe("PENDING");
    const eventsBefore = await t.events();

    t.release();
    await expect(t.stale).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("result discarded"),
    });

    // The overtaken attempt wrote nothing: the reopened stage, the run and
    // the redrive's job stand as the redrive left them.
    expect(await ports.persistence.getStage(t.workflowRunId, "s")).toEqual(
      stage,
    );
    expect(await t.events()).toEqual(eventsBefore);
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "RUNNING",
    );
    expect(
      (await ports.jobTransport.getJobsByWorkflowRun(t.workflowRunId))[0]
        ?.status,
    ).toBe("RUNNING");

    // The redrive's job runs the stage and recovers the run.
    await expect(t.deliver(redriven)).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(t.entries()).toBe(2);
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });

  it.each(
    Object.keys(endings),
  )("commits nothing when it %s after rerunFrom reopened the stage", async (ending) => {
    const t = await overtaken(ending as keyof typeof endings, true);
    // A lost lease hands the job to a second attempt, which fails the run.
    await sleep(20);
    await expect(
      t.kernel.dispatch({ type: "lease.reapStale", staleThresholdMs: 0 }),
    ).resolves.toMatchObject({ released: 1 });
    const second = (await ports.jobTransport.dequeue())!;
    await expect(t.deliver(second)).resolves.toMatchObject({
      outcome: "failed",
      willRetry: false,
    });
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "FAILED",
    );
    await t.kernel.dispatch({
      type: "run.rerunFrom",
      workflowRunId: t.workflowRunId,
      fromStageId: "s",
    });
    const rerun = (await ports.jobTransport.dequeue())!;
    const stage = (await ports.persistence.getStage(t.workflowRunId, "s"))!;
    expect(stage.status).toBe("PENDING");
    const eventsBefore = await t.events();

    t.release();
    await expect(t.stale).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("result discarded"),
    });

    expect(await ports.persistence.getStage(t.workflowRunId, "s")).toEqual(
      stage,
    );
    expect(await t.events()).toEqual(eventsBefore);
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "RUNNING",
    );
    await expect(t.deliver(rerun)).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(t.entries()).toBe(3);
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });

  it("keeps the result of an attempt whose stage a signal woke while it ran", async () => {
    const t = await overtaken("completes");
    // The wake moves `nextPollAt` on the RUNNING stage and so its version, but
    // not the claim: the attempt is still the stage's attempt.
    await t.kernel.dispatch({
      type: "step.signal",
      workflowRunId: t.workflowRunId,
      stageId: "s",
      stepId: "approval",
      payload: "go",
    });

    t.release();

    await expect(t.stale).resolves.toMatchObject({ outcome: "completed" });
    expect(
      (await ports.persistence.getStage(t.workflowRunId, "s"))?.status,
    ).toBe("COMPLETED");
    expect((await ports.persistence.getRun(t.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });
});
