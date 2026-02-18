/**
 * Stage Storage Tests (Kernel)
 *
 * Tests for the ctx.storage API available within stage execute functions.
 * In the kernel, storage is backed by BlobStore (not InMemoryStageStorage).
 * Covers saving, loading, checking existence, deleting artifacts, and key generation.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKernel } from "../../kernel/kernel.js";
import {
  FakeClock,
  InMemoryBlobStore,
  CollectingEventSink,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder, type Workflow } from "../../core/workflow.js";

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
    persistence, blobStore, jobTransport, eventSink, scheduler, clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });
  const flush = () => kernel.dispatch({ type: "outbox.flush" as const });
  return { kernel, flush, persistence, blobStore, jobTransport, eventSink, scheduler, clock, registry };
}

/** Helper: create run, mark RUNNING, return runId */
async function createAndStartRun(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  persistence: InMemoryWorkflowPersistence,
  flush: () => Promise<any>,
  workflowId: string,
  input: Record<string, unknown> = {},
) {
  const createResult = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: `key-${Date.now()}-${Math.random()}`,
    workflowId,
    input,
  });
  await persistence.updateRun(createResult.workflowRunId, { status: "RUNNING" });
  await flush();
  return createResult.workflowRunId;
}

describe("I want to use stage storage", () => {
  describe("saving artifacts", () => {
    it("should save artifact with key", async () => {
      // Given: A stage that saves an artifact
      let savedKey: string | undefined;

      const stage = defineStage({
        id: "save-artifact",
        name: "Save Artifact",
        schemas: {
          input: z.object({}),
          output: z.object({ saved: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          await ctx.storage.save("my-artifact", {
            data: "test-value",
            count: 42,
          });
          savedKey = ctx.storage.getStageKey("save-artifact", "my-artifact");
          return { output: { saved: true } };
        },
      });

      const workflow = new WorkflowBuilder("save-test", "Test", "Test", z.object({}), z.object({ saved: z.boolean() }))
        .pipe(stage)
        .build();

      const { kernel, flush, persistence, blobStore } = createTestKernel([workflow]);

      // When: Execute the workflow
      const runId = await createAndStartRun(kernel, persistence, flush, "save-test");
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "save-test",
        stageId: "save-artifact",
        config: {},
      });

      // Then: Artifact was saved successfully
      expect(result.outcome).toBe("completed");
      expect(result.output).toEqual({ saved: true });
      expect(savedKey).toBeDefined();
      expect(savedKey).toContain("save-artifact");
      // Blob store should have the artifact + the stage output
      expect(blobStore.size()).toBeGreaterThanOrEqual(1);
    });

    it("should save complex nested artifacts", async () => {
      // Given: A stage that saves nested data
      const stage = defineStage({
        id: "save-nested",
        name: "Save Nested",
        schemas: {
          input: z.object({}),
          output: z.object({ saved: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const complexData = {
            metadata: { type: "document", version: 1 },
            pages: [
              { number: 1, content: "First page" },
              { number: 2, content: "Second page" },
            ],
            tags: ["important", "archived"],
          };
          await ctx.storage.save("nested-artifact", complexData);
          return { output: { saved: true } };
        },
      });

      const workflow = new WorkflowBuilder("nested-test", "Test", "Test", z.object({}), z.object({ saved: z.boolean() }))
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const runId = await createAndStartRun(kernel, persistence, flush, "nested-test");
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "nested-test",
        stageId: "save-nested",
        config: {},
      });

      // Then: No error thrown
      expect(result.outcome).toBe("completed");
      expect(result.output).toEqual({ saved: true });
    });
  });

  describe("loading artifacts", () => {
    it("should load saved artifact", async () => {
      // Given: A workflow with two stages - one saves, one loads
      let loadedData: unknown;

      const saveStage = defineStage({
        id: "saver",
        name: "Saver",
        schemas: {
          input: z.object({}),
          output: z.object({ key: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const key = ctx.storage.getStageKey("saver", "shared-data");
          await ctx.storage.save(key, {
            message: "hello from saver",
            value: 123,
          });
          return { output: { key } };
        },
      });

      const loadStage = defineStage({
        id: "loader",
        name: "Loader",
        schemas: {
          input: z.object({ key: z.string() }),
          output: z.object({ loaded: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          loadedData = await ctx.storage.load(ctx.input.key);
          return { output: { loaded: true } };
        },
      });

      const workflow = new WorkflowBuilder("load-test", "Test", "Test", z.object({}), z.object({ loaded: z.boolean() }))
        .pipe(saveStage)
        .pipe(loadStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute both stages
      const runId = await createAndStartRun(kernel, persistence, flush, "load-test");
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "load-test",
        stageId: "saver",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "load-test",
        stageId: "loader",
        config: {},
      });

      // Then: Data was loaded correctly
      expect(loadedData).toEqual({ message: "hello from saver", value: 123 });
    });

    it("should throw when loading non-existent artifact", async () => {
      // Given: A stage that tries to load non-existent artifact
      const stage = defineStage({
        id: "bad-loader",
        name: "Bad Loader",
        schemas: {
          input: z.object({}),
          output: z.object({}),
          config: z.object({}),
        },
        async execute(ctx) {
          await ctx.storage.load("non-existent-key");
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder("bad-load-test", "Test", "Test", z.object({}), z.object({}))
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const runId = await createAndStartRun(kernel, persistence, flush, "bad-load-test");
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "bad-load-test",
        stageId: "bad-loader",
        config: {},
      });

      // Then: Execution fails (blob not found)
      expect(result.outcome).toBe("failed");
      expect(result.error).toMatch(/not found/i);
    });
  });

  describe("checking artifact existence", () => {
    it("should check if artifact exists", async () => {
      // Given: A stage that saves and then checks existence
      let existsBeforeSave: boolean | undefined;
      let existsAfterSave: boolean | undefined;

      const stage = defineStage({
        id: "existence-check",
        name: "Existence Check",
        schemas: {
          input: z.object({}),
          output: z.object({ beforeSave: z.boolean(), afterSave: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const key = ctx.storage.getStageKey("existence-check", "test-key");

          // Check before saving
          existsBeforeSave = await ctx.storage.exists(key);

          // Save artifact
          await ctx.storage.save(key, { data: "exists now" });

          // Check after saving
          existsAfterSave = await ctx.storage.exists(key);

          return {
            output: {
              beforeSave: existsBeforeSave,
              afterSave: existsAfterSave,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder("exists-test", "Test", "Test", z.object({}), z.object({ beforeSave: z.boolean(), afterSave: z.boolean() }))
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const runId = await createAndStartRun(kernel, persistence, flush, "exists-test");
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "exists-test",
        stageId: "existence-check",
        config: {},
      });

      // Then: Existence checks are correct
      expect(existsBeforeSave).toBe(false);
      expect(existsAfterSave).toBe(true);
      expect(result.output).toEqual({ beforeSave: false, afterSave: true });
    });

    it("should return false for non-existent artifact", async () => {
      // Given: A stage that checks non-existent artifact
      let exists: boolean | undefined;

      const stage = defineStage({
        id: "nonexistent-check",
        name: "Nonexistent Check",
        schemas: {
          input: z.object({}),
          output: z.object({ exists: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          exists = await ctx.storage.exists("definitely-not-there");
          return { output: { exists } };
        },
      });

      const workflow = new WorkflowBuilder("nonexistent-test", "Test", "Test", z.object({}), z.object({ exists: z.boolean() }))
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const runId = await createAndStartRun(kernel, persistence, flush, "nonexistent-test");
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "nonexistent-test",
        stageId: "nonexistent-check",
        config: {},
      });

      // Then: Returns false
      expect(exists).toBe(false);
      expect(result.output).toEqual({ exists: false });
    });
  });

  describe("deleting artifacts", () => {
    it("should delete artifact", async () => {
      // Given: A stage that saves, verifies, deletes, and verifies again
      let existsAfterSave: boolean | undefined;
      let existsAfterDelete: boolean | undefined;

      const stage = defineStage({
        id: "delete-artifact",
        name: "Delete Artifact",
        schemas: {
          input: z.object({}),
          output: z.object({
            afterSave: z.boolean(),
            afterDelete: z.boolean(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const key = ctx.storage.getStageKey("delete-artifact", "to-delete");

          // Save artifact
          await ctx.storage.save(key, { data: "will be deleted" });
          existsAfterSave = await ctx.storage.exists(key);

          // Delete artifact
          await ctx.storage.delete(key);
          existsAfterDelete = await ctx.storage.exists(key);

          return {
            output: {
              afterSave: existsAfterSave,
              afterDelete: existsAfterDelete,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder("delete-test", "Test", "Test", z.object({}), z.object({ afterSave: z.boolean(), afterDelete: z.boolean() }))
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const runId = await createAndStartRun(kernel, persistence, flush, "delete-test");
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "delete-test",
        stageId: "delete-artifact",
        config: {},
      });

      // Then: Artifact was deleted
      expect(existsAfterSave).toBe(true);
      expect(existsAfterDelete).toBe(false);
      expect(result.output).toEqual({ afterSave: true, afterDelete: false });
    });

    it("should not throw when deleting non-existent artifact", async () => {
      // Given: A stage that deletes non-existent artifact
      const stage = defineStage({
        id: "delete-nonexistent",
        name: "Delete Nonexistent",
        schemas: {
          input: z.object({}),
          output: z.object({ completed: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          // Should not throw
          await ctx.storage.delete("does-not-exist");
          return { output: { completed: true } };
        },
      });

      const workflow = new WorkflowBuilder("delete-nonexistent-test", "Test", "Test", z.object({}), z.object({ completed: z.boolean() }))
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const runId = await createAndStartRun(kernel, persistence, flush, "delete-nonexistent-test");
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "delete-nonexistent-test",
        stageId: "delete-nonexistent",
        config: {},
      });

      // Then: Execution completes without error
      expect(result.outcome).toBe("completed");
      expect(result.output).toEqual({ completed: true });
    });
  });

  describe("key generation", () => {
    it("should generate unique stage key", async () => {
      // Given: A stage that generates keys with different suffixes
      let key1: string | undefined;
      let key2: string | undefined;
      let key3: string | undefined;

      const stage = defineStage({
        id: "key-generator",
        name: "Key Generator",
        schemas: {
          input: z.object({}),
          output: z.object({
            key1: z.string(),
            key2: z.string(),
            key3: z.string(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          key1 = ctx.storage.getStageKey("stage-a");
          key2 = ctx.storage.getStageKey("stage-a", "custom-suffix.json");
          key3 = ctx.storage.getStageKey("stage-b");

          return { output: { key1, key2, key3 } };
        },
      });

      const workflow = new WorkflowBuilder("key-gen-test", "Test", "Test", z.object({}), z.object({ key1: z.string(), key2: z.string(), key3: z.string() }))
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const runId = await createAndStartRun(kernel, persistence, flush, "key-gen-test");
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "key-gen-test",
        stageId: "key-generator",
        config: {},
      });

      // Then: Keys are generated correctly
      expect(key1).toBeDefined();
      expect(key2).toBeDefined();
      expect(key3).toBeDefined();

      // Keys should contain workflow run ID
      expect(key1).toContain(runId);
      expect(key2).toContain(runId);
      expect(key3).toContain(runId);

      // Keys should contain stage IDs
      expect(key1).toContain("stage-a");
      expect(key2).toContain("stage-a");
      expect(key3).toContain("stage-b");

      // Different stages or suffixes should produce different keys
      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);

      // Custom suffix should be included
      expect(key2).toContain("custom-suffix.json");
    });

    it("should generate keys with default output.json suffix", async () => {
      // Given: A stage that generates a key without custom suffix
      let generatedKey: string | undefined;

      const stage = defineStage({
        id: "default-suffix",
        name: "Default Suffix",
        schemas: {
          input: z.object({}),
          output: z.object({ key: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          generatedKey = ctx.storage.getStageKey("my-stage");
          return { output: { key: generatedKey } };
        },
      });

      const workflow = new WorkflowBuilder("default-suffix-test", "Test", "Test", z.object({}), z.object({ key: z.string() }))
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute
      const runId = await createAndStartRun(kernel, persistence, flush, "default-suffix-test");
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "default-suffix-test",
        stageId: "default-suffix",
        config: {},
      });

      // Then: Key has output.json suffix
      expect(generatedKey).toBeDefined();
      expect(generatedKey).toContain("output.json");
    });
  });

  describe("cross-stage storage", () => {
    it("should allow multiple stages to share artifacts via storage", async () => {
      // Given: Three stages that share data through storage
      let finalData: unknown;

      const stage1 = defineStage({
        id: "producer",
        name: "Producer",
        schemas: {
          input: z.object({}),
          output: z.object({ key: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const key = ctx.storage.getStageKey("producer", "shared-artifact");
          await ctx.storage.save(key, { step1: "data from producer" });
          return { output: { key } };
        },
      });

      const stage2 = defineStage({
        id: "transformer",
        name: "Transformer",
        schemas: {
          input: z.object({ key: z.string() }),
          output: z.object({ key: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const data = await ctx.storage.load<{ step1: string }>(ctx.input.key);
          const newKey = ctx.storage.getStageKey(
            "transformer",
            "transformed-artifact",
          );
          await ctx.storage.save(newKey, {
            ...data,
            step2: "data from transformer",
          });
          return { output: { key: newKey } };
        },
      });

      const stage3 = defineStage({
        id: "consumer",
        name: "Consumer",
        schemas: {
          input: z.object({ key: z.string() }),
          output: z.object({ success: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          finalData = await ctx.storage.load(ctx.input.key);
          return { output: { success: true } };
        },
      });

      const workflow = new WorkflowBuilder("cross-stage-test", "Test", "Test", z.object({}), z.object({ success: z.boolean() }))
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: Execute all stages in order
      const runId = await createAndStartRun(kernel, persistence, flush, "cross-stage-test");
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "cross-stage-test",
        stageId: "producer",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "cross-stage-test",
        stageId: "transformer",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "cross-stage-test",
        stageId: "consumer",
        config: {},
      });

      // Then: Final stage has combined data
      expect(finalData).toEqual({
        step1: "data from producer",
        step2: "data from transformer",
      });
    });
  });
});
