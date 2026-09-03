/**
 * A stage that keeps waiting on the same durable step is re-suspended on
 * every poll, but `stage:suspended` / `workflow:suspended` are emitted once
 * for that wait, not once per poll.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../../core/workflow.js";
import type { StepLedger } from "../../kernel/ports.js";
import type { CollectingEventSink } from "../../kernel/testing/collecting-event-sink.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { createTestHarness, InMemoryStepLedger } from "../../testing/index.js";

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

  it("emits one stage:suspended while a leased in-flight step blocks the replay", async () => {
    // A worker died holding the lease on `slow`: the ledger already has a
    // running row with a live lease when this process first executes the
    // stage, so every replay meets StepInFlight until the lease expires.
    let runs = 0;
    const workflow = defineWorkflow("suspend-in-flight", { input: In })
      .stage("work", {
        schemas: {
          input: In,
          output: z.object({ runs: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          await ctx.step.run("slow", async () => ++runs, { leaseMs: 60_000 });
          return { output: { runs } };
        },
      })
      .build();
    let seeded = false;
    const clock = new FakeClock();
    const inner = new InMemoryStepLedger({ now: () => clock.now() });
    const ledger: StepLedger = {
      claim: async (record) => {
        if (record.stepId === "slow" && !seeded) {
          seeded = true;
          // The dead worker's row: running, leased for another minute.
          await inner.claim({
            ...record,
            leaseExpiresAt: new Date(clock.now().getTime() + 60_000),
          });
        }
        return inner.claim(record);
      },
      get: (a, b) => inner.get(a, b),
      update: (a, b, c) => inner.update(a, b, c),
      compareAndSet: (a, b, c, d) => inner.compareAndSet(a, b, c, d),
      list: (a) => inner.list(a),
      clear: (a) => inner.clear(a),
    };
    const harness = createTestHarness({
      workflows: [workflow],
      clock,
      stepLedger: ledger,
    });

    const result = await harness.run("suspend-in-flight", {});

    expect(result.status).toBe("COMPLETED");
    expect(runs).toBe(1);
    const types = (harness.eventSink as CollectingEventSink).events.map(
      (e) => e.type,
    );
    // Polled every 5s for a minute: announced once, not once per poll.
    expect(types.filter((t) => t === "stage:suspended")).toHaveLength(1);
    expect(types.filter((t) => t === "workflow:suspended")).toHaveLength(1);
  });
});
