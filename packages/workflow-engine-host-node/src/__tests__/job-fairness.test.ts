/**
 * Post-job yield: fairness across workers, without serialising a backlog.
 *
 * The host that completes a job is the one that dispatches
 * `run.transition`, so it enqueues the next stage of that run in-process
 * and used to be back at `dequeue()` microseconds later while every other
 * worker was still parked in its `jobPollIntervalMs` timer — a sequential
 * pipeline ran end-to-end on one worker however many were alive. The loop
 * now takes a randomised pause after a completed job, skipped while it is
 * draining work from other runs.
 *
 * `Math.random` is stubbed to 1 throughout so "a uniform draw over
 * [0, postJobYieldMs)" becomes exactly `postJobYieldMs` and the timings
 * below are deterministic. No engine or host code path uses `Math.random`
 * for anything else.
 */

import type { Workflow } from "@bratsos/workflow-engine";
import { defineStage, WorkflowBuilder } from "@bratsos/workflow-engine";
import type { JobTransport } from "@bratsos/workflow-engine/kernel";
import { createKernel } from "@bratsos/workflow-engine/kernel";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
} from "@bratsos/workflow-engine/kernel/testing";
import {
  InMemoryJobQueue,
  InMemoryWorkflowPersistence,
} from "@bratsos/workflow-engine/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createNodeHost, type NodeHost } from "../host.js";

const inSchema = z.object({ data: z.string() });
const outSchema = z.object({ result: z.string() });

function firstStage(id: string) {
  return defineStage({
    id,
    name: id,
    schemas: { input: inSchema, output: outSchema, config: z.object({}) },
    async execute(ctx) {
      return { output: { result: ctx.input.data } };
    },
  });
}

function chainedStage(id: string) {
  return defineStage({
    id,
    name: id,
    schemas: { input: outSchema, output: outSchema, config: z.object({}) },
    async execute(ctx) {
      return { output: { result: `${ctx.input.result}.${id}` } };
    },
  });
}

function pipeline(id: string, stages: number): Workflow<any, any> {
  let builder = new WorkflowBuilder(id, id, "Test", inSchema, outSchema).pipe(
    firstStage("stage-1"),
  ) as any;
  for (let i = 2; i <= stages; i++) {
    builder = builder.pipe(chainedStage(`stage-${i}`));
  }
  return builder.build();
}

function createEnv(workflows: Workflow<any, any>[]) {
  const persistence = new InMemoryWorkflowPersistence();
  const jobQueue = new InMemoryJobQueue("shared-queue");
  const registry = new Map(workflows.map((w) => [w.id, w]));
  const kernel = createKernel({
    persistence,
    blobStore: new InMemoryBlobStore(),
    jobTransport: jobQueue,
    eventSink: new CollectingEventSink(),
    clock: new FakeClock(),
    registry: { getWorkflow: (id) => registry.get(id) },
  });
  return { kernel, persistence, jobQueue };
}

/**
 * A `JobTransport` view of the shared queue that records which host's
 * loop claimed each stage. `InMemoryJobQueue` stamps its own single
 * worker id on every row, so the job row cannot answer this on its own.
 */
