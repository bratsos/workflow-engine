/**
 * Stage Storage Tests
 *
 * Tests for the ctx.storage API available within stage execute functions.
 * Covers saving, loading, checking existence, deleting artifacts, and key generation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import { InMemoryStageStorage } from "../../core/storage-providers/memory-storage.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { InMemoryAICallLogger } from "../utils/in-memory-ai-logger.js";
import { InMemoryWorkflowPersistence } from "../utils/in-memory-persistence.js";

describe("I want to use stage storage", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
    InMemoryStageStorage.clear();
  });

  afterEach(() => {
    InMemoryStageStorage.clear();
  });

  // Helper to create a workflow run before execution
  async function createRun(
    runId: string,
    workflowId: string,
    input: unknown = {},
  ) {
    await persistence.createRun({
      id: runId,
      workflowId,
      workflowName: workflowId,
      status: "PENDING",
      input,
    });
  }

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

      const workflow = new WorkflowBuilder("save-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute the workflow
      await createRun("run-save-1", "save-test", {});
      const executor = new WorkflowExecutor(workflow, "run-save-1", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: Artifact was saved successfully
      expect(result).toEqual({ saved: true });
      expect(savedKey).toBeDefined();
      expect(savedKey).toContain("save-artifact");
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

      const workflow = new WorkflowBuilder("nested-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute
      await createRun("run-nested-1", "nested-test", {});
      const executor = new WorkflowExecutor(workflow, "run-nested-1", "test", {
        persistence,
        aiLogger,
      });

      // Then: No error thrown
      const result = await executor.execute({}, {});
      expect(result).toEqual({ saved: true });
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

      const workflow = new WorkflowBuilder("load-test", "Test")
        .pipe(saveStage)
        .pipe(loadStage)
        .build();

      // When: Execute the workflow
      await createRun("run-load-1", "load-test", {});
      const executor = new WorkflowExecutor(workflow, "run-load-1", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

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

      const workflow = new WorkflowBuilder("bad-load-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute
      await createRun("run-bad-load-1", "bad-load-test", {});
      const executor = new WorkflowExecutor(
        workflow,
        "run-bad-load-1",
        "test",
        {
          persistence,
          aiLogger,
        },
      );

      // Then: Execution throws
      await expect(executor.execute({}, {})).rejects.toThrow(/not found/i);
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

      const workflow = new WorkflowBuilder("exists-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute
      await createRun("run-exists-1", "exists-test", {});
      const executor = new WorkflowExecutor(workflow, "run-exists-1", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: Existence checks are correct
      expect(existsBeforeSave).toBe(false);
      expect(existsAfterSave).toBe(true);
      expect(result).toEqual({ beforeSave: false, afterSave: true });
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

      const workflow = new WorkflowBuilder("nonexistent-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute
      await createRun("run-nonexistent-1", "nonexistent-test", {});
      const executor = new WorkflowExecutor(
        workflow,
        "run-nonexistent-1",
        "test",
        {
          persistence,
          aiLogger,
        },
      );

      const result = await executor.execute({}, {});

      // Then: Returns false
      expect(exists).toBe(false);
      expect(result).toEqual({ exists: false });
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

      const workflow = new WorkflowBuilder("delete-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute
      await createRun("run-delete-1", "delete-test", {});
      const executor = new WorkflowExecutor(workflow, "run-delete-1", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: Artifact was deleted
      expect(existsAfterSave).toBe(true);
      expect(existsAfterDelete).toBe(false);
      expect(result).toEqual({ afterSave: true, afterDelete: false });
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

      const workflow = new WorkflowBuilder("delete-nonexistent-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute
      await createRun(
        "run-delete-nonexistent-1",
        "delete-nonexistent-test",
        {},
      );
      const executor = new WorkflowExecutor(
        workflow,
        "run-delete-nonexistent-1",
        "test",
        {
          persistence,
          aiLogger,
        },
      );

      // Then: Execution completes without error
      const result = await executor.execute({}, {});
      expect(result).toEqual({ completed: true });
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

      const workflow = new WorkflowBuilder("key-gen-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute
      await createRun("run-key-gen-1", "key-gen-test", {});
      const executor = new WorkflowExecutor(workflow, "run-key-gen-1", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: Keys are generated correctly
      expect(key1).toBeDefined();
      expect(key2).toBeDefined();
      expect(key3).toBeDefined();

      // Keys should contain workflow run ID
      expect(key1).toContain("run-key-gen-1");
      expect(key2).toContain("run-key-gen-1");
      expect(key3).toContain("run-key-gen-1");

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

      const workflow = new WorkflowBuilder("default-suffix-test", "Test")
        .pipe(stage)
        .build();

      // When: Execute
      await createRun("run-default-suffix-1", "default-suffix-test", {});
      const executor = new WorkflowExecutor(
        workflow,
        "run-default-suffix-1",
        "test",
        {
          persistence,
          aiLogger,
        },
      );

      await executor.execute({}, {});

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

      const workflow = new WorkflowBuilder("cross-stage-test", "Test")
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .build();

      // When: Execute
      await createRun("run-cross-stage-1", "cross-stage-test", {});
      const executor = new WorkflowExecutor(
        workflow,
        "run-cross-stage-1",
        "test",
        {
          persistence,
          aiLogger,
        },
      );

      await executor.execute({}, {});

      // Then: Final stage has combined data
      expect(finalData).toEqual({
        step1: "data from producer",
        step2: "data from transformer",
      });
    });
  });
});
