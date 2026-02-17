/**
 * Kernel Tests: plugin.replayDLQ command
 *
 * Tests that DLQ events can be replayed (reset for reprocessing).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKernel } from "../../kernel/kernel.js";
import {
  FakeClock,
  InMemoryBlobStore,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder, type Workflow } from "../../core/workflow.js";
import { definePlugin, createPluginRunner } from "../../kernel/plugins.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSimpleWorkflow() {
  const schema = z.object({ data: z.string() });
  const stage = defineStage({
    id: "stage-1",
    name: "Stage 1",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
  return new WorkflowBuilder("test-workflow", "Test", "Test", schema, schema)
    .pipe(stage)
    .build();
}

function createTestKernelWithFailingPlugin(maxRetries = 1) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const scheduler = new NoopScheduler();
  const clock = new FakeClock();

  let shouldFail = true;
  const handler = async () => {
    if (shouldFail) throw new Error("plugin failure");
  };

  const plugin = definePlugin({
    id: "test-plugin",
    name: "Test Plugin",
    on: ["workflow:created"],
    handle: handler,
  });

  const eventSink = createPluginRunner({ plugins: [plugin], maxRetries });

  const workflow = createSimpleWorkflow();
  const registry = new Map<string, Workflow<any, any>>();
  registry.set(workflow.id, workflow);

  const kernel = createKernel({
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });

  const flush = () => kernel.dispatch({ type: "outbox.flush" as const });

  return { kernel, flush, persistence, setShouldFail: (v: boolean) => { shouldFail = v; } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kernel: plugin.replayDLQ", () => {
  it("replays DLQ events so they are picked up by next flush", async () => {
    const { kernel, flush, setShouldFail } = createTestKernelWithFailingPlugin(1);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "replay-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Flush: plugin fails, retryCount reaches maxRetries -> DLQ
    await flush();

    // Event is now in DLQ — flush returns 0
    const result1 = await flush();
    expect(result1.published).toBe(0);

    // Fix the plugin
    setShouldFail(false);

    // Replay DLQ
    const replayResult = await kernel.dispatch({
      type: "plugin.replayDLQ" as const,
      maxEvents: 10,
    });
    expect(replayResult.replayed).toBe(1);

    // Now flush succeeds
    const result2 = await flush();
    expect(result2.published).toBe(1);
  });

  it("returns 0 when DLQ is empty", async () => {
    const { kernel } = createTestKernelWithFailingPlugin(1);

    const result = await kernel.dispatch({
      type: "plugin.replayDLQ" as const,
      maxEvents: 10,
    });
    expect(result.replayed).toBe(0);
  });

  it("respects maxEvents limit", async () => {
    const { kernel, flush } = createTestKernelWithFailingPlugin(1);

    // Create 3 runs (3 DLQ events)
    for (let i = 0; i < 3; i++) {
      await kernel.dispatch({
        type: "run.create",
        idempotencyKey: `replay-limit-${i}`,
        workflowId: "test-workflow",
        input: { data: `item-${i}` },
      });
    }

    // Flush all to DLQ
    await flush();

    // Replay only 2
    const result = await kernel.dispatch({
      type: "plugin.replayDLQ" as const,
      maxEvents: 2,
    });
    expect(result.replayed).toBe(2);
  });
});
