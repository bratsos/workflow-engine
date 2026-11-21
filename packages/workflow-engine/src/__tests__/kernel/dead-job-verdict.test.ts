/**
 * The shared host path acknowledges a job as dead only when `job.execute`
 * says its own workflow, stage or run is missing: by the error's brand or
 * name and the job's own target, never by text alone. An infrastructure
 * error that reads the same way, or a nested dispatch's missing target, is
 * an ordinary failure the host must not swallow.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../../core/workflow.js";
import { executeJobWithHeartbeat } from "../../kernel/helpers/host-support.js";
import { createKernel, type Kernel } from "../../kernel/kernel.js";
import type { ActivityExecutor } from "../../kernel/ports.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
} from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

const workflow = defineWorkflow("dead-verdict", { input: z.object({}) })
  .stage("only", {
    schemas: {
      input: z.object({}),
      output: z.object({}),
      config: z.object({}),
    },
    async execute() {
      return { output: {} };
    },
  })
  .build();

async function claimedJob(executor?: ActivityExecutor) {
  const persistence = new InMemoryWorkflowPersistence();
  const jobTransport = new InMemoryJobQueue("w");
  const kernel = createKernel({
    persistence,
    jobTransport,
    blobStore: new InMemoryBlobStore(),
    clock: new FakeClock(new Date()),
    eventSink: new CollectingEventSink(),
    registry: {
      getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
    },
    ...(executor ? { executor } : {}),
  });
  await kernel.dispatch({
    type: "run.create",
    idempotencyKey: "dead-verdict",
    workflowId: workflow.id,
    input: {},
  });
  await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
  const job = (await jobTransport.dequeue())!;
  const message = {
    jobId: job.jobId,
    workflowRunId: job.workflowRunId,
    workflowId: job.workflowId,
    stageId: job.stageId,
    attempt: job.attempt,
    payload: job.payload,
  };
  const status = async () =>
    (await jobTransport.getJobsByWorkflowRun(job.workflowRunId)).find(
      (row) => row.id === job.jobId,
    )?.status;
  return { kernel, jobTransport, message, status };
}

describe("dead job verdict", () => {
  it("does not take an executor error that reads like a missing workflow for a dead job", async () => {
    const infra = new Error(
      "Workflow adapter-cache not found in registry; refresh and retry",
    );
    const { kernel, jobTransport, message, status } = await claimedJob({
      run: async () => {
        throw infra;
      },
    });

    await expect(
      executeJobWithHeartbeat(kernel, { jobTransport, job: message }),
    ).rejects.toBe(infra);
    expect(await status()).toBe("RUNNING");
  });

  it("still acknowledges a job whose run no longer exists as dead", async () => {
    const { kernel, jobTransport, message, status } = await claimedJob();

    const outcome = await executeJobWithHeartbeat(kernel, {
      jobTransport,
      job: { ...message, workflowRunId: "gone" },
    });

    expect(outcome).toMatchObject({ outcome: "failed", dead: true });
    expect(outcome.error).toBe("WorkflowRun gone not found");
    expect(await status()).toBe("FAILED");
  });

  it("acknowledges the missing run when a dispatcher carries the error by name and message", async () => {
    const { kernel, jobTransport, message, status } = await claimedJob();
    // A decorator that transports dispatch errors keeps name and message only.
    const serializing = {
      ...kernel,
      dispatch: (async (command: Parameters<typeof kernel.dispatch>[0]) => {
        try {
          return await kernel.dispatch(command);
        } catch (error) {
          const { name, message } = JSON.parse(
            JSON.stringify({
              name: (error as Error).name,
              message: (error as Error).message,
            }),
          );
          throw Object.assign(new Error(message), { name });
        }
      }) as typeof kernel.dispatch,
    };

    const outcome = await executeJobWithHeartbeat(serializing, {
      jobTransport,
      job: { ...message, workflowRunId: "gone" },
    });

    expect(outcome).toMatchObject({ outcome: "failed", dead: true });
    expect(await status()).toBe("FAILED");
  });

  it("does not take a missing target of a dispatch made inside the job for its own", async () => {
    let inner: Kernel | undefined;
    const { kernel, jobTransport, message, status } = await claimedJob({
      // A custom executor that dispatches another job, whose run is gone.
      run: async () =>
        inner!.dispatch({
          type: "job.execute",
          workflowRunId: "another-run",
          workflowId: workflow.id,
          stageId: "only",
          config: {},
        }) as never,
    });
    inner = kernel;

    const failure = await executeJobWithHeartbeat(kernel, {
      jobTransport,
      job: message,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "JobTargetMissingError",
      message: "WorkflowRun another-run not found",
    });
    expect(await status()).toBe("RUNNING");
  });
});
