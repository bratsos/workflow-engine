import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../../core/workflow.js";
import { createTestHarness } from "../../testing/index.js";

const In = z.object({ value: z.number() });

describe("createTestHarness", () => {
  it("drives a two-stage workflow to completion", async () => {
    const workflow = defineWorkflow("harness-basic", { input: In })
      .stage("double", {
        schemas: {
          input: In,
          output: z.object({ doubled: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { doubled: ctx.input.value * 2 } };
        },
      })
      .stage("describe", {
        dependencies: ["double"],
        schemas: {
          input: "none",
          output: z.object({ text: z.string() }),
          config: z.object({ prefix: z.string().default("=") }),
        },
        async execute(ctx) {
          const prev = ctx.require("double");
          return { output: { text: `${ctx.config.prefix}${prev.doubled}` } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    const result = await harness.run("harness-basic", { value: 21 });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ text: "=42" });
  });

  it("passes per-stage config through job.payload.config", async () => {
    const workflow = defineWorkflow("harness-config", { input: In })
      .stage("emit", {
        schemas: {
          input: In,
          output: z.object({ label: z.string() }),
          config: z.object({ label: z.string().default("default") }),
        },
        async execute(ctx) {
          return { output: { label: ctx.config.label } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    const result = await harness.run(
      "harness-config",
      { value: 1 },
      { emit: { label: "from-config" } },
    );

    expect(result.output).toEqual({ label: "from-config" });
  });

  it("resumes a durable stage by advancing the clock past nextPollAt", async () => {
    let polls = 0;
    const workflow = defineWorkflow("harness-durable", { input: In })
      .stage("wait", {
        schemas: {
          input: In,
          output: z.object({ polls: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const value = await ctx.step.waitFor("ready", {
            poll: async () => ++polls,
            ready: (n) => n >= 3,
            every: "30s",
            timeout: "1h",
          });
          return { output: { polls: value } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    const result = await harness.run("harness-durable", { value: 1 });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ polls: 3 });
    expect(result.ticks).toBeGreaterThan(1);
  });

  it("reports a failed run with the failing stage's error", async () => {
    const workflow = defineWorkflow("harness-failure", { input: In })
      .stage("boom", {
        schemas: {
          input: In,
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("stage exploded");
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    const result = await harness.run("harness-failure", { value: 1 });

    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("stage exploded");
  });

  it("tick() performs exactly one round", async () => {
    const workflow = defineWorkflow("harness-tick", { input: In })
      .stage("noop", {
        schemas: {
          input: In,
          output: z.object({ ok: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { ok: true } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    await harness.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "tick-1",
      workflowId: "harness-tick",
      input: { value: 1 },
    });

    const first = await harness.tick();
    expect(first.claimed).toBe(1);
    expect(first.executed).toBe(1);
    expect(first.outcomes[0]?.outcome).toBe("completed");

    const second = await harness.tick();
    expect(second.claimed).toBe(0);
    expect(second.executed).toBe(0);
    expect(second.idle).toBe(true);
  });
});
