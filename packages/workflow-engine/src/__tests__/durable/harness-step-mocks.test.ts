import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../../core/workflow.js";
import type { StepLedger, StepRecord } from "../../kernel/ports.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import {
  createMockStepLedger,
  createTestHarness,
} from "../../testing/index.js";

const In = z.object({ value: z.number() });

describe("harness step mocks", () => {
  it("mocks a step's result without running its body", async () => {
    let ran = false;
    const workflow = defineWorkflow("mock-result-wf", { input: In })
      .stage("fetch-stage", {
        schemas: {
          input: In,
          output: z.object({ live: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const result = await ctx.step.run("fetch", async () => {
            ran = true;
            return { live: true };
          });
          return { output: result };
        },
      })
      .build();

    const h = createTestHarness({ workflows: [workflow] });
    h.steps.mockResult("fetch", { live: false });

    const result = await h.run("mock-result-wf", { value: 1 });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ live: false });
    expect(ran).toBe(false);
    expect(await h.steps.status("fetch")).toBe("completed");
    expect(await h.steps.result("fetch")).toEqual({ live: false });
    expect(h.steps.wasMocked("fetch")).toBe(true);

    // The seed is a patch on the row the engine was about to write, so the
    // engine's own identity fields survive it.
    const record = await h.steps.record("fetch");
    expect(record?.kind).toBe("run");
    expect(record?.seq).toBe(1);
    expect(record?.externalKey).toBeTruthy();
  });

  it("mocks a step's error so the stage fails with it", async () => {
    let ran = false;
    const workflow = defineWorkflow("mock-error-wf", { input: In })
      .stage("charge-stage", {
        schemas: {
          input: In,
          output: z.object({ ok: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          await ctx.step.run("charge", async () => {
            ran = true;
            return { ok: true };
          });
          return { output: { ok: true } };
        },
      })
      .build();

    const h = createTestHarness({ workflows: [workflow] });
    h.steps.mockError("charge", new Error("card declined"));

    const result = await h.run("mock-error-wf", { value: 1 });

    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("card declined");
    expect(await h.steps.status("charge")).toBe("failed");
    expect(await h.steps.error("charge")).toBe("card declined");
    expect(ran).toBe(false);
  });

  it("a mocked error survives the step's own retries", async () => {
    let ran = false;
    const workflow = defineWorkflow("mock-retry-wf", { input: In })
      .stage("charge-stage", {
        schemas: {
          input: In,
          output: z.object({ ok: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          await ctx.step.run(
            "charge",
            async () => {
              ran = true;
              return { ok: true };
            },
            { retries: 3 },
          );
          return { output: { ok: true } };
        },
      })
      .build();

    const h = createTestHarness({ workflows: [workflow] });
    h.steps.mockError("charge", new Error("card declined"));

    const result = await h.run("mock-retry-wf", { value: 1 });

    expect(result.status).toBe("FAILED");
    expect(ran).toBe(false);
  });

  it("forces a wait step past its deadline", async () => {
    let polls = 0;
    const workflow = defineWorkflow("mock-wait-wf", { input: In })
      .stage("wait-stage", {
        schemas: {
          input: In,
          output: z.object({ value: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const value = await ctx.step.waitFor("ready", {
            poll: async () => {
              polls++;
              return 1;
            },
            ready: () => false,
            every: "30s",
            timeout: "1h",
          });
          return { output: { value } };
        },
      })
      .build();

    const h = createTestHarness({ workflows: [workflow] });
    h.steps.mockTimeout("ready");

    const result = await h.run("mock-wait-wf", { value: 1 });

    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("exceeded its timeout");
    expect(polls).toBe(0);
    expect(await h.steps.status("ready")).toBe("failed");
  });

  it("skips a durable sleep so a suspending stage completes in one tick", async () => {
    const workflow = defineWorkflow("mock-sleep-wf", { input: In })
      .stage("sleep-stage", {
        schemas: {
          input: In,
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          await ctx.step.sleep("cooldown", "24h");
          return { output: { done: true } };
        },
      })
      .build();

    // Baseline: without skipping, completes in >1 ticks and first tick reports suspended
    const unmocked = createTestHarness({ workflows: [workflow] });
    const baseline = await unmocked.run("mock-sleep-wf", { value: 1 });

    expect(baseline.status).toBe("COMPLETED");
    expect(baseline.ticks).toBeGreaterThan(1);
    expect(baseline.reports[0]?.outcomes[0]?.outcome).toBe("suspended");

    // With skipSleeps(): completes in exactly 1 tick with no suspended outcome
    const h = createTestHarness({ workflows: [workflow] });
    h.steps.skipSleeps();

    const result = await h.run("mock-sleep-wf", { value: 1 });

    expect(result.status).toBe("COMPLETED");
    expect(result.ticks).toBe(1);
    expect(
      result.reports.every((report) =>
        report.outcomes.every((o) => o.outcome !== "suspended"),
      ),
    ).toBe(true);
  });

  it("asserts a named step's outcome part-way through a run", async () => {
    const workflow = defineWorkflow("mock-partway-wf", { input: In })
      .stage("stage1", {
        schemas: {
          input: In,
          output: z.object({ a: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const a = await ctx.step.run("first", async () => 1);
          await ctx.step.sleep("nap", "1h");
          return { output: { a } };
        },
      })
      .stage("stage2", {
        dependencies: ["stage1"],
        schemas: {
          input: "none",
          output: z.object({ b: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const b = await ctx.step.run("second", async () => 2);
          return { output: { b } };
        },
      })
      .build();

    const h = createTestHarness({ workflows: [workflow] });
    await h.start("mock-partway-wf", { value: 1 });

    // The first stage parks on its sleep, so the run is observable here:
    // "first" has an outcome, "second" has not been reached at all.
    await h.tickUntil(
      async () => (await h.steps.status("first")) === "completed",
    );
    expect(await h.steps.result("first")).toBe(1);
    expect(await h.steps.status("nap")).toBe("pending");
    expect(await h.steps.status("second")).toBeUndefined();

    await h.tickUntil(
      async () => (await h.steps.status("second")) === "completed",
    );
    expect(await h.steps.status("nap")).toBe("completed");
    expect(await h.steps.result("second")).toBe(2);
  });

  it("mockTimeout on a run step throws a descriptive error", async () => {
    const workflow = defineWorkflow("mock-timeout-run-wf", { input: In })
      .stage("action", {
        schemas: {
          input: In,
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          await ctx.step.run("work", async () => ({ done: true }));
          return { output: { done: true } };
        },
      })
      .build();

    const h = createTestHarness({ workflows: [workflow] });
    h.steps.mockTimeout("work");

    const result = await h.run("mock-timeout-run-wf", { value: 1 });

    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("have none");
    expect(result.error).toContain("waitFor");
    expect(result.error).toContain("mockTimeout");
  });
});

describe("createMockStepLedger forwarding", () => {
  // Fails to compile when a method is added to the StepLedger port but not
  // accounted for here. This guarantees the wrapper test surface mirrors
  // the entire port.
  const STEP_LEDGER_SURFACE: Record<keyof Required<StepLedger>, true> = {
    claim: true,
    get: true,
    update: true,
    compareAndSet: true,
    list: true,
    clear: true,
    clearExcept: true,
  };

  it("forwards every method of the port to the wrapped ledger", async () => {
    const calls: string[] = [];
    const sampleRecord: StepRecord = {
      stageRecordId: "stage-1",
      stepId: "step-1",
      seq: 1,
      kind: "run",
      status: "completed",
      attempt: 1,
      leaseExpiresAt: null,
      deadlineAt: null,
      externalKey: null,
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const fake: Required<StepLedger> = {
      async claim(record) {
        calls.push("claim");
        return { created: true, record: { ...sampleRecord, ...record } };
      },
      async get(_stageRecordId, _stepId) {
        calls.push("get");
        return sampleRecord;
      },
      async update(_stageRecordId, _stepId, _patch) {
        calls.push("update");
        return sampleRecord;
      },
      async compareAndSet(_stageRecordId, _stepId, _expected, _patch) {
        calls.push("compareAndSet");
        return { applied: true, record: sampleRecord };
      },
      async list(_stageRecordId) {
        calls.push("list");
        return [sampleRecord];
      },
      async clear(_stageRecordId) {
        calls.push("clear");
      },
      async clearExcept(_stageRecordId, _keepStepIds) {
        calls.push("clearExcept");
      },
    };

    const wrapper = createMockStepLedger(fake, new FakeClock());

    await wrapper.claim({
      stageRecordId: "stage-1",
      stepId: "step-1",
      seq: 1,
      kind: "run",
      status: "running",
      attempt: 1,
      leaseExpiresAt: null,
      deadlineAt: null,
    });
    await wrapper.get("stage-1", "step-1");
    await wrapper.update("stage-1", "step-1", {});
    await wrapper.compareAndSet("stage-1", "step-1", { status: "running" }, {});
    await wrapper.list("stage-1");
    await wrapper.clear("stage-1");
    await wrapper.clearExcept?.("stage-1", ["step-1"]);

    const surface = Object.keys(STEP_LEDGER_SURFACE);
    for (const method of surface) {
      expect(
        typeof (wrapper as unknown as Record<string, unknown>)[method],
      ).toBe("function");
    }
    expect([...calls].sort()).toEqual([...surface].sort());
  });

  it("mirrors the wrapped ledger's optional methods", () => {
    const sampleRecord: StepRecord = {
      stageRecordId: "stage-1",
      stepId: "step-1",
      seq: 1,
      kind: "run",
      status: "completed",
      attempt: 1,
      leaseExpiresAt: null,
      deadlineAt: null,
      externalKey: null,
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const baseFake: StepLedger = {
      async claim() {
        return { created: true, record: sampleRecord };
      },
      async get() {
        return sampleRecord;
      },
      async update() {
        return sampleRecord;
      },
      async compareAndSet() {
        return { applied: true, record: sampleRecord };
      },
      async list() {
        return [sampleRecord];
      },
      async clear() {},
    };

    const withClearExcept: StepLedger = {
      ...baseFake,
      async clearExcept() {},
    };
    const wrapperWith = createMockStepLedger(withClearExcept, new FakeClock());
    expect(typeof wrapperWith.clearExcept).toBe("function");

    const withoutClearExcept: StepLedger = { ...baseFake };
    delete (withoutClearExcept as Partial<StepLedger>).clearExcept;
    const wrapperWithout = createMockStepLedger(
      withoutClearExcept,
      new FakeClock(),
    );
    expect(wrapperWithout.clearExcept).toBeUndefined();
    expect("clearExcept" in wrapperWithout).toBe(false);
  });
});