function transportFor(
  base: InMemoryJobQueue,
  hostId: string,
  claims: Array<{ stageId: string; hostId: string }>,
): JobTransport {
  return {
    enqueueParallel: (jobs) => base.enqueueParallel(jobs),
    deleteByRunAndStages: (runId, stageIds) =>
      base.deleteByRunAndStages(runId, stageIds),
    dequeue: async () => {
      const job = await base.dequeue();
      if (job) claims.push({ stageId: job.stageId, hostId });
      return job;
    },
    complete: (jobId) => base.complete(jobId),
    suspend: (jobId, at) => base.suspend(jobId, at),
    fail: (jobId, error, retry) => base.fail(jobId, error, retry),
    releaseStaleJobs: (ms) => base.releaseStaleJobs(ms),
    cancelByRun: (runId) => base.cancelByRun(runId),
    getJobsByWorkflowRun: (runId) => base.getJobsByWorkflowRun(runId),
    touchJob: (jobId) => base.touchJob(jobId),
  };
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("NodeHost post-job yield", () => {
  const hosts: NodeHost[] = [];

  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(1);
  });

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.stop();
    vi.restoreAllMocks();
  });

  it("lets a second live worker take over a multi-stage run", async () => {
    const workflow = pipeline("three-stage", 3);
    const { kernel, persistence, jobQueue } = createEnv([workflow]);
    const claims: Array<{ stageId: string; hostId: string }> = [];

    for (const hostId of ["host-a", "host-b"]) {
      const host = createNodeHost({
        kernel,
        jobTransport: transportFor(jobQueue, hostId, claims),
        workerId: hostId,
        orchestrationIntervalMs: 25,
        jobPollIntervalMs: 5,
        // Long enough that the other host — polling every 5ms — is
        // certain to be the one that picks up the stage this host just
        // enqueued.
        postJobYieldMs: 150,
      });
      hosts.push(host);
      await host.start();
    }

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "fairness-1",
      workflowId: "three-stage",
      input: { data: "hello" },
    });

    await waitFor(async () => {
      const done = await persistence.getRunsByStatus("COMPLETED");
      return done.length > 0;
    });

    expect(claims).toHaveLength(3);
    // Each stage went to the host that was *not* pausing after the stage
    // before it, so the run is not pinned to one worker.
    expect(new Set(claims.map((c) => c.hostId)).size).toBe(2);
    expect(claims[0]!.hostId).not.toBe(claims[1]!.hostId);
    expect(claims[1]!.hostId).not.toBe(claims[2]!.hostId);
  });

  it("does not pause between backlog jobs from other runs", async () => {
    const workflow = pipeline("single-stage", 1);
    const { kernel, persistence, jobQueue } = createEnv([workflow]);

    for (let i = 0; i < 5; i++) {
      await kernel.dispatch({
        type: "run.create",
        idempotencyKey: `backlog-${i}`,
        workflowId: "single-stage",
        input: { data: `run-${i}` },
      });
    }

    const host = createNodeHost({
      kernel,
      jobTransport: jobQueue,
      workerId: "solo",
      orchestrationIntervalMs: 25,
      jobPollIntervalMs: 5,
      postJobYieldMs: 200,
    });
    hosts.push(host);

    const started = Date.now();
    await host.start();
    await waitFor(async () => {
      const done = await persistence.getRunsByStatus("COMPLETED");
      return done.length === 5;
    });
    const elapsed = Date.now() - started;

    expect(host.getStats().jobsProcessed).toBe(5);
    // One pause at most (before the loop sees the second run's job and
    // recognises a backlog). Pausing after every job would cost 1000ms.
    expect(elapsed).toBeLessThan(700);
  });

  it("postJobYieldMs: 0 disables the pause entirely", async () => {
    /** Time a solo host through one 3-stage run at the given yield. */
    async function runPipeline(postJobYieldMs: number): Promise<number> {
      const workflow = pipeline(`three-stage-${postJobYieldMs}`, 3);
      const { kernel, persistence, jobQueue } = createEnv([workflow]);
      await kernel.dispatch({
        type: "run.create",
        idempotencyKey: `yield-${postJobYieldMs}`,
        workflowId: workflow.id,
        input: { data: "hello" },
      });

      const host = createNodeHost({
        kernel,
        jobTransport: jobQueue,
        workerId: "solo",
        orchestrationIntervalMs: 25,
        jobPollIntervalMs: 5,
        postJobYieldMs,
      });
      hosts.push(host);

      const started = Date.now();
      await host.start();
      await waitFor(async () => {
        const done = await persistence.getRunsByStatus("COMPLETED");
        return done.length > 0;
      });
      const elapsed = Date.now() - started;
      expect(host.getStats().jobsProcessed).toBe(3);
      return elapsed;
    }

    // A solo host follows the run it keeps advancing, so it pauses
    // between all three stages: ~400ms of pure latency at 200ms...
    const paused = await runPipeline(200);
    expect(paused).toBeGreaterThan(350);

    // ...and none at all at 0.
    const unpaused = await runPipeline(0);
    expect(unpaused).toBeLessThan(200);
  });
});
