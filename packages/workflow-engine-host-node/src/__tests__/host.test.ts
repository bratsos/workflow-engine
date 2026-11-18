/**
 * Node Host Integration Tests
 *
 * Tests the full host lifecycle using in-memory adapters: create a run,
 * start the host, verify the workflow completes end-to-end.
 */

import type { Workflow } from "@bratsos/workflow-engine";
import { defineStage, WorkflowBuilder } from "@bratsos/workflow-engine";
import {
  createKernel,
  type Kernel,
  type MaintenanceTickCounts,
} from "@bratsos/workflow-engine/kernel";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
} from "@bratsos/workflow-engine/kernel/testing";
import {
  InMemoryJobQueue,
  InMemoryWorkflowPersistence,
} from "@bratsos/workflow-engine/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createNodeHost, type NodeHost } from "../host.js";

// ============================================================================
// Test helpers
// ============================================================================

const schema = z.object({ data: z.string() });
const outputSchema = z.object({ result: z.string() });

function createPassthroughStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: { input: schema, output: outputSchema, config: z.object({}) },
    async execute(ctx) {
      return { output: { result: ctx.input.data.toUpperCase() } };
    },
  });
}

/** Stage that chains after a passthrough stage — accepts { result } and transforms it. */
function createChainedStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: {
      input: outputSchema,
      output: outputSchema,
      config: z.object({}),
    },
    async execute(ctx) {
      return { output: { result: ctx.input.result + "!" } };
    },
  });
}

function createSimpleWorkflow(): Workflow<any, any> {
  const stage = createPassthroughStage("stage-1");
  return new WorkflowBuilder(
    "test-workflow",
    "Test Workflow",
    "Test",
    schema,
    outputSchema,
  )
    .pipe(stage)
    .build();
}

function createTwoStageWorkflow(): Workflow<any, any> {
  const stage1 = createPassthroughStage("stage-1");
  const stage2 = createChainedStage("stage-2");
  return new WorkflowBuilder(
    "two-stage",
    "Two Stage",
    "Test",
    schema,
    outputSchema,
  )
    .pipe(stage1)
    .pipe(stage2)
    .build();
}

function createAsyncBatchWorkflow(): Workflow<any, any> {
  const stage = defineStage({
    id: "batch-stage",
    name: "Batch Stage",
    mode: "async-batch",
    schemas: { input: schema, output: outputSchema, config: z.object({}) },
    async execute() {
      return {
        suspended: true,
        state: {
          batchId: "batch-1",
          submittedAt: new Date(0).toISOString(),
          pollInterval: 1,
          maxWaitTime: 60_000,
        },
        pollConfig: {
          pollInterval: 1,
          maxWaitTime: 60_000,
          nextPollAt: new Date(0),
        },
      };
    },
    async checkCompletion() {
      return { ready: true, output: { result: "DONE" } };
    },
  });

  return new WorkflowBuilder(
    "async-batch",
    "Async Batch",
    "Test",
    schema,
    outputSchema,
  )
    .pipe(stage)
    .build();
}

function createTestEnv(workflows: Workflow<any, any>[] = []) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const clock = new FakeClock();

  const registry = new Map<string, Workflow<any, any>>();
  for (const w of workflows) {
    registry.set(w.id, w);
  }

  const kernel = createKernel({
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    clock,
    registry: {
      getWorkflow: (id) => registry.get(id),
      listWorkflows: () => Array.from(registry.values()),
    },
  });

  return { kernel, persistence, blobStore, jobTransport, eventSink, clock };
}

/** Wait for a condition to become true, polling at `intervalMs`. */
async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ============================================================================
// Tests
// ============================================================================

