/**
 * A stage that keeps waiting on the same durable step is re-suspended on
 * every poll, but `stage:suspended` / `workflow:suspended` are emitted once
 * for that wait, not once per poll.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../../core/workflow.js";
import type { CollectingEventSink } from "../../kernel/testing/collecting-event-sink.js";
import { createTestHarness } from "../../testing/index.js";

const In = z.object({});

describe("suspension events across polls", () => {
  it("emits one stage:suspended per wait, not per poll", async () => {
    let polls = 0;
    const workflow = defineWorkflow("suspend-once", { input: In })
      .stage("wait", {
        schemas: {
          input: In,
          output: z.object({ polls: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const n = await ctx.step.waitFor("ready", {
            poll: async () => ++polls,
            ready: (v) => v >= 6,
            every: "5s",
            timeout: "1h",
          });
          return { output: { polls: n } };
        },
      })
      .build();
    const harness = createTestHarness({ workflows: [workflow] });

    const result = await harness.run("suspend-once", {});

    expect(result.status).toBe("COMPLETED");
    expect(polls).toBe(6);
    const types = (harness.eventSink as CollectingEventSink).events.map(
      (e) => e.type,
    );
    expect(types.filter((t) => t === "stage:suspended")).toHaveLength(1);
    expect(types.filter((t) => t === "workflow:suspended")).toHaveLength(1);
    expect(types).toContain("workflow:completed");
  });

  it("emits again when the stage moves on to a different wait", async () => {
    let a = 0;
    let b = 0;
    const workflow = defineWorkflow("suspend-twice", { input: In })
      .stage("wait", {
        schemas: {
          input: In,
          output: z.object({ ok: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          await ctx.step.waitFor("first", {
            poll: async () => ++a,
            ready: (v) => v >= 2,
            every: "5s",
            timeout: "1h",
          });
          await ctx.step.waitFor("second", {
            poll: async () => ++b,
            ready: (v) => v >= 2,
            every: "5s",
            timeout: "1h",
          });
          return { output: { ok: true } };
        },
      })
      .build();
    const harness = createTestHarness({ workflows: [workflow] });

    const result = await harness.run("suspend-twice", {});

    expect(result.status).toBe("COMPLETED");
    const types = (harness.eventSink as CollectingEventSink).events.map(
      (e) => e.type,
    );
    expect(types.filter((t) => t === "stage:suspended")).toHaveLength(2);
  });
});
