/**
 * InMemoryWorkflowPersistence.withTransaction rolls back on a throw, as the
 * Prisma adapter does, and leaves writes made outside the transaction alone.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { executeJobWithHeartbeat } from "../../kernel/helpers/host-support.js";
import { createKernel } from "../../kernel/kernel.js";
import {
  CollectingEventSink,
  InMemoryBlobStore,
} from "../../kernel/testing/index.js";
import { StaleVersionError } from "../../persistence/interface.js";
import {
  InMemoryJobQueue,
  InMemoryStepLedger,
  InMemoryWorkflowPersistence,
} from "../../testing/index.js";

const schema = z.object({});

describe("InMemoryWorkflowPersistence transactions", () => {
  it("undoes every write of a transaction that throws, and only those", async () => {
    const persistence = new InMemoryWorkflowPersistence();
    const run = await persistence.createRun({
      workflowId: "w",
      workflowName: "W",
      workflowType: "w",
      input: {},
    });
    const stage = await persistence.createStage({
      workflowRunId: run.id,
      stageId: "s",
      stageName: "S",
      stageNumber: 1,
      executionGroup: 1,
      status: "RUNNING",
    });

    await expect(
      persistence.withTransaction(async (tx) => {
        await tx.acquireIdempotencyKey("k", "c");
        await tx.updateStage(stage.id, { nextPollAt: new Date() });
        await tx.appendOutboxEvents([
          {
            workflowRunId: run.id,
            eventType: "e",
            payload: {},
            causationId: "c",
            occurredAt: new Date(),
          },
        ]);
        // Outside the transaction, while it is open.
        await persistence.updateRun(run.id, { status: "RUNNING" });
        await tx.updateStage(stage.id, {
          status: "COMPLETED",
          expectedVersion: stage.version,
        });
      }),
    ).rejects.toBeInstanceOf(StaleVersionError);

    expect(await persistence.getStage(run.id, "s")).toEqual(stage);
    expect(await persistence.getUnpublishedOutboxEvents(10)).toEqual([]);
    expect((await persistence.acquireIdempotencyKey("k", "c")).status).toBe(
      "acquired",
    );
    expect((await persistence.getRun(run.id))?.status).toBe("RUNNING");
  });

  it("lets a later signal wake the stage after a wake transaction failed", async () => {
    const persistence = new InMemoryWorkflowPersistence();
    const jobTransport = new InMemoryJobQueue();
    const workflow = new WorkflowBuilder("sw", "SW", "sw", schema, z.any())
      .pipe(
        defineStage({
          id: "s",
          name: "S",
          schemas: { input: schema, output: z.any(), config: schema },
          async execute(ctx) {
            return {
              output: await ctx.step.waitForSignal("approval", {
                timeout: "1h",
              }),
            };
          },
        }),
      )
      .build();
    const kernel = createKernel({
      persistence,
      jobTransport,
      stepLedger: new InMemoryStepLedger(),
      blobStore: new InMemoryBlobStore(),
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
    const job = (await jobTransport.dequeue())!;
    await expect(
      executeJobWithHeartbeat(kernel, { jobTransport, job }),
    ).resolves.toMatchObject({ outcome: "suspended" });

    // The wake's outbox write fails once, inside its transaction.
    const append = InMemoryWorkflowPersistence.prototype.appendOutboxEvents;
    let fail = true;
    persistence.appendOutboxEvents = async function (this: never, events) {
      if (fail) {
        fail = false;
        throw new Error("outbox unavailable");
      }
      return append.call(this, events);
    };
    const signal = () =>
      kernel.dispatch({
        type: "step.signal",
        workflowRunId,
        stageId: "s",
        stepId: "approval",
        payload: "go",
      });
    await expect(signal()).rejects.toThrow("outbox unavailable");
    await expect(signal()).resolves.toMatchObject({ signalled: true });
    await expect(signal()).resolves.toMatchObject({ alreadyCompleted: true });
    const signalled = (
      await persistence.getUnpublishedOutboxEvents(100)
    ).filter((row) => row.eventType === "step:signalled");
    expect(signalled).toHaveLength(1);
    expect(
      (await persistence.getStage(workflowRunId, "s"))!.nextPollAt!.getTime(),
    ).toBeLessThan(Date.now() + 60_000);
  });
});