describe("NodeHost", () => {
  let host: NodeHost | null = null;

  afterEach(async () => {
    if (host) {
      await host.stop();
      host = null;
    }
  });

  it("processes a single-stage workflow end-to-end", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    // Create a run
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "e2e-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Start host
    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
      staleLeaseThresholdMs: 60_000,
    });
    await host.start();

    // Wait for completion
    await waitFor(async () => {
      const runs = await persistence.getRunsByStatus("COMPLETED");
      return runs.length > 0;
    });

    // Verify
    const completed = await persistence.getRunsByStatus("COMPLETED");
    expect(completed).toHaveLength(1);

    const stats = host.getStats();
    expect(stats.jobsProcessed).toBe(1);
    expect(stats.isRunning).toBe(true);
    expect(stats.eventSink.status).toBe("healthy");
  });

  it("purges finished runs past the retention age when retention is set", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "retention-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
      staleLeaseThresholdMs: 60_000,
      retention: { olderThanMs: 0 },
    });
    await host.start();

    // The run completes on the job loop; the next orchestration tick's
    // run.purge deletes it, since it is past a zero retention age.
    await waitFor(
      async () => (await persistence.getRun(workflowRunId)) === null,
    );

    expect(host.getStats().jobsProcessed).toBe(1);
    expect(await persistence.getStagesByRun(workflowRunId)).toEqual([]);
  });

  it("names the event sink degraded and still runs the workflow to completion", async () => {
    const workflow = createSimpleWorkflow();
    // Built by hand rather than through createTestEnv: this is the one test
    // whose sink is not a CollectingEventSink.
    const persistence = new InMemoryWorkflowPersistence();
    const jobTransport = new InMemoryJobQueue("test-worker");
    const kernel = createKernel({
      persistence,
      blobStore: new InMemoryBlobStore(),
      jobTransport,
      eventSink: {
        async emit() {
          throw new Error("sink down");
        },
      },
      clock: new FakeClock(),
      registry: {
        getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
      },
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "sink-down-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
      staleLeaseThresholdMs: 60_000,
      flushOutboxOnStop: false,
    });
    await host.start();

    // The poller, not the sink, is what advances a run: it completes.
    await waitFor(async () => {
      const runs = await persistence.getRunsByStatus("COMPLETED");
      return runs.length > 0;
    });
    // ...and the state is named and readable from the host's status.
    await waitFor(async () => host!.getStats().eventSink.status === "degraded");

    const stats = host.getStats();
    expect(stats.eventSink.status).toBe("degraded");
    expect(stats.eventSink.consecutiveFailures).toBeGreaterThan(0);
    expect(stats.eventSink.lastError).toContain("sink down");
    expect(stats.eventSink.since).not.toBeNull();
  });

  it("processes a two-stage workflow end-to-end", async () => {
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "e2e-2",
      workflowId: "two-stage",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
    });
    await host.start();

    await waitFor(async () => {
      const runs = await persistence.getRunsByStatus("COMPLETED");
      return runs.length > 0;
    });

    const completed = await persistence.getRunsByStatus("COMPLETED");
    expect(completed).toHaveLength(1);

    // Both stages should have been processed
    const stats = host.getStats();
    expect(stats.jobsProcessed).toBe(2);
  });

  it("transitions runs after suspended stage resumes", async () => {
    const workflow = createAsyncBatchWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "async-batch-1",
      workflowId: "async-batch",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 20,
      jobPollIntervalMs: 20,
    });
    await host.start();

    await waitFor(async () => {
      const runs = await persistence.getRunsByStatus("COMPLETED");
      return runs.length > 0;
    });

    const completed = await persistence.getRunsByStatus("COMPLETED");
    expect(completed).toHaveLength(1);
  });

  it("stops gracefully", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, jobTransport } = createTestEnv([workflow]);

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
    });

    await host.start();
    expect(host.getStats().isRunning).toBe(true);

    await host.stop();
    expect(host.getStats().isRunning).toBe(false);
    expect(host.getStats().uptimeMs).toBe(0);
  });

  it("tracks orchestration ticks", async () => {
    const { kernel, jobTransport } = createTestEnv([]);

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 30,
      jobPollIntervalMs: 20,
    });

    await host.start();

    // Wait for a few ticks
    await new Promise((r) => setTimeout(r, 150));

    const stats = host.getStats();
    // Should have at least the immediate first tick plus a few more
    expect(stats.orchestrationTicks).toBeGreaterThanOrEqual(2);
    expect(stats.workerId).toBe("test-worker");
  });

  it("skips interval firings while a tick is in flight and waits for it on stop()", async () => {
    const { kernel, jobTransport } = createTestEnv([]);

    // Hold the first tick inside stage.pollSuspended until released, as a
    // replay that outlasts the interval would.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    let tickFinished = false;
    const slowKernel = {
      dispatch: async (command: Parameters<Kernel["dispatch"]>[0]) => {
        if (command.type === "stage.pollSuspended" && !held) {
          held = true;
          await gate;
        }
        const result = await kernel.dispatch(command as never);
        // run.reapStuck is the last command of a maintenance tick.
        if (command.type === "run.reapStuck") tickFinished = true;
        return result;
      },
    } as unknown as Kernel;

    host = createNodeHost({
      kernel: slowKernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 10,
      jobPollIntervalMs: 20,
    });

    await host.start();
    // Many interval firings elapse while the first tick is still held.
    await new Promise((r) => setTimeout(r, 100));
    expect(held).toBe(true);
    expect(host.getStats().orchestrationTicks).toBe(1);

    // stop() does not resolve until the in-flight tick has finished.
    let stopped = false;
    const stopping = host.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(false);
    expect(tickFinished).toBe(false);

    release();
    await stopping;
    expect(tickFinished).toBe(true);
    expect(host.getStats().orchestrationTicks).toBe(1);
  });

  it("calls onTick after every tick with that tick's counts", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, jobTransport } = createTestEnv([workflow]);
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "on-tick-1",
      workflowId: workflow.id,
      input: { data: "hello" },
    });

    const seen: MaintenanceTickCounts[] = [];
    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 20,
      jobPollIntervalMs: 20,
      onTick: (counts) => {
        seen.push(counts);
      },
    });
    await host.start();
    await waitFor(async () => seen.length >= 2);

    // The first tick claimed the run; the counts are the tick's own.
    expect(seen[0]?.claimed).toBe(1);
    expect(seen[0]?.eventSinkStatus).toBe("healthy");
    expect(seen[1]?.claimed).toBe(0);
  });

  it("logs a hook that throws or rejects and keeps ticking", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let calls = 0;
      host = createNodeHost({
        kernel,
        jobTransport,
        workerId: "test-worker",
        orchestrationIntervalMs: 20,
        jobPollIntervalMs: 20,
        onTick: async () => {
          calls++;
          if (calls === 1) throw new Error("hook threw");
          if (calls === 2) return Promise.reject(new Error("hook rejected"));
        },
      });
      await host.start();
      await waitFor(async () => calls >= 3);

      const messages = logged.mock.calls.map((args) => String(args[1]));
      expect(messages).toContain("Error: hook threw");
      expect(messages).toContain("Error: hook rejected");
      expect(host.getStats().orchestrationTicks).toBeGreaterThanOrEqual(3);
    } finally {
      logged.mockRestore();
    }
  });

  it("never holds a tick for a slow hook and never runs two at once", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let running = 0;
      let overlapped = false;
      let calls = 0;

      host = createNodeHost({
        kernel,
        jobTransport,
        workerId: "test-worker",
        orchestrationIntervalMs: 10,
        jobPollIntervalMs: 20,
        onTick: async () => {
          calls++;
          running++;
          if (running > 1) overlapped = true;
          if (calls === 1) await gate;
          running--;
        },
      });
      await host.start();
      // The first hook is held: ticks go on, the hook is not called again, and
      // the skip is logged once, not once per tick.
      await waitFor(async () => host!.getStats().orchestrationTicks >= 5);
      expect(calls).toBe(1);
      const skips = warned.mock.calls.filter((args) =>
        String(args[0]).includes("onTick hook is still running after"),
      );
      expect(skips).toHaveLength(1);
      expect(String(skips[0]?.[0])).toMatch(/running after \d+ ms/);

      release();
      await waitFor(async () => calls >= 3);
      expect(overlapped).toBe(false);
    } finally {
      warned.mockRestore();
    }
  });

  it("warns once for a hook that stays slower than the interval, and again after a call that was not skipped", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Every call takes about six intervals until `slow` is cleared.
      let slow = true;
      let calls = 0;
      host = createNodeHost({
        kernel,
        jobTransport,
        workerId: "test-worker",
        orchestrationIntervalMs: 10,
        jobPollIntervalMs: 20,
        onTick: async () => {
          calls++;
          if (slow) await new Promise((r) => setTimeout(r, 60));
        },
      });
      const skips = () =>
        warned.mock.calls.filter((args) =>
          String(args[0]).includes("onTick hook is still running after"),
        ).length;
      await host.start();
      // Four slow calls, each skipped by several ticks: one warning in all.
      await waitFor(async () => calls >= 4);
      expect(skips()).toBe(1);

      // A call that finishes before the next tick ends the episode ...
      slow = false;
      const before = calls;
      await waitFor(async () => calls >= before + 3);
      expect(skips()).toBe(1);

      // ... so the next slow call warns again.
      slow = true;
      await waitFor(async () => skips() === 2);
    } finally {
      warned.mockRestore();
    }
  });

  it("keeps ticking and claiming work while a hook never settles, and stop() is bounded", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let calls = 0;
      host = createNodeHost({
        kernel,
        jobTransport,
        workerId: "test-worker",
        orchestrationIntervalMs: 15,
        jobPollIntervalMs: 20,
        shutdownTimeoutMs: 400,
        onTick: () => {
          calls++;
          return new Promise<void>(() => {});
        },
      });
      await host.start();
      await waitFor(async () => calls === 1);

      // A run created after the hook hung is still claimed and finished.
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "hung-hook",
        workflowId: workflow.id,
        input: { data: "hello" },
      });
      await waitFor(
        async () =>
          (await persistence.getRun(workflowRunId))?.status === "COMPLETED",
      );
      expect(host.getStats().orchestrationTicks).toBeGreaterThanOrEqual(3);
      expect(calls).toBe(1);

      const started = Date.now();
      await host.stop();
      const took = Date.now() - started;
      host = null;
      expect(took).toBeGreaterThanOrEqual(350);
      expect(took).toBeLessThan(1_500);
    } finally {
      warned.mockRestore();
    }
  });

  it("starts no hook once stop() has begun and waits for one that is running", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    // Hold the first tick inside stage.pollSuspended, so stop() begins while
    // the tick is still running and the tick's hook would start after it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const slowKernel = {
      dispatch: async (command: Parameters<Kernel["dispatch"]>[0]) => {
        if (command.type === "stage.pollSuspended" && !held) {
          held = true;
          await gate;
        }
        return kernel.dispatch(command as never);
      },
    } as unknown as Kernel;
    let calls = 0;

    host = createNodeHost({
      kernel: slowKernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 1_000,
      jobPollIntervalMs: 20,
      onTick: () => {
        calls++;
      },
    });
    await host.start();
    await waitFor(async () => held);
    const stopping = host.stop();
    release();
    await stopping;
    host = null;
    expect(calls).toBe(0);

    // A hook that is already running is waited for: stop() resolves after it.
    let hookStarted = false;
    let hookDone = false;
    const waiting = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 1_000,
      jobPollIntervalMs: 20,
      onTick: async () => {
        hookStarted = true;
        await new Promise((r) => setTimeout(r, 150));
        hookDone = true;
      },
    });
    await waiting.start();
    await waitFor(async () => hookStarted);
    await waiting.stop();
    expect(hookDone).toBe(true);
  });

  it("makes a hook that awaits host.stop() wait for shutdownTimeoutMs", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    let stopMs = -1;
    let calls = 0;
    const self: NodeHost = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 15,
      jobPollIntervalMs: 20,
      shutdownTimeoutMs: 300,
      onTick: async () => {
        calls++;
        const started = Date.now();
        await self.stop();
        stopMs = Date.now() - started;
      },
    });
    await self.start();
    await waitFor(async () => stopMs >= 0);
    // stop() waited for the hook that was waiting for it, until the timeout.
    expect(stopMs).toBeGreaterThanOrEqual(250);
    expect(self.getStats().isRunning).toBe(false);
    expect(calls).toBe(1);
  });

  it("gives the hook its own copy of the counts", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    let mutated = false;
    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 20,
      jobPollIntervalMs: 20,
      onTick: (counts) => {
        counts.eventSinkStatus = "degraded";
        counts.eventsDeadLettered = 99;
        mutated = true;
      },
    });
    await host.start();
    await waitFor(async () => mutated);
    expect(host.getStats().eventSink.status).toBe("healthy");
    expect(host.getStats().eventSink.deadLettered).toBe(0);
  });

  // Every option that reaches setTimeout or setInterval is checked at
  // construction: Infinity, NaN, a negative number or more than 2**31 - 1 would
  // otherwise become a 1 ms timer.
  const TIMER_OPTIONS = [
    ["orchestrationIntervalMs", false],
    ["jobPollIntervalMs", false],
    ["postJobYieldMs", true],
    ["jobHeartbeatIntervalMs", false],
    ["outboxFlushTimeoutMs", false],
    ["shutdownTimeoutMs", false],
  ] as const;
  for (const [option, zeroIsOff] of TIMER_OPTIONS) {
    it(`rejects ${option} when a timer cannot honour it`, () => {
      const { kernel, jobTransport } = createTestEnv([]);
      const create = (value: unknown) =>
        createNodeHost({
          kernel,
          jobTransport,
          workerId: "test-worker",
          [option]: value,
        });
      const bad: unknown[] = [Infinity, -Infinity, NaN, -5, 2 ** 31, "5000"];
      // A pause drawn uniformly from [0, ms) may be fractional; the others are not.
      if (!zeroIsOff) bad.push(0, 0.5);
      for (const value of bad) {
        expect(() => create(value), `${option}: ${String(value)}`).toThrow(
          new RegExp(`${option} must be a number of milliseconds`),
        );
      }
      const unformattable = () => create(Object.create(null));
      expect(unformattable).toThrow(RangeError);
      expect(unformattable).toThrow(/got Unprintable error/);
      expect(() => create(1)).not.toThrow();
      expect(() => create(2 ** 31 - 1)).not.toThrow();
      if (zeroIsOff) expect(() => create(0)).not.toThrow();
    });
  }

  it("fails start() instead of running when the storage is refused", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    // What the SQLite adapters throw for a file another Prisma major wrote.
    const refusal = Object.assign(new Error("a foreign SQLite file"), {
      code: "SQLITE_DATE_STORAGE_MISMATCH",
    });
    (jobTransport as any).verifyStorage = async () => {
      throw refusal;
    };
    const dispatched = vi.spyOn(kernel, "dispatch");
    const refused = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 10,
      jobPollIntervalMs: 10,
    });
    await expect(refused.start()).rejects.toBe(refusal);
    await new Promise((r) => setTimeout(r, 60));
    // No tick, no job poll, no timer, no signal handler: nothing ran.
    expect(refused.getStats().isRunning).toBe(false);
    expect(refused.getStats().orchestrationTicks).toBe(0);
    expect(dispatched).not.toHaveBeenCalled();
    await refused.stop();
  });

  describe("stop() while start() is still checking the storage", () => {
    /** A storage check that settles when the test says so. */
    function gatedCheck(jobTransport: unknown) {
      const gates: { settle: (error?: Error) => void }[] = [];
      (jobTransport as any).verifyStorage = () =>
        new Promise<void>((resolve, reject) => {
          gates.push({
            settle: (error) => (error ? reject(error) : resolve()),
          });
        });
      return gates;
    }
    const signalListeners = () =>
      process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");

    it("installs nothing when the check settles after stop() returned", async () => {
      const { kernel, jobTransport } = createTestEnv([]);
      const gates = gatedCheck(jobTransport);
      const dispatched = vi.spyOn(kernel, "dispatch");
      const listeners = signalListeners();
      const h = createNodeHost({
        kernel,
        jobTransport,
        workerId: "test-worker",
        orchestrationIntervalMs: 10,
        jobPollIntervalMs: 5,
      });
      const boot = h.start();
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      await h.stop();
      await h.stop(); // twice: still nothing to wind down
      gates[0].settle();
      await boot;
      await new Promise((r) => setTimeout(r, 60));
      expect(h.getStats().isRunning).toBe(false);
      expect(h.getStats().orchestrationTicks).toBe(0);
      expect(dispatched).not.toHaveBeenCalled();
      expect(signalListeners()).toBe(listeners);
    });

    it("start, stop, start: only the second start runs, once", async () => {
      const { kernel, jobTransport } = createTestEnv([]);
      const gates = gatedCheck(jobTransport);
      const listeners = signalListeners();
      host = createNodeHost({
        kernel,
        jobTransport,
        workerId: "test-worker",
        orchestrationIntervalMs: 10_000,
        jobPollIntervalMs: 20,
      });
      const first = host.start();
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      await host.stop();
      const second = host.start();
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      gates[1].settle();
      await second;
      // The first check settles late: it must not begin a second set of loops.
      gates[0].settle();
      await first;
      await new Promise((r) => setTimeout(r, 30));
      expect(host.getStats().isRunning).toBe(true);
      expect(host.getStats().orchestrationTicks).toBe(1);
      expect(signalListeners()).toBe(listeners + 2);
      await host.stop();
      expect(signalListeners()).toBe(listeners);
    });

    it("a check that fails after stop() rejects that start() and leaves the host stopped and startable", async () => {
      const { kernel, jobTransport } = createTestEnv([]);
      const gates = gatedCheck(jobTransport);
      host = createNodeHost({
        kernel,
        jobTransport,
        workerId: "test-worker",
        orchestrationIntervalMs: 10_000,
        jobPollIntervalMs: 20,
      });
      const boot = host.start();
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      await host.stop();
      const refusal = new Error("refused");
      gates[0].settle(refusal);
      await expect(boot).rejects.toBe(refusal);
      expect(host.getStats().isRunning).toBe(false);
      const again = host.start();
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      gates[1].settle();
      await again;
      expect(host.getStats().isRunning).toBe(true);
    });
  });

  it("verifies the storage once, however many start() calls are in flight", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    let verified = 0;
    (jobTransport as any).verifyStorage = async () => {
      verified++;
      await new Promise((r) => setTimeout(r, 20));
    };
    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 10_000,
      jobPollIntervalMs: 20,
    });
    await Promise.all([host.start(), host.start(), host.start()]);
    expect(verified).toBe(1);
    expect(host.getStats().isRunning).toBe(true);
    expect(host.getStats().orchestrationTicks).toBe(1);
  });

  it("rejects an onTick that is not a function", () => {
    const { kernel, jobTransport } = createTestEnv([]);
    for (const [bad, message] of [
      ["x", "x"],
      [5, "5"],
      [{}, "[object Object]"],
      [Object.create(null), "Unprintable error"],
    ]) {
      expect(
        () =>
          createNodeHost({
            kernel,
            jobTransport,
            workerId: "test-worker",
            onTick: bad as never,
          }),
        message,
      ).toThrow(new TypeError(`onTick must be a function, got ${message}.`));
    }
    expect(() =>
      createNodeHost({ kernel, jobTransport, workerId: "test-worker" }),
    ).not.toThrow();
  });

  it("calling start() twice is safe", async () => {
    const { kernel, jobTransport } = createTestEnv([]);

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 100,
      jobPollIntervalMs: 50,
    });

    await host.start();
    await host.start(); // should be a no-op

    expect(host.getStats().isRunning).toBe(true);
  });

  it("fails the run promptly (not via reapStuck) when a stage fails terminally", async () => {
    const failingStage = defineStage({
      id: "boom",
      name: "Boom",
      schemas: { input: schema, output: outputSchema, config: z.object({}) },
      async execute() {
        throw new Error("deterministic failure");
      },
    });
    const workflow = new WorkflowBuilder(
      "terminal-fail",
      "Terminal Fail",
      "Test",
      schema,
      outputSchema,
    )
      .pipe(failingStage)
      .build();

    const { kernel, persistence, jobTransport, eventSink } = createTestEnv([
      workflow,
    ]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "terminal-fail-1",
      workflowId: "terminal-fail",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
      // maxAttempts defaults to 3 on InMemoryJobQueue, but this stage
      // fails on attempt 1 already (single attempt is enough to prove
      // the run doesn't linger RUNNING) — set attempts to 1 so the very
      // first failure is terminal.
    });
    jobTransport.setDefaultMaxAttempts(1);
    await host.start();

    // Without fix 1, the run would sit RUNNING until run.reapStuck (many
    // minutes later) killed it with a generic STUCK_RUN_REAPED error.
    // With the fix, run.transition is dispatched immediately after the
    // terminal failure, so this resolves within the polling window.
    await waitFor(async () => {
      const runs = await persistence.getRunsByStatus("FAILED");
      return runs.length > 0;
    }, 2_000);

    const failed = await persistence.getRunsByStatus("FAILED");
    expect(failed).toHaveLength(1);
    expect((failed[0]!.output as any)?.error?.code).not.toBe(
      "STUCK_RUN_REAPED",
    );

    await new Promise((r) => setTimeout(r, 100));
    const failedEvents = eventSink.events.filter(
      (e) => e.type === "workflow:failed",
    );
    expect(failedEvents.length).toBeGreaterThan(0);
    expect((failedEvents[0] as any).error).toContain("deterministic failure");
  });

  it("retries a failed stage through the queue and never marks it FAILED", async () => {
    let calls = 0;
    const seen: string[] = [];
    const flaky = defineStage({
      id: "flaky",
      name: "Flaky",
      schemas: { input: schema, output: outputSchema, config: z.object({}) },
      async execute(ctx) {
        calls++;
        if (calls === 1) throw new Error("transient failure");
        return { output: { result: ctx.input.data.toUpperCase() } };
      },
    });
    const workflow = new WorkflowBuilder(
      "flaky-wf",
      "Flaky",
      "Test",
      schema,
      outputSchema,
    )
      .pipe(flaky)
      .build();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "flaky-1",
      workflowId: "flaky-wf",
      input: { data: "hello" },
    });
    // Sample the stage status while the host works.
    const sampler = setInterval(() => {
      void persistence.getStagesByRun(created.workflowRunId).then((stages) => {
        for (const s of stages) seen.push(s.status);
      });
    }, 5);

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
    });
    await host.start();
    await waitFor(async () => {
      const run = await persistence.getRun(created.workflowRunId);
      return run?.status === "COMPLETED";
    }, 5_000);
    clearInterval(sampler);

    expect(calls).toBe(2);
    expect(seen).not.toContain("FAILED");
    const run = await persistence.getRun(created.workflowRunId);
    expect(run?.output).toEqual({ result: "HELLO" });
  });

  it("flushes the outbox on stop() so a run finished by this process is published", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport, eventSink } = createTestEnv([
      workflow,
    ]);
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "stop-flush-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      // One immediate tick claims the run; no further tick will flush.
      orchestrationIntervalMs: 60_000,
      jobPollIntervalMs: 20,
    });
    await host.start();
    await waitFor(async () => {
      const run = await persistence.getRun(created.workflowRunId);
      return run?.status === "COMPLETED";
    }, 5_000);
    expect(eventSink.events.some((e) => e.type === "workflow:completed")).toBe(
      false,
    );

    await host.stop();

    expect(eventSink.events.some((e) => e.type === "workflow:completed")).toBe(
      true,
    );
  });

  it("acknowledges a dead job and keeps processing the queue", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);
    await jobTransport.enqueueParallel([
      {
        workflowRunId: "run-that-does-not-exist",
        workflowId: "test-workflow",
        stageId: "stage-1",
        payload: {},
      },
    ]);
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "after-dead-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
    });
    await host.start();

    await waitFor(async () => {
      const run = await persistence.getRun(created.workflowRunId);
      return run?.status === "COMPLETED";
    }, 5_000);
    expect(host.getStats().jobsProcessed).toBeGreaterThanOrEqual(2);
    expect(await jobTransport.dequeue()).toBeNull();
  });

  it("renews a job's lease while it executes (heartbeat)", async () => {
    let releaseExecute: (() => void) | undefined;
    const slowStage = defineStage({
      id: "slow",
      name: "Slow",
      schemas: { input: schema, output: outputSchema, config: z.object({}) },
      async execute(ctx) {
        await new Promise<void>((resolve) => {
          releaseExecute = resolve;
        });
        return { output: { result: ctx.input.data } };
      },
    });
    const workflow = new WorkflowBuilder(
      "slow-workflow",
      "Slow",
      "Test",
      schema,
      outputSchema,
    )
      .pipe(slowStage)
      .build();

    const { kernel, jobTransport } = createTestEnv([workflow]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "heartbeat-1",
      workflowId: "slow-workflow",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 20,
      jobPollIntervalMs: 20,
      jobHeartbeatIntervalMs: 30,
    });
    await host.start();

    // Wait for the job to be picked up and locked.
    await waitFor(async () => {
      const running = jobTransport.getJobsByStatus("RUNNING");
      return running.length > 0;
    });

    const lockedAtBeforeHeartbeat =
      jobTransport.getJobsByStatus("RUNNING")[0]!.lockedAt!;

    // Give the heartbeat interval a couple of chances to fire while the
    // stage is still "executing" (blocked on releaseExecute).
    await new Promise((r) => setTimeout(r, 150));

    const runningJob = jobTransport.getJobsByStatus("RUNNING")[0]!;
    expect(runningJob.lockedAt!.getTime()).toBeGreaterThan(
      lockedAtBeforeHeartbeat.getTime(),
    );

    releaseExecute?.();
  });

  it("flushes outbox events through EventSink", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport, eventSink } = createTestEnv([
      workflow,
    ]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "flush-test",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
    });
    await host.start();

    // Wait for workflow to complete
    await waitFor(async () => {
      const runs = await persistence.getRunsByStatus("COMPLETED");
      return runs.length > 0;
    });

    // Give orchestration tick time to flush outbox
    await new Promise((r) => setTimeout(r, 100));

    // Events should have been flushed through EventSink
    expect(eventSink.events.length).toBeGreaterThan(0);
    const types = eventSink.events.map((e) => e.type);
    expect(types).toContain("workflow:created");
    expect(types).toContain("workflow:started");
    expect(types).toContain("workflow:completed");
  });

  it('serves: "all" claims a run pinned to a version this build does not present', async () => {
    const stage = createPassthroughStage("stage-1");
    const workflow = new WorkflowBuilder(
      "wf",
      "Test Workflow",
      "Test",
      schema,
      outputSchema,
    )
      .pipe(stage)
      .build();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    const run = await persistence.createRun({
      workflowId: "wf",
      workflowName: "Test Workflow",
      workflowType: "test",
      input: { data: "hello" },
      definitionVersion: "v-from-another-build",
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      serves: "all",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
    });
    await host.start();

    await waitFor(async () => {
      const persisted = await persistence.getRun(run.id);
      return persisted?.status === "RUNNING";
    });
    await host.stop();
    host = null;

    const persisted = await persistence.getRun(run.id);
    expect(persisted?.status).toBe("RUNNING");
  });

  it("without serves the same run is left for the build that presents it", async () => {
    const stage = createPassthroughStage("stage-1");
    const workflow = new WorkflowBuilder(
      "wf",
      "Test Workflow",
      "Test",
      schema,
      outputSchema,
    )
      .pipe(stage)
      .build();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    const run = await persistence.createRun({
      workflowId: "wf",
      workflowName: "Test Workflow",
      workflowType: "test",
      input: { data: "hello" },
      definitionVersion: "v-from-another-build",
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 20,
      jobPollIntervalMs: 20,
    });
    await host.start();

    await waitFor(async () => host!.getStats().orchestrationTicks >= 1);
    await host.stop();
    host = null;

    const persisted = await persistence.getRun(run.id);
    expect(persisted?.status).toBe("PENDING");
  });
});
