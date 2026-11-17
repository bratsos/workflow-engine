/**
 * Kernel tests for a crash after the atomic failure and dead-letter write.
 * A replay clears legacy stamps and makes the same event eligible again.
 * The tests exercise outbox.flush and plugin.replayDLQ through dispatch.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  createPluginRunner,
  definePlugin,
  type PluginDefinition,
} from "../../kernel/plugins.js";
import { createTestKernel } from "../utils/index.js";

function createKernelWithFailingPlugin() {
  const schema = z.object({ data: z.string() });
  const stage = defineStage({
    id: "stage-1",
    name: "Stage 1",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
  const workflow = new WorkflowBuilder(
    "test-workflow",
    "Test",
    "Test",
    schema,
    schema,
  )
    .pipe(stage)
    .build();

  let shouldFail = true;
  const delivered: string[] = [];
  const plugin = definePlugin({
    id: "test-plugin",
    name: "Test Plugin",
    on: ["workflow:created"],
    handle: async (event) => {
      if (shouldFail) throw new Error("plugin failure");
      delivered.push(event.type);
    },
  });
  const eventSink = createPluginRunner({
    plugins: [plugin as PluginDefinition],
    maxRetries: 1,
  });
  const harness = createTestKernel([workflow], { eventSink });
  return {
    ...harness,
    delivered,
    eventSink,
    heal: () => {
      shouldFail = false;
    },
  };
}

describe("kernel: dead-lettering an event across a crash", () => {
  it.each([
    ["publication", false],
    ["publication", true],
    ["retry release", false],
    ["retry release", true],
    ["dead letter", false],
    ["dead letter", true],
  ] as const)("recovers three claimed events after a live-process %s error (committed: %s)", async (operation, committed) => {
    const { kernel, flush, persistence, delivered, heal, clock, eventSink } =
      createKernelWithFailingPlugin();
    for (let i = 0; i < 3; i++) {
      const id = `write-error-${i}`;
      await persistence.createRun({
        id,
        workflowId: "test",
        workflowName: "test",
        workflowType: "test",
        input: {},
      });
      await persistence.appendOutboxEvents([
        {
          workflowRunId: id,
          eventType: "workflow:created",
          payload: { type: "workflow:created", workflowRunId: id },
          causationId: id,
          occurredAt: clock.now(),
        },
      ]);
    }
    if (operation === "publication") heal();
    (eventSink as { maxRetries: number }).maxRetries =
      operation === "dead letter" ? 1 : 3;
    const complete = persistence.completeOutboxDelivery.bind(persistence);
    const fail = persistence.failOutboxDelivery.bind(persistence);
    if (operation === "publication") {
      persistence.completeOutboxDelivery = async (...args) => {
        if (committed) await complete(...args);
        throw new Error("injected publication write error");
      };
    } else {
      persistence.failOutboxDelivery = async (...args) => {
        if (committed) await fail(...args);
        throw new Error("injected failure write error");
      };
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(flush()).rejects.toThrow("injected");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      persistence.completeOutboxDelivery = complete;
      persistence.failOutboxDelivery = fail;
    }
    heal();
    expect((await flush()).published).toBe(
      operation === "retry release" && committed ? 1 : 0,
    );
    if (operation === "dead letter" && committed)
      expect(
        (await kernel.dispatch({ type: "plugin.replayDLQ", maxEvents: 10 }))
          .replayed,
      ).toBe(1);
    clock.advance(60_001);
    await flush();
    expect(await persistence.getUnpublishedOutboxEvents(10)).toHaveLength(0);
    expect(delivered).toHaveLength(
      operation === "publication" && !committed ? 4 : 3,
    );
  });

  it("delivers the event after a replay when the process died after the dead-letter write", async () => {
    const { kernel, flush, persistence, delivered, heal } =
      createKernelWithFailingPlugin();
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "crash-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // The process dies immediately after the atomic dead-letter and claim release.
    const fail = persistence.failOutboxDelivery.bind(persistence);
    persistence.failOutboxDelivery = async (...args) => {
      await fail(...args);
      throw new Error("process died");
    };
    await expect(flush()).rejects.toThrow("process died");
    persistence.failOutboxDelivery = fail;

    // The row the crash left: dead-lettered, and not stamped as published.
    const [row] = (persistence as any).outbox as {
      publishedAt: Date | null;
      dlqAt: Date | null;
    }[];
    expect(row?.dlqAt).toBeInstanceOf(Date);
    expect(row?.publishedAt).toBeNull();

    // The restarted process: a flush finds nothing (the event is dead-lettered),
    // `engine.stats` counts it, and a replay makes it live again.
    expect((await flush()).published).toBe(0);
    const stats = await kernel.dispatch({ type: "engine.stats" });
    expect(stats.outbox.available && stats.outbox.deadLettered).toBe(1);
    heal();
    const replay = await kernel.dispatch({
      type: "plugin.replayDLQ" as const,
      maxEvents: 10,
    });
    expect(replay.replayed).toBe(1);

    expect((await flush()).published).toBe(1);
    expect(delivered).toEqual(["workflow:created"]);
  });

  it("revives a dead letter that an earlier version left stamped as published", async () => {
    const { kernel, flush, persistence, delivered, heal } =
      createKernelWithFailingPlugin();
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "legacy-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    // The state a crash left before this fix: dead-lettered and claim-stamped.
    const [event] = (persistence as any).outbox as {
      publishedAt: Date | null;
      dlqAt: Date | null;
    }[];
    event!.publishedAt = new Date();
    event!.dlqAt = new Date();

    heal();
    const replay = await kernel.dispatch({
      type: "plugin.replayDLQ" as const,
      maxEvents: 10,
    });
    expect(replay.replayed).toBe(1);
    expect((await flush()).published).toBe(1);
    expect(delivered).toEqual(["workflow:created"]);
  });
});
