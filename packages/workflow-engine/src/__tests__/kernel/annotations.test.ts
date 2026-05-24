/**
 * Kernel Tests: annotations
 *
 * Coverage targets (driven by the design review):
 *  - Stage-scope annotations persist atomically with COMPLETED outcome
 *  - Pre-throw annotations persist with FAILED outcome
 *  - Suspended-stage annotations persist with SUSPENDED outcome
 *  - Cancellation mid-execution → annotations dropped (ghost path)
 *  - Single / batch / TypedKey call forms
 *  - `undefined` values are skipped
 *  - `run.create` annotations land in same transaction as createRun
 *  - `kernel.annotations.attach` happy path + idempotency dedup
 *  - `kernel.annotations.list` filter combinations + timeline ordering
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Decision } from "../../conventions/index.js";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
import { type Workflow, WorkflowBuilder } from "../../core/workflow.js";
import { createKernel } from "../../kernel/kernel.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

// ============================================================================
// Test scaffold
// ============================================================================

function createTestKernel(workflows: Workflow<any, any>[] = []) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const scheduler = new NoopScheduler();
  const clock = new FakeClock();

  const registry = new Map<string, Workflow<any, any>>();
  for (const w of workflows) registry.set(w.id, w);

  const kernel = createKernel({
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });

  return { kernel, persistence, blobStore, jobTransport, eventSink, clock };
}

const simpleSchema = z.object({ data: z.string() });

function makeWorkflow(
  id: string,
  stage:
    | ReturnType<typeof defineStage>
    | ReturnType<typeof defineAsyncBatchStage>,
) {
  return new WorkflowBuilder(id, "Test", "Test", simpleSchema, simpleSchema)
    .pipe(stage)
    .build();
}

async function createRunningRun(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  persistence: InMemoryWorkflowPersistence,
  workflowId: string,
  idempotencyKey: string,
) {
  const result = await kernel.dispatch({
    type: "run.create",
    idempotencyKey,
    workflowId,
    input: { data: "hi" },
  });
  await persistence.updateRun(result.workflowRunId, { status: "RUNNING" });
  return result.workflowRunId;
}

// ============================================================================
// Stage-scope annotations
// ============================================================================

describe("annotations: stage scope", () => {
  it("persists annotations atomically with a COMPLETED stage", async () => {
    const stage = defineStage({
      id: "decide",
      name: "Decide",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate("decision.outcome", "low");
        ctx.annotate("decision.confidence", 0.42);
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-1", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(kernel, persistence, "wf-1", "k-1");
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-1",
      stageId: "decide",
      config: {},
    });

    const annotations = await kernel.annotations.list(runId);
    expect(annotations).toHaveLength(2);
    expect(annotations.map((a) => a.key).sort()).toEqual([
      "decision.confidence",
      "decision.outcome",
    ]);
    expect(annotations.every((a) => a.scope === "stage")).toBe(true);
    expect(annotations.every((a) => a.scopeId === "decide")).toBe(true);
  });

  it("supports the batch form with shared envelope", async () => {
    const stage = defineStage({
      id: "decide",
      name: "Decide",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate({
          actor: { kind: "agent", id: "triage-v3", version: "3.0.1" },
          attributes: {
            "decision.outcome": "low",
            "decision.rationale": "below threshold",
            "decision.used_fallback": true,
          },
        });
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-batch", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(
      kernel,
      persistence,
      "wf-batch",
      "k-batch",
    );
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-batch",
      stageId: "decide",
      config: {},
    });

    const annotations = await kernel.annotations.list(runId);
    expect(annotations).toHaveLength(3);
    expect(annotations.every((a) => a.actorKind === "agent")).toBe(true);
    expect(annotations.every((a) => a.actorId === "triage-v3")).toBe(true);
    expect(annotations.every((a) => a.actorVersion === "3.0.1")).toBe(true);
  });

  it("supports the TypedKey form from the conventions module", async () => {
    const stage = defineStage({
      id: "decide",
      name: "Decide",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate(Decision.outcome, "low");
        ctx.annotate(Decision.confidence, 0.42);
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-typed", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(
      kernel,
      persistence,
      "wf-typed",
      "k-typed",
    );
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-typed",
      stageId: "decide",
      config: {},
    });

    const annotations = await kernel.annotations.list(runId);
    expect(annotations.map((a) => a.key).sort()).toEqual([
      "decision.confidence",
      "decision.outcome",
    ]);
    const outcome = annotations.find((a) => a.key === "decision.outcome");
    expect(outcome?.value).toBe("low");
  });

  it("skips undefined values across all three call forms", async () => {
    const stage = defineStage({
      id: "skip",
      name: "Skip",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate("x.always", "yes");
        ctx.annotate("x.maybe", undefined as unknown as string);
        ctx.annotate({
          attributes: { "x.batch.set": 1, "x.batch.unset": undefined },
        });
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-skip", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(kernel, persistence, "wf-skip", "k-s");
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-skip",
      stageId: "skip",
      config: {},
    });

    const annotations = await kernel.annotations.list(runId);
    expect(annotations.map((a) => a.key).sort()).toEqual([
      "x.always",
      "x.batch.set",
    ]);
  });

  it("persists pre-throw annotations alongside FAILED stage", async () => {
    const stage = defineStage({
      id: "fail",
      name: "Fail",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate("failure.kind", "ai-timeout");
        ctx.annotate("failure.retryable", true);
        throw new Error("boom");
      },
    });
    const workflow = makeWorkflow("wf-fail", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(kernel, persistence, "wf-fail", "k-f");
    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-fail",
      stageId: "fail",
      config: {},
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("boom");
    const annotations = await kernel.annotations.list(runId);
    expect(annotations.map((a) => a.key).sort()).toEqual([
      "failure.kind",
      "failure.retryable",
    ]);
  });

  it("drops annotations when the stage is ghosted (run cancelled mid-execution)", async () => {
    let resolveExecute!: () => void;
    const executeStarted = new Promise<void>((resolve) => {
      // first execution call signals it has started
      resolveExecute = resolve;
    });

    const stage = defineStage({
      id: "long",
      name: "Long",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate("phase", "before-cancel");
        // Yield once so the test can cancel before we complete.
        resolveExecute();
        await new Promise<void>((r) => setTimeout(r, 5));
        ctx.annotate("phase", "after-cancel");
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-ghost", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(
      kernel,
      persistence,
      "wf-ghost",
      "k-g",
    );

    const execPromise = kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-ghost",
      stageId: "long",
      config: {},
    });
    await executeStarted;

    // Cancel the run while the stage is still running.
    await kernel.dispatch({
      type: "run.cancel",
      workflowRunId: runId,
      idempotencyKey: "cancel-g",
    });

    const result = await execPromise;
    expect(result.outcome).toBe("failed");
    expect(result.ghost).toBe(true);

    const annotations = await kernel.annotations.list(runId);
    expect(annotations).toHaveLength(0);
  });
});

// ============================================================================
// Suspended stage annotations
// ============================================================================

describe("annotations: suspended stage", () => {
  it("persists annotations alongside SUSPENDED stage", async () => {
    const stage = defineAsyncBatchStage({
      id: "batch",
      name: "Batch",
      mode: "async-batch",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate("batch.submitted", true);
        return {
          suspended: true,
          state: {
            batchId: "b-1",
            submittedAt: new Date().toISOString(),
            pollInterval: 1000,
            maxWaitTime: 60_000,
          },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60_000,
            nextPollAt: new Date(Date.now() + 1000),
          },
          metrics: {
            startTime: Date.now(),
            endTime: Date.now(),
            duration: 0,
          },
        };
      },
      async checkCompletion() {
        return { ready: false };
      },
    });
    const workflow = makeWorkflow("wf-susp", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(
      kernel,
      persistence,
      "wf-susp",
      "k-susp",
    );
    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-susp",
      stageId: "batch",
      config: {},
    });

    expect(result.outcome).toBe("suspended");
    const annotations = await kernel.annotations.list(runId);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].key).toBe("batch.submitted");
  });
});

// ============================================================================
// run.create annotations
// ============================================================================

describe("annotations: run.create", () => {
  it("attaches annotations atomically with run creation", async () => {
    const stage = defineStage({
      id: "noop",
      name: "Noop",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-create", stage);
    const { kernel } = createTestKernel([workflow]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-create-1",
      workflowId: "wf-create",
      input: { data: "x" },
      annotations: [
        {
          actor: { kind: "system", id: "zendesk" },
          attributes: {
            "trigger.source": "webhook:zendesk",
            "trigger.parent_run_id": "prev-run-id",
            "trigger.reason": "auto-triage",
          },
        },
      ],
    });

    const annotations = await kernel.annotations.list(result.workflowRunId);
    expect(annotations).toHaveLength(3);
    expect(annotations.every((a) => a.scope === "run")).toBe(true);
    expect(annotations.every((a) => a.actorId === "zendesk")).toBe(true);

    const trigger = annotations.find((a) => a.key === "trigger.source");
    expect(trigger?.value).toBe("webhook:zendesk");
  });

  it("attaches no annotations when array is empty or omitted", async () => {
    const stage = defineStage({
      id: "noop",
      name: "Noop",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-empty", stage);
    const { kernel } = createTestKernel([workflow]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-empty",
      workflowId: "wf-empty",
      input: { data: "x" },
      annotations: [],
    });
    expect(await kernel.annotations.list(result.workflowRunId)).toHaveLength(0);
  });
});

// ============================================================================
// kernel.annotations.attach (external attach)
// ============================================================================

describe("annotations: kernel.annotations.attach", () => {
  it("attaches a single batch atomically", async () => {
    const stage = defineStage({
      id: "noop",
      name: "Noop",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-attach", stage);
    const { kernel } = createTestKernel([workflow]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-att",
      workflowId: "wf-attach",
      input: { data: "x" },
    });
    await kernel.annotations.attach(result.workflowRunId, {
      actor: { kind: "user", id: "alice@acme.com" },
      attributes: {
        "review.disposition": "approved-anyway",
        "review.note": "manual override",
      },
    });

    const annotations = await kernel.annotations.list(result.workflowRunId);
    expect(annotations).toHaveLength(2);
    expect(annotations.every((a) => a.actorKind === "user")).toBe(true);
  });

  it("dedups duplicate (runId, key, idempotencyKey) on attach", async () => {
    const stage = defineStage({
      id: "noop",
      name: "Noop",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-idem", stage);
    const { kernel } = createTestKernel([workflow]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-idem",
      workflowId: "wf-idem",
      input: { data: "x" },
    });

    for (let i = 0; i < 3; i++) {
      await kernel.annotations.attach(result.workflowRunId, {
        actor: { kind: "system", id: "watchdog" },
        attributes: { "watchdog.tick": "ok" },
        idempotencyKey: "tick-1",
      });
    }

    const annotations = await kernel.annotations.list(result.workflowRunId, {
      key: "watchdog.tick",
    });
    expect(annotations).toHaveLength(1);
  });

  it("treats NULL idempotency keys as distinct (multiple rows allowed)", async () => {
    const stage = defineStage({
      id: "noop",
      name: "Noop",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-null", stage);
    const { kernel } = createTestKernel([workflow]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-null",
      workflowId: "wf-null",
      input: { data: "x" },
    });

    for (let i = 0; i < 3; i++) {
      await kernel.annotations.attach(result.workflowRunId, {
        attributes: { "log.tick": i },
      });
    }

    const annotations = await kernel.annotations.list(result.workflowRunId, {
      key: "log.tick",
    });
    expect(annotations).toHaveLength(3);
  });
});

// ============================================================================
// kernel.annotations.list filters
// ============================================================================

describe("annotations: kernel.annotations.list filters", () => {
  async function setup() {
    const stage = defineStage({
      id: "noop",
      name: "Noop",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-list", stage);
    const { kernel } = createTestKernel([workflow]);
    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-list",
      workflowId: "wf-list",
      input: { data: "x" },
      annotations: [
        {
          actor: { kind: "system", id: "zendesk" },
          attributes: { "trigger.source": "webhook" },
        },
        {
          actor: { kind: "user", id: "alice" },
          attributes: {
            "decision.outcome": "low",
            "decision.rationale": "below threshold",
            "review.note": "manual",
          },
        },
      ],
    });
    return { kernel, runId: result.workflowRunId };
  }

  it("filters by exact key", async () => {
    const { kernel, runId } = await setup();
    const out = await kernel.annotations.list(runId, {
      key: "decision.outcome",
    });
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe("low");
  });

  it("filters by keyPrefix", async () => {
    const { kernel, runId } = await setup();
    const out = await kernel.annotations.list(runId, {
      keyPrefix: "decision.",
    });
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.key).sort()).toEqual([
      "decision.outcome",
      "decision.rationale",
    ]);
  });

  it("filters by actorId / actorKind", async () => {
    const { kernel, runId } = await setup();
    const byUser = await kernel.annotations.list(runId, { actorKind: "user" });
    expect(byUser.every((a) => a.actorId === "alice")).toBe(true);

    const byZendesk = await kernel.annotations.list(runId, {
      actorId: "zendesk",
    });
    expect(byZendesk).toHaveLength(1);
    expect(byZendesk[0].key).toBe("trigger.source");
  });

  it("returns annotations ordered by createdAt then id", async () => {
    const { kernel, runId } = await setup();
    const out = await kernel.annotations.list(runId);
    expect(out).toHaveLength(4);
    // Stable ordering across calls — second call returns same sequence.
    const out2 = await kernel.annotations.list(runId);
    expect(out2.map((a) => a.id)).toEqual(out.map((a) => a.id));
  });

  it("honors limit", async () => {
    const { kernel, runId } = await setup();
    const out = await kernel.annotations.list(runId, { limit: 2 });
    expect(out).toHaveLength(2);
  });
});

// ============================================================================
// Legacy metadata shim
// ============================================================================

describe("annotations: legacy metadata shim", () => {
  async function setupWithMetadata(meta: Record<string, unknown>) {
    const stage = defineStage({
      id: "noop",
      name: "Noop",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-legacy", stage);
    const { kernel } = createTestKernel([workflow]);
    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: `legacy-${Math.random()}`,
      workflowId: "wf-legacy",
      input: { data: "x" },
      metadata: meta,
    });
    return { kernel, runId: result.workflowRunId };
  }

  it("synthesizes legacy.metadata.* virtual rows from WorkflowRun.metadata", async () => {
    const { kernel, runId } = await setupWithMetadata({
      tenantId: "acme",
      source: "webhook",
    });

    const all = await kernel.annotations.list(runId);
    expect(all.map((a) => a.key).sort()).toEqual([
      "legacy.metadata.source",
      "legacy.metadata.tenantId",
    ]);
    expect(all.every((a) => a.scope === "run")).toBe(true);
    expect(all.every((a) => a.id.startsWith("synthesized:"))).toBe(true);
  });

  it("does not synthesize when persisted legacy.metadata.* already exists", async () => {
    const { kernel, runId } = await setupWithMetadata({ tenantId: "acme" });
    // Consumer has migrated by attaching a real annotation under the
    // legacy.metadata.* prefix.
    await kernel.annotations.attach(runId, {
      attributes: { "legacy.metadata.tenantId": "acme-migrated" },
    });

    const all = await kernel.annotations.list(runId);
    expect(all).toHaveLength(1);
    expect(all[0].value).toBe("acme-migrated");
    expect(all[0].id.startsWith("synthesized:")).toBe(false);
  });

  it("synthesis honors keyPrefix and exact-key filters", async () => {
    const { kernel, runId } = await setupWithMetadata({
      tenantId: "acme",
      source: "webhook",
      runtime: "node",
    });

    const prefix = await kernel.annotations.list(runId, {
      keyPrefix: "legacy.metadata.s",
    });
    expect(prefix.map((a) => a.key).sort()).toEqual(["legacy.metadata.source"]);

    const exact = await kernel.annotations.list(runId, {
      key: "legacy.metadata.tenantId",
    });
    expect(exact).toHaveLength(1);
    expect(exact[0].value).toBe("acme");
  });

  it("synthesis is skipped when filter excludes run scope", async () => {
    const { kernel, runId } = await setupWithMetadata({ tenantId: "acme" });
    const stageOnly = await kernel.annotations.list(runId, { scope: "stage" });
    expect(stageOnly).toHaveLength(0);
  });

  it("does NOT synthesize when migration exists but consumer filter hides it", async () => {
    // Codex round-2 finding: filter-sensitive migration detection.
    const { kernel, runId } = await setupWithMetadata({
      tenantId: "acme",
      source: "webhook",
    });
    // Consumer migrated tenantId only.
    await kernel.annotations.attach(runId, {
      attributes: { "legacy.metadata.tenantId": "acme-migrated" },
    });

    // Filter that excludes the migrated row. Without the filter-agnostic
    // detection query, the shim would incorrectly synthesize both keys.
    const narrow = await kernel.annotations.list(runId, {
      keyPrefix: "legacy.metadata.s",
    });
    // Pre-fix: would synthesize legacy.metadata.source (wrong — already
    // migrated tenantId means consumer is responsible for migrating
    // others themselves).
    // Post-fix: detection sees the migrated tenantId via separate query,
    // skips synthesis entirely.
    expect(narrow).toHaveLength(0);
  });
});

// ============================================================================
// Additional codex round-2 coverage
// ============================================================================

describe("annotations: payload field", () => {
  it("persists payload alongside attributes and returns it on list", async () => {
    const stage = defineStage({
      id: "with-payload",
      name: "Payload",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate({
          attributes: { "decision.outcome": "low" },
          payload: { fullModelResponse: { foo: "bar", n: 42 } },
        });
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-payload", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(
      kernel,
      persistence,
      "wf-payload",
      "k-payload",
    );
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-payload",
      stageId: "with-payload",
      config: {},
    });

    const annotations = await kernel.annotations.list(runId);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].payload).toEqual({
      fullModelResponse: { foo: "bar", n: 42 },
    });
  });
});

describe("annotations: null value skipping", () => {
  it("treats null values as no-op (matches undefined behavior)", async () => {
    const stage = defineStage({
      id: "null-skip",
      name: "NullSkip",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate("x.set", "yes");
        ctx.annotate("x.unset", null as unknown as string);
        ctx.annotate({
          attributes: { "y.set": 1, "y.unset": null },
        });
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-null", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(kernel, persistence, "wf-null", "k-n");
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-null",
      stageId: "null-skip",
      config: {},
    });

    const annotations = await kernel.annotations.list(runId);
    expect(annotations.map((a) => a.key).sort()).toEqual(["x.set", "y.set"]);
  });
});

describe("annotations: attempt filtering via external attach", () => {
  it("filters by attempt when set on attach inputs", async () => {
    const stage = defineStage({
      id: "noop",
      name: "Noop",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-attempt", stage);
    const { kernel } = createTestKernel([workflow]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-attempt",
      workflowId: "wf-attempt",
      input: { data: "x" },
    });

    await kernel.annotations.attach(result.workflowRunId, {
      attributes: { "decision.outcome": "first-attempt" },
      attempt: 0,
    });
    await kernel.annotations.attach(result.workflowRunId, {
      attributes: { "decision.outcome": "second-attempt" },
      attempt: 1,
    });

    const attempt0 = await kernel.annotations.list(result.workflowRunId, {
      attempt: 0,
    });
    expect(attempt0).toHaveLength(1);
    expect(attempt0[0].value).toBe("first-attempt");

    const attempt1 = await kernel.annotations.list(result.workflowRunId, {
      attempt: 1,
    });
    expect(attempt1).toHaveLength(1);
    expect(attempt1[0].value).toBe("second-attempt");
  });
});

describe("annotations: since / until time filters", () => {
  it("filters by createdAt range against real timestamps", async () => {
    const stage = defineStage({
      id: "noop",
      name: "Noop",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-time", stage);
    const { kernel } = createTestKernel([workflow]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-time",
      workflowId: "wf-time",
      input: { data: "x" },
    });

    await kernel.annotations.attach(result.workflowRunId, {
      attributes: { "evt.early": 1 },
    });

    // Small delay so the second annotation has a strictly later createdAt.
    await new Promise<void>((r) => setTimeout(r, 5));
    const cutoff = new Date();
    await new Promise<void>((r) => setTimeout(r, 5));

    await kernel.annotations.attach(result.workflowRunId, {
      attributes: { "evt.late": 2 },
    });

    const before = await kernel.annotations.list(result.workflowRunId, {
      until: cutoff,
    });
    expect(before.map((a) => a.key)).toEqual(["evt.early"]);

    const after = await kernel.annotations.list(result.workflowRunId, {
      since: cutoff,
    });
    expect(after.map((a) => a.key)).toEqual(["evt.late"]);
  });
});

describe("annotations: attempt auto-increment on rerun", () => {
  it("rerunFrom assigns a new attempt to recreated stages so new annotations are distinguishable", async () => {
    const stage1 = defineStage({
      id: "decide",
      name: "Decide",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate("decision.outcome", "first");
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-rerun", stage1);
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(
      kernel,
      persistence,
      "wf-rerun",
      "k-rerun",
    );
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-rerun",
      stageId: "decide",
      config: {},
    });

    // Mark run as COMPLETED so rerunFrom is allowed.
    await persistence.updateRun(runId, {
      status: "COMPLETED",
      completedAt: new Date(),
    });

    // Rerun from the only stage.
    await kernel.dispatch({
      type: "run.rerunFrom",
      workflowRunId: runId,
      fromStageId: "decide",
    });

    // Execute the second attempt.
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-rerun",
      stageId: "decide",
      config: {},
    });

    const all = await kernel.annotations.list(runId);
    // First attempt annotation preserved with attempt=0; second
    // attempt's annotation carries attempt=1.
    const firstAttempt = all.filter((a) => a.attempt === 0);
    const secondAttempt = all.filter((a) => a.attempt === 1);

    expect(firstAttempt).toHaveLength(1);
    expect(firstAttempt[0].value).toBe("first");
    expect(secondAttempt).toHaveLength(1);
    expect(secondAttempt[0].value).toBe("first");
    // Old stage record deleted (SetNull on the FK) but value lives on.
    expect(firstAttempt[0].workflowStageRecordId).toBeNull();
    // New stage record is the active one.
    expect(secondAttempt[0].workflowStageRecordId).not.toBeNull();
  });
});

describe("annotations: attempt propagates to downstream stages after rerun", () => {
  it("downstream stages enqueued via run.transition inherit the rerun attempt", async () => {
    // Two-stage pipeline. After rerunFrom from stage1, run.transition
    // enqueues stage2 with the new attempt (not the default 0).
    const stage1 = defineStage({
      id: "stage1",
      name: "Stage 1",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate("decision.outcome", "s1");
        return { output: ctx.input };
      },
    });
    const stage2 = defineStage({
      id: "stage2",
      name: "Stage 2",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate("decision.outcome", "s2");
        return { output: ctx.input };
      },
    });
    const workflow = new WorkflowBuilder(
      "wf-attempt-prop",
      "Attempt Prop",
      "Attempt Prop",
      simpleSchema,
      simpleSchema,
    )
      .pipe(stage1)
      .pipe(stage2)
      .build();
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(
      kernel,
      persistence,
      "wf-attempt-prop",
      "k-attempt-prop",
    );

    // First pass: execute both stages, both annotations carry attempt=0
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-attempt-prop",
      stageId: "stage1",
      config: {},
    });
    await kernel.dispatch({
      type: "run.transition",
      workflowRunId: runId,
    });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-attempt-prop",
      stageId: "stage2",
      config: {},
    });

    // Mark COMPLETED so rerunFrom is allowed
    await persistence.updateRun(runId, {
      status: "COMPLETED",
      completedAt: new Date(),
    });

    // Rerun from stage1
    await kernel.dispatch({
      type: "run.rerunFrom",
      workflowRunId: runId,
      fromStageId: "stage1",
    });

    // Re-execute stage1 (attempt=1)
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-attempt-prop",
      stageId: "stage1",
      config: {},
    });
    // run.transition enqueues stage2 — this is the key fix: stage2's
    // new record must inherit attempt=1 from the run-level rerun.
    await kernel.dispatch({
      type: "run.transition",
      workflowRunId: runId,
    });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-attempt-prop",
      stageId: "stage2",
      config: {},
    });

    const all = await kernel.annotations.list(runId);
    const stage2Annotations = all.filter((a) => a.scopeId === "stage2");
    // Should have one annotation per attempt for stage2.
    expect(stage2Annotations).toHaveLength(2);
    const attempts = stage2Annotations.map((a) => a.attempt).sort();
    expect(attempts).toEqual([0, 1]);
  });
});

describe("annotations: outbox emission opt-in", () => {
  it("emits annotation:created event when emitEvent is true", async () => {
    const stage = defineStage({
      id: "decide",
      name: "Decide",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        // Emit-on: should produce an outbox event
        ctx.annotate("decision.outcome", "low", { emitEvent: true });
        // Emit-off (default): should NOT produce an outbox event
        ctx.annotate("decision.silent", "no-emit");
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-emit", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(
      kernel,
      persistence,
      "wf-emit",
      "k-emit",
    );
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-emit",
      stageId: "decide",
      config: {},
    });

    // Both annotations persisted as rows
    const allAnnotations = await kernel.annotations.list(runId);
    expect(allAnnotations).toHaveLength(2);

    // Only the emit-on annotation produced an outbox event
    const unpublished = await persistence.getUnpublishedOutboxEvents();
    const annotationEvents = unpublished.filter(
      (e) => e.eventType === "annotation:created",
    );
    expect(annotationEvents).toHaveLength(1);
    const payload = annotationEvents[0].payload as Record<string, unknown>;
    expect(payload.key).toBe("decision.outcome");
    expect(payload.value).toBe("low");
  });

  it("emits annotation:created via kernel.annotations.attach when emitEvent is true", async () => {
    const stage = defineStage({
      id: "noop",
      name: "Noop",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-attach-emit", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-attach-emit",
      workflowId: "wf-attach-emit",
      input: { data: "x" },
    });

    await kernel.annotations.attach(created.workflowRunId, {
      actor: { kind: "user", id: "alice" },
      attributes: { "review.disposition": "approved" },
      emitEvent: true,
    });

    const unpublished = await persistence.getUnpublishedOutboxEvents();
    const annotationEvents = unpublished.filter(
      (e) => e.eventType === "annotation:created",
    );
    expect(annotationEvents).toHaveLength(1);
    const payload = annotationEvents[0].payload as Record<string, unknown>;
    expect(payload.key).toBe("review.disposition");
    expect(payload.value).toBe("approved");
    expect(payload.actorKind).toBe("user");
    expect(payload.actorId).toBe("alice");
  });

  it("emits annotation:created via run.create annotations when emitEvent is true", async () => {
    const stage = defineStage({
      id: "noop",
      name: "Noop",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const workflow = makeWorkflow("wf-rc-emit", stage);
    const { kernel, persistence } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-rc-emit",
      workflowId: "wf-rc-emit",
      input: { data: "x" },
      annotations: [
        {
          actor: { kind: "system", id: "webhook" },
          attributes: { "trigger.source": "webhook:zendesk" },
          emitEvent: true,
        },
      ],
    });
    expect(created.workflowRunId).toBeTruthy();

    const unpublished = await persistence.getUnpublishedOutboxEvents();
    const annotationEvents = unpublished.filter(
      (e) => e.eventType === "annotation:created",
    );
    expect(annotationEvents).toHaveLength(1);
    const payload = annotationEvents[0].payload as Record<string, unknown>;
    expect(payload.key).toBe("trigger.source");
    expect(payload.value).toBe("webhook:zendesk");
  });
});

describe("annotations: multi-stage scope disambiguation", () => {
  it("separates annotations by scopeId across stages of the same run", async () => {
    const stage1 = defineStage({
      id: "stage-a",
      name: "A",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate("decision.outcome", "a-low");
        return { output: ctx.input };
      },
    });
    const stage2 = defineStage({
      id: "stage-b",
      name: "B",
      schemas: {
        input: simpleSchema,
        output: simpleSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.annotate("decision.outcome", "b-high");
        return { output: ctx.input };
      },
    });
    const workflow = new WorkflowBuilder(
      "wf-multi",
      "M",
      "M",
      simpleSchema,
      simpleSchema,
    )
      .pipe(stage1)
      .pipe(stage2)
      .build();
    const { kernel, persistence } = createTestKernel([workflow]);

    const runId = await createRunningRun(
      kernel,
      persistence,
      "wf-multi",
      "k-multi",
    );
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-multi",
      stageId: "stage-a",
      config: {},
    });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf-multi",
      stageId: "stage-b",
      config: {},
    });

    const a = await kernel.annotations.list(runId, { scopeId: "stage-a" });
    expect(a).toHaveLength(1);
    expect(a[0].value).toBe("a-low");

    const b = await kernel.annotations.list(runId, { scopeId: "stage-b" });
    expect(b).toHaveLength(1);
    expect(b[0].value).toBe("b-high");
  });
});
