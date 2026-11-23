/**
 * `host.wake()`: look for work now instead of at the next timer.
 *
 * Every interval below is 60 s, so a run that finishes within a couple of
 * seconds was started by the wake, not by a timer. The host, kernel, job
 * queue and persistence are the real ones; nothing fakes time.
 */

import { defineStage, WorkflowBuilder } from "@bratsos/workflow-engine";
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
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createNodeHost, type NodeHost } from "../host.js";

const schema = z.object({ data: z.string() });
const outputSchema = z.object({ result: z.string() });

const workflow = new WorkflowBuilder(
  "wake-workflow",
  "Wake Workflow",
  "Test",
  schema,
  outputSchema,
)
  .pipe(
    defineStage({
      id: "stage-1",
      name: "Stage 1",
      schemas: { input: schema, output: outputSchema, config: z.object({}) },
      async execute(ctx) {
        return { output: { result: ctx.input.data.toUpperCase() } };
      },
    }),
  )
  .build();

function createEnv() {
  const persistence = new InMemoryWorkflowPersistence();
  const jobTransport = new InMemoryJobQueue("wake-worker");
  const kernel = createKernel({
    persistence,
    blobStore: new InMemoryBlobStore(),
    jobTransport,
    eventSink: new CollectingEventSink(),
    clock: new FakeClock(),
    registry: {
      getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
    },
  });
  const calls = { dequeues: 0, claims: 0 };
  const dequeue = jobTransport.dequeue.bind(jobTransport);
  const dispatch = kernel.dispatch.bind(kernel);
  // One gate per loop: a pass that reaches it keeps running until released.
  const gate: { dequeue?: Promise<void>; claim?: Promise<void> } = {};
  jobTransport.dequeue = async (...args) => {
    calls.dequeues++;
    await gate.dequeue;
    return dequeue(...args);
  };
  kernel.dispatch = async (command) => {
    if (command.type === "run.claimPending") {
      calls.claims++;
      await gate.claim;
    }
    return dispatch(command);
  };
  return { kernel, persistence, jobTransport, calls, gate };
}

function holdGate() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(10);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("NodeHost.wake", () => {
  let host: NodeHost | null = null;

  afterEach(async () => {
    await host?.stop();
    host = null;
  });

  const startIdleHost = async (env: ReturnType<typeof createEnv>) => {
    host = createNodeHost({
      kernel: env.kernel,
      jobTransport: env.jobTransport,
      workerId: "wake-worker",
      orchestrationIntervalMs: 60_000,
      jobPollIntervalMs: 60_000,
      postJobYieldMs: 0,
    });
    await host.start();
    // The start tick has run and the job loop is parked in its 60 s wait.
    await waitFor(
      () =>
        host!.getStats().orchestrationTicks === 1 && env.calls.dequeues === 1,
    );
    await sleep(50);
    return host;
  };

  it("starts a run created while the host is idle, well before either interval", async () => {
    const env = createEnv();
    const started = await startIdleHost(env);
    const { workflowRunId } = await env.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "wake-1",
      workflowId: workflow.id,
      input: { data: "hello" },
    });
    await sleep(150);
    expect((await env.persistence.getRun(workflowRunId))?.status).toBe(
      "PENDING",
    );

    const at = Date.now();
    started.wake();
    await waitFor(
      async () =>
        (await env.persistence.getRun(workflowRunId))?.status === "COMPLETED",
    );
    expect(Date.now() - at).toBeLessThan(3_000);
  });

  it("follows a burst of wakes during a job pass with exactly one more pass", async () => {
    const env = createEnv();
    const started = await startIdleHost(env);
    const pass = holdGate();
    env.gate.dequeue = pass.held;

    started.wake();
    await waitFor(() => env.calls.dequeues === 2);
    // Let the tick that wake() started finish: it wakes the job loop again.
    await sleep(100);
    for (let i = 0; i < 5; i++) started.wake();
    await sleep(100);
    expect(env.calls.dequeues).toBe(2);
    pass.release();
    env.gate.dequeue = undefined;

    await waitFor(() => env.calls.dequeues === 3);
    await sleep(200);
    expect(env.calls.dequeues).toBe(3);
  });

  it("follows a burst of wakes during a tick with exactly one more tick", async () => {
    const env = createEnv();
    const pass = holdGate();
    env.gate.claim = pass.held;
    host = createNodeHost({
      kernel: env.kernel,
      jobTransport: env.jobTransport,
      workerId: "wake-worker",
      orchestrationIntervalMs: 60_000,
      jobPollIntervalMs: 60_000,
      postJobYieldMs: 0,
    });
    await host.start();
    await waitFor(() => env.calls.claims === 1);

    for (let i = 0; i < 5; i++) host.wake();
    await sleep(100);
    expect(env.calls.claims).toBe(1);
    pass.release();

    await waitFor(() => env.calls.claims === 2);
    await sleep(200);
    expect(env.calls.claims).toBe(2);
    expect(host.getStats().orchestrationTicks).toBe(2);
  });

  it("does nothing before start() or after stop()", async () => {
    const env = createEnv();
    host = createNodeHost({
      kernel: env.kernel,
      jobTransport: env.jobTransport,
      workerId: "wake-worker",
      orchestrationIntervalMs: 60_000,
      jobPollIntervalMs: 60_000,
      postJobYieldMs: 0,
    });
    host.wake();
    await sleep(100);
    expect(env.calls).toEqual({ dequeues: 0, claims: 0 });

    await host.start();
    await waitFor(() => env.calls.dequeues === 1 && env.calls.claims === 1);
    await sleep(50);
    // The job loop leaves its 60 s wait when the host stops.
    const at = Date.now();
    await host.stop();
    expect(Date.now() - at).toBeLessThan(2_000);

    const before = { ...env.calls };
    host.wake();
    await sleep(200);
    expect(env.calls).toEqual(before);
    expect(host.getStats().isRunning).toBe(false);
  });
});
