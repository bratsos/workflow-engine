/**
 * Kernel Tests: command idempotency
 *
 * Commands with an `idempotencyKey` are deduplicated: replaying the same
 * command returns the cached result without re-executing the handler.
 * Keys are scoped to commandType so the same string can be used across
 * different command types without collision.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { IdempotencyInProgressError } from "../../kernel/errors.js";
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kernel: idempotency", () => {
  it("run.create with same idempotencyKey returns cached result", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const result1 = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const result2 = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Same cached result
    expect(result1.workflowRunId).toBe(result2.workflowRunId);
    expect(result1.status).toBe(result2.status);

    // Only one run was actually created
    const allRuns = persistence.getAllRuns();
    expect(allRuns).toHaveLength(1);
  });

  it("run.create with different key creates a new run", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel } = createTestKernel([workflow]);

    const result1 = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const result2 = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-2",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    expect(result1.workflowRunId).not.toBe(result2.workflowRunId);
  });

  it("job.execute with same idempotencyKey returns cached result", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "transform",
      name: "Transform",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: { result: ctx.input.data.toUpperCase() } };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, eventSink } = createTestKernel([workflow]);

    // Create and manually move to RUNNING
    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "create-for-job-idem",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });
    eventSink.clear();

    // Execute with an idempotency key
    const result1 = await kernel.dispatch({
      type: "job.execute",
      idempotencyKey: "job-key-1",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "transform",
      config: {},
    });

    // Execute again with the same key
    const result2 = await kernel.dispatch({
      type: "job.execute",
      idempotencyKey: "job-key-1",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "transform",
      config: {},
    });

    // Both results are identical (cached)
    expect(result1.outcome).toBe("completed");
    expect(result2.outcome).toBe("completed");
    expect(result1.output).toEqual(result2.output);
    expect(result1.output).toEqual({ result: "HELLO" });
  });

  it("job.execute without idempotencyKey does not re-execute a COMPLETED stage", async () => {
    const schema = z.object({ data: z.string() });
    let executionCount = 0;
    const stage = defineStage({
      id: "counting",
      name: "Counting",
      schemas: {
        input: schema,
        output: z.object({ count: z.number() }),
        config: z.object({}),
      },
      async execute() {
        executionCount++;
        return { output: { count: executionCount } };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ count: z.number() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, eventSink } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "create-for-no-idem",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });
    eventSink.clear();

    // First execution (no idempotency key)
    const result1 = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "counting",
      config: {},
    });
    expect(result1.outcome).toBe("completed");
    expect(executionCount).toBe(1);

    // Second execution without idempotency key -- the stage is already
    // COMPLETED. This is NOT idempotency-key caching (there is no key)
    // but the Phase-1 double-execution guard in job-execute: a stale-lease
    // duplicate delivery of a job whose stage already completed must not
    // re-run the stage body. It returns the cached output directly.
    const result2 = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "counting",
      config: {},
    });

    expect(result2.outcome).toBe("completed");
    expect(result2.output).toEqual(result1.output);
    expect(executionCount).toBe(1);
  });

  it("idempotency key is scoped to commandType", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "transform",
      name: "Transform",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: { result: ctx.input.data.toUpperCase() } };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, eventSink } = createTestKernel([workflow]);

    // Dispatch run.create with key "shared-key"
    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "shared-key",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    expect(createResult.workflowRunId).toBeDefined();

    // Set up the run for job execution
    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });
    eventSink.clear();

    // Dispatch job.execute with the SAME key "shared-key"
    const jobResult = await kernel.dispatch({
      type: "job.execute",
      idempotencyKey: "shared-key",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "transform",
      config: {},
    });

    // Both commands executed -- idempotency did NOT interfere between types
    expect(createResult.status).toBe("PENDING");
    expect(jobResult.outcome).toBe("completed");
    expect(jobResult.output).toEqual({ result: "HELLO" });
  });

  it("outbox events are NOT duplicated on idempotent replay", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush } = createTestKernel([workflow]);

    // First dispatch produces outbox events
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Flush publishes 1 event
    const flush1 = await flush();
    expect(flush1.published).toBe(1);

    // Replay the same command (idempotent -- returns cached, no new events)
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Second flush should find nothing new
    const flush2 = await flush();
    expect(flush2.published).toBe(0);
  });

  it("rejects commands when the same idempotency key is already in progress", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const acquired = await persistence.acquireIdempotencyKey(
      "in-progress-key",
      "run.create",
    );
    expect(acquired.status).toBe("acquired");

    await expect(
      kernel.dispatch({
        type: "run.create",
        idempotencyKey: "in-progress-key",
        workflowId: "test-workflow",
        input: { data: "hello" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
  });

  it("reclaims an in_progress idempotency key after the default 10-minute TTL", async () => {
    // Simulates a dispatcher that crashed between committing its
    // transaction and calling completeIdempotencyKey: the key is stuck
    // `in_progress` with no dispatcher left alive to complete or release
    // it. Without a TTL reclaim, every future dispatch would throw
    // IdempotencyInProgressError forever.
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, clock } = createTestKernel([workflow]);

    await persistence.acquireIdempotencyKey("crashed-key", "run.create", {
      now: clock.now(),
    });

    // Not yet stale -- still rejected.
    await expect(
      kernel.dispatch({
        type: "run.create",
        idempotencyKey: "crashed-key",
        workflowId: "test-workflow",
        input: { data: "hello" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);

    // Advance past the default 10-minute reclaim threshold.
    clock.advance(10 * 60 * 1000);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "crashed-key",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    expect(result.status).toBe("PENDING");
  });

  it("respects a custom idempotencyStaleInProgressMs", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, clock } = createTestKernel([workflow], {
      idempotencyStaleInProgressMs: 60 * 1000,
    });

    await persistence.acquireIdempotencyKey("custom-ttl-key", "run.create", {
      now: clock.now(),
    });

    // Advance past the custom 1-minute threshold (but well under the
    // 10-minute default) -- should already be reclaimable.
    clock.advance(60 * 1000);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "custom-ttl-key",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    expect(result.status).toBe("PENDING");
  });

  it("releases idempotency key when handler throws", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, registry } = createTestKernel([]);

    await expect(
      kernel.dispatch({
        type: "run.create",
        idempotencyKey: "release-key",
        workflowId: "test-workflow",
        input: { data: "hello" },
      }),
    ).rejects.toThrow();

    registry.set(workflow.id, workflow);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "release-key",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    expect(result.status).toBe("PENDING");
  });

  it("does not persist outbox events when command handler throws", async () => {
    const { kernel } = createTestKernel([]);

    await expect(
      kernel.dispatch({
        type: "run.create",
        idempotencyKey: "no-outbox-on-error",
        workflowId: "missing-workflow",
        input: { data: "hello" },
      }),
    ).rejects.toThrow();

    const flushed = await kernel.dispatch({ type: "outbox.flush" });
    expect(flushed.published).toBe(0);
  });
});
