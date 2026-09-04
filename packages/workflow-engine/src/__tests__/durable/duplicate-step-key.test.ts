/**
 * Two steps sharing a key must fail loudly, and stay loud.
 *
 * Keying by name (not by ordinal position) is what makes a run survive
 * renaming and reordering the code around it. The debt is that a repeated
 * key would silently answer the first call's result to the second caller,
 * with no error anywhere. The guard is at first use inside one stage
 * invocation — the stage body is a function we cannot inspect statically —
 * and the two things pinned here are the ones that made it useless before:
 * the AI map's per-item catch turned the collision into a `failed` verdict
 * nobody reads, and the host burned every retry attempt on a stage that
 * could never succeed.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { isDuplicateStepKeyError } from "../../core/steps.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createMockAIHelperFactory, createTestKernel } from "../utils/index.js";
import {
  crashOnClaim,
  createAiMapHarness,
  REALTIME_MODEL,
} from "./ai-map-harness.js";

const inputSchema = z.object({ count: z.number() });
const outputSchema = z.object({ done: z.number() });
const itemSchema = z.object({ value: z.string() });

describe("duplicate durable step keys", () => {
  it("surfaces out of ctx.step.ai.map instead of becoming an item verdict", async () => {
    const mock = createMockAIHelperFactory();
    mock.setObjectResponse("<<0>>", { object: { value: "v0" } });
    mock.setObjectResponse("<<1>>", { object: { value: "v1" } });
    // `extract:0` is the key the map's first item will ask for, because an
    // itemId defaults to the array index.
    const stage = defineStage({
      id: "map-key-collision",
      name: "map-key-collision",
      schemas: {
        input: inputSchema,
        output: outputSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        await ctx.step.run("extract:0", async () => "taken");
        const items = Array.from({ length: ctx.input.count }, (_, i) => i);
        const results = await ctx.step.ai.map("extract", items, {
          model: REALTIME_MODEL,
          policy: "realtime",
          schema: itemSchema,
          prompt: (item) => `Extract <<${item}>>`,
          realtime: { concurrency: 1 },
        });
        return { output: { done: results.length } };
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema,
      outputSchema,
      input: { count: 2 },
      mock,
    });

    const result = await h.execute();

    expect(result).toMatchObject({ outcome: "failed" });
    const record = await h.stage();
    expect(record?.status).toBe("FAILED");
    expect(record?.errorMessage).toContain("DuplicateStepKeyError");
    expect(record?.errorMessage).toContain("extract:0");
  });

  it("fails the stage without burning retry attempts", async () => {
    const ledger = new InMemoryStepLedger();
    const stage = defineStage({
      id: "dup",
      name: "Dup",
      schemas: {
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        config: z.object({}),
      },
      async execute(ctx) {
        await ctx.step.run("work", async () => 1);
        await ctx.step.run("work", async () => 2);
        return { output: { ok: true } };
      },
    });
    const workflow = new WorkflowBuilder(
      "dup-wf",
      "Dup",
      "test",
      z.object({}),
      z.object({ ok: z.boolean() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence } = createTestKernel([workflow], {
      stepLedger: ledger,
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "dup-run",
      workflowId: workflow.id,
      input: {},
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "worker" });

    // Attempt 1 of 3: a retryable failure would be recorded PENDING for the
    // host to re-enqueue. A duplicate key is deterministic, so no attempt
    // could resolve it and the stage is terminal on the first one.
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: created.workflowRunId,
      workflowId: workflow.id,
      stageId: stage.id,
      config: {},
      attempt: 1,
      maxAttempts: 3,
    });

    const record = await persistence.getStage(created.workflowRunId, stage.id);
    expect(record?.status).toBe("FAILED");
    expect(record?.errorMessage).toContain("Duplicate durable step key");
    expect(record?.errorMessage).toContain(
      "first requested as a run step at position 1",
    );
    // The first use is intact: the guard refuses the second call, it does
    // not corrupt the ledger row the first one owns.
    expect(await ledger.get(record!.id, "work")).toMatchObject({
      status: "completed",
      result: 1,
    });
  });

  it("outranks a suspension raised by another item of the same map", async () => {
    const mock = createMockAIHelperFactory();
    mock.setObjectResponse("<<0>>", { object: { value: "v0" } });
    mock.setObjectResponse("<<1>>", { object: { value: "v1" } });
    const stage = defineStage({
      id: "map-key-collision-race",
      name: "map-key-collision-race",
      schemas: {
        input: inputSchema,
        output: outputSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        await ctx.step.run("extract:0", async () => "taken");
        const items = Array.from({ length: ctx.input.count }, (_, i) => i);
        const results = await ctx.step.ai.map("extract", items, {
          model: REALTIME_MODEL,
          policy: "realtime",
          schema: itemSchema,
          prompt: (item) => `Extract <<${item}>>`,
          // Both items must be in flight together, or the first
          // rejection stops the second from ever running.
          realtime: { concurrency: 2 },
        });
        return { output: { done: results.length } };
      },
    });
    // Item 0 collides with the key taken above; item 1 meets a live lease
    // from a worker that died, which is a suspension. Both reject.
    const h = await createAiMapHarness({
      stage,
      inputSchema,
      outputSchema,
      input: { count: 2 },
      mock,
      wrapLedger: (ledger, now) => crashOnClaim(ledger, "extract:1", now),
    });

    const result = await h.execute();

    // The suspension would have been correct and useless: the next poll
    // replays the stage and meets the same duplicate key.
    expect(result).toMatchObject({ outcome: "failed" });
    const record = await h.stage();
    expect(record?.status).toBe("FAILED");
    expect(record?.errorMessage).toContain("Duplicate durable step key");
    expect(record?.errorMessage).toContain("extract:0");
  });

  it("still suspends when the only rejections are control flow", async () => {
    const mock = createMockAIHelperFactory();
    mock.setObjectResponse("<<0>>", { object: { value: "v0" } });
    mock.setObjectResponse("<<1>>", { object: { value: "v1" } });
    const stage = defineStage({
      id: "map-inflight-only",
      name: "map-inflight-only",
      schemas: {
        input: inputSchema,
        output: outputSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        const items = Array.from({ length: ctx.input.count }, (_, i) => i);
        const results = await ctx.step.ai.map("extract", items, {
          model: REALTIME_MODEL,
          policy: "realtime",
          schema: itemSchema,
          prompt: (item) => `Extract <<${item}>>`,
          realtime: { concurrency: 2 },
        });
        return { output: { done: results.length } };
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema,
      outputSchema,
      input: { count: 2 },
      mock,
      wrapLedger: (ledger, now) => crashOnClaim(ledger, "extract:1", now),
    });

    // Nothing collides, so the in-flight item still decides the outcome and
    // the stage waits rather than failing.
    expect(await h.execute()).toMatchObject({ outcome: "suspended" });
    await h.tick(5_000);
    expect((await h.stage())?.status).toBe("COMPLETED");
  });

  it("brands the error so a catch boundary can recognise it across bundles", () => {
    expect(isDuplicateStepKeyError(new Error("nope"))).toBe(false);
  });
});
