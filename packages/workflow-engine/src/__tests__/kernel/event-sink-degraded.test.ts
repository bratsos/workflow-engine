/**
 * Kernel Tests: the named degraded mode for a failing event sink.
 *
 * A refusing sink is a delivery-latency problem, never a progress
 * problem: the poller advances runs and the outbox keeps the events. What
 * these tests pin down is that the state has a name, is counted, and is
 * visible before the dead-letter queue fills.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { type Workflow, WorkflowBuilder } from "../../core/workflow.js";
import { createEventSinkMonitor } from "../../kernel/helpers/host-support.js";
import {
  createPluginRunner,
  definePlugin,
  type PluginDefinition,
} from "../../kernel/plugins.js";
import { createTestKernel } from "../utils/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPassthroughStage(id: string, schema: z.ZodTypeAny) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
}

function createSimpleWorkflow(id: string = "test-workflow") {
  const schema = z.object({ data: z.string() });
  const stage = createPassthroughStage("stage-1", schema);
  return new WorkflowBuilder(id, "Test Workflow", "Test", schema, schema)
    .pipe(stage)
    .build();
}

function createTestKernelWithPlugins(
  workflows: Workflow<any, any>[] = [],
  plugins: PluginDefinition[] = [],
  maxRetries = 3,
) {
  return createTestKernel(workflows, {
    eventSink: createPluginRunner({ plugins, maxRetries }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kernel: event-sink degraded mode", () => {
  it("a healthy flush reports the sink healthy", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush } = createTestKernel([workflow]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "healthy-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const result = await flush();
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.deadLettered).toBe(0);
    expect(result.eventSinkStatus).toBe("healthy");
    expect(result.eventSinkError).toBeUndefined();
  });

  it("a refusing sink is named degraded and the events stay in the outbox", async () => {
    let shouldThrow = true;
    const plugin = definePlugin({
      id: "flaky-plugin",
      name: "Flaky Plugin",
      on: ["workflow:created"],
      handle: async () => {
        if (shouldThrow) throw new Error("sink down");
      },
    });

    const workflow = createSimpleWorkflow();
    const { kernel, flush } = createTestKernelWithPlugins(
      [workflow],
      [plugin as PluginDefinition],
    );

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "degraded-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const first = await flush();
    expect(first.published).toBe(0);
    expect(first.failed).toBe(1);
    expect(first.eventSinkStatus).toBe("degraded");
    expect(first.eventSinkError).toContain("sink down");

    shouldThrow = false;
    const second = await flush();
    expect(second.published).toBe(1);
    expect(second.eventSinkStatus).toBe("healthy");
  });

  it("dead-lettering is counted on the flush that exhausts the retry budget", async () => {
    const plugin = definePlugin({
      id: "always-fails",
      name: "Always Fails",
      on: ["workflow:created"],
      handle: async () => {
        throw new Error("permanent failure");
      },
    });

    const workflow = createSimpleWorkflow();
    const { kernel, flush } = createTestKernelWithPlugins(
      [workflow],
      [plugin as PluginDefinition],
      2,
    );

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "dlq-budget-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const first = await flush();
    expect(first.deadLettered).toBe(0);
    expect(first.eventSinkStatus).toBe("degraded");

    const second = await flush();
    expect(second.deadLettered).toBe(1);
    expect(second.eventSinkStatus).toBe("degraded");

    const third = await flush();
    expect(third.published).toBe(0);
    expect(third.failed).toBe(0);
    expect(third.deadLettered).toBe(0);
    expect(third.eventSinkStatus).toBe("healthy");
  });

  it("the run still reaches COMPLETED while the sink is refusing every event", async () => {
    const workflow = createSimpleWorkflow();
    const eventSink = {
      async emit(): Promise<void> {
        throw new Error("sink down");
      },
    };

    const { kernel, flush, persistence, jobTransport } = createTestKernel(
      [workflow],
      { eventSink },
    );

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "run-complete-sink-down",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await kernel.dispatch({
      type: "run.claimPending",
      workerId: "test-worker",
    });

    const job = await jobTransport.dequeue();
    expect(job).not.toBeNull();

    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: job!.workflowRunId,
      workflowId: job!.workflowId,
      stageId: job!.stageId,
      config: {},
    });
    await jobTransport.complete(job!.jobId);
    await kernel.dispatch({
      type: "run.transition",
      workflowRunId: created.workflowRunId,
    });

    const run = await persistence.getRun(created.workflowRunId);
    expect(run?.status).toBe("COMPLETED");

    const flushResult = await flush();
    expect(flushResult.eventSinkStatus).toBe("degraded");
    expect(flushResult.published).toBe(0);
  });
});

describe("createEventSinkMonitor", () => {
  it("logs once on the transition into degraded and once on recovery", () => {
    const logs: string[] = [];
    const monitor = createEventSinkMonitor({ log: (m) => logs.push(m) });

    monitor.observe({
      failed: 1,
      deadLettered: 0,
      eventSinkStatus: "degraded",
      eventSinkError: "sink down",
    });
    monitor.observe({
      failed: 1,
      deadLettered: 0,
      eventSinkStatus: "degraded",
      eventSinkError: "sink down",
    });

    const degraded = monitor.report();
    expect(degraded.status).toBe("degraded");
    expect(degraded.consecutiveFailures).toBe(2);
    expect(degraded.lastError).toContain("sink down");
    expect(degraded.since).not.toBeNull();

    monitor.observe({ failed: 0, deadLettered: 0, eventSinkStatus: "healthy" });

    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("DEGRADED");
    expect(logs[1]).toContain("recovered");

    const healthy = monitor.report();
    expect(healthy.status).toBe("healthy");
    expect(healthy.consecutiveFailures).toBe(0);
    expect(healthy.lastError).toBeNull();
  });

  it("always logs dead-letters, even on a flush that is otherwise healthy", () => {
    const logs: string[] = [];
    const monitor = createEventSinkMonitor({ log: (m) => logs.push(m) });

    monitor.observe({ failed: 0, deadLettered: 3, eventSinkStatus: "healthy" });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("DEAD-LETTERED");
    expect(logs[0]).toContain("plugin.replayDLQ");
    expect(monitor.report().deadLettered).toBe(3);
  });

  it("observeError marks the sink degraded", () => {
    const logs: string[] = [];
    const monitor = createEventSinkMonitor({ log: (m) => logs.push(m) });

    monitor.observeError(new Error("boom"));

    const report = monitor.report();
    expect(report.status).toBe("degraded");
    expect(report.lastError).toContain("boom");
    expect(logs[0]).toContain("DEGRADED");
  });
});
