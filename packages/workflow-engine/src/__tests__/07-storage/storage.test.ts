/**
 * Storage Tests
 *
 * Tests for the storage system including InMemoryStageStorage and StorageFactory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryStageStorage } from "../../core/storage-providers/memory-storage.js";
import {
  createStorage,
  getDefaultStorageProvider,
} from "../../core/storage-factory.js";

describe("I want to use the storage system", () => {
  const workflowRunId = "test-run-123";
  const workflowType = "test-workflow";

  beforeEach(() => {
    // Clear all storage before each test
    InMemoryStageStorage.clear();
  });

  afterEach(() => {
    // Clean up after each test
    InMemoryStageStorage.clear();
  });

  describe("InMemoryStageStorage", () => {
    describe("basic operations", () => {
      it("should save and load data", async () => {
        // Given: A storage instance
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);

        // When: I save and load data
        await storage.save("test-key", { foo: "bar" });
        const loaded = await storage.load<{ foo: string }>("test-key");

        // Then: Data is retrieved correctly
        expect(loaded).toEqual({ foo: "bar" });
      });

      it("should check if key exists", async () => {
        // Given: A storage instance with some data
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);
        await storage.save("existing-key", { data: "value" });

        // When: I check existence
        const exists = await storage.exists("existing-key");
        const notExists = await storage.exists("non-existing-key");

        // Then: Returns correct booleans
        expect(exists).toBe(true);
        expect(notExists).toBe(false);
      });

      it("should delete data", async () => {
        // Given: A storage instance with data
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);
        await storage.save("to-delete", { data: "value" });
        expect(await storage.exists("to-delete")).toBe(true);

        // When: I delete the data
        await storage.delete("to-delete");

        // Then: Data no longer exists
        expect(await storage.exists("to-delete")).toBe(false);
      });

      it("should throw when loading non-existent key", async () => {
        // Given: A storage instance
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);

        // When/Then: Loading non-existent key throws
        await expect(storage.load("non-existent")).rejects.toThrow(
          "Artifact not found",
        );
      });

      it("should deep clone data to prevent mutations", async () => {
        // Given: A storage instance with mutable data
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);
        const original = { nested: { value: "original" } };
        await storage.save("mutable", original);

        // When: I modify the original
        original.nested.value = "mutated";

        // Then: Stored data is not affected
        const loaded = await storage.load<typeof original>("mutable");
        expect(loaded.nested.value).toBe("original");
      });

      it("should deep clone loaded data to prevent mutations", async () => {
        // Given: Stored data
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);
        await storage.save("immutable", { value: "original" });

        // When: I modify loaded data
        const loaded = await storage.load<{ value: string }>("immutable");
        loaded.value = "mutated";

        // Then: Re-loading returns original data
        const reloaded = await storage.load<{ value: string }>("immutable");
        expect(reloaded.value).toBe("original");
      });
    });

    describe("key generation", () => {
      it("should generate stage key with default output.json suffix", () => {
        // Given: A storage instance
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);

        // When: I generate a stage key without suffix
        const key = storage.getStageKey("stage-1");

        // Then: Key has correct pattern
        expect(key).toBe(
          `workflow-v2/${workflowType}/${workflowRunId}/stage-1/output.json`,
        );
      });

      it("should generate stage key with custom suffix", () => {
        // Given: A storage instance
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);

        // When: I generate a stage key with suffix
        const key = storage.getStageKey("stage-1", "custom/path.json");

        // Then: Key has correct pattern with suffix
        expect(key).toBe(
          `workflow-v2/${workflowType}/${workflowRunId}/stage-1/custom/path.json`,
        );
      });
    });

    describe("stage output operations", () => {
      it("should save and load stage output", async () => {
        // Given: A storage instance
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);
        const output = { result: "success", count: 42 };

        // When: I save and load stage output
        const savedKey = await storage.saveStageOutput(
          "extraction-stage",
          output,
        );
        const loaded =
          await storage.loadStageOutput<typeof output>("extraction-stage");

        // Then: Output is saved and loaded correctly
        expect(savedKey).toContain("extraction-stage");
        expect(loaded).toEqual(output);
      });
    });

    describe("artifact operations", () => {
      it("should save and load artifacts", async () => {
        // Given: A storage instance
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);
        const artifact = { pages: [1, 2, 3], metadata: { type: "pdf" } };

        // When: I save and load an artifact
        const savedKey = await storage.saveArtifact(
          "doc-stage",
          "parsed-document",
          artifact,
        );
        const loaded = await storage.loadArtifact<typeof artifact>(
          "doc-stage",
          "parsed-document",
        );

        // Then: Artifact is saved and loaded correctly
        expect(savedKey).toContain("doc-stage");
        expect(savedKey).toContain("artifacts/parsed-document.json");
        expect(loaded).toEqual(artifact);
      });

      it("should list all artifacts", async () => {
        // Given: Multiple artifacts saved
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);
        await storage.saveStageOutput("stage-1", { output: 1 });
        await storage.saveArtifact("stage-1", "artifact-a", { data: "a" });
        await storage.saveStageOutput("stage-2", { output: 2 });
        await storage.saveArtifact("stage-2", "artifact-b", { data: "b" });

        // When: I list all artifacts
        const artifacts = await storage.listAllArtifacts();

        // Then: All artifacts are listed
        expect(artifacts).toHaveLength(4);

        const keys = artifacts.map((a) => a.key);
        expect(
          keys.some((k) => k.includes("stage-1") && k.includes("output.json")),
        ).toBe(true);
        expect(
          keys.some((k) => k.includes("stage-1") && k.includes("artifact-a")),
        ).toBe(true);
        expect(
          keys.some((k) => k.includes("stage-2") && k.includes("output.json")),
        ).toBe(true);
        expect(
          keys.some((k) => k.includes("stage-2") && k.includes("artifact-b")),
        ).toBe(true);
      });
    });

    describe("provider type", () => {
      it("should return memory as provider type", () => {
        // Given: A storage instance
        const storage = new InMemoryStageStorage(workflowRunId, workflowType);

        // Then: Provider type is memory
        expect(storage.providerType).toBe("memory");
      });
    });

    describe("cross-instance access", () => {
      it("should share data across instances for same workflow run", async () => {
        // Given: Two storage instances for same workflow run
        const storage1 = new InMemoryStageStorage(workflowRunId, workflowType);
        const storage2 = new InMemoryStageStorage(workflowRunId, workflowType);

        // When: I save with one and load with another
        await storage1.save("shared-key", { value: "shared" });
        const loaded = await storage2.load<{ value: string }>("shared-key");

        // Then: Data is accessible from both
        expect(loaded.value).toBe("shared");
      });

      it("should isolate data between different workflow runs", async () => {
        // Given: Storage instances for different workflow runs
        const storage1 = new InMemoryStageStorage("run-1", workflowType);
        const storage2 = new InMemoryStageStorage("run-2", workflowType);

        // When: I save data to each
        await storage1.save("key", { value: "from-run-1" });
        await storage2.save("key", { value: "from-run-2" });

        // Then: Each has its own data
        const loaded1 = await storage1.load<{ value: string }>("key");
        const loaded2 = await storage2.load<{ value: string }>("key");
        expect(loaded1.value).toBe("from-run-1");
        expect(loaded2.value).toBe("from-run-2");
      });
    });

    describe("static helpers", () => {
      it("should clear specific workflow run storage", async () => {
        // Given: Data in two workflow runs
        const storage1 = new InMemoryStageStorage("run-to-clear", workflowType);
        const storage2 = new InMemoryStageStorage("run-to-keep", workflowType);
        await storage1.save("key", { data: 1 });
        await storage2.save("key", { data: 2 });

        // When: I clear one workflow run
        InMemoryStageStorage.clear("run-to-clear");

        // Then: Only that run is cleared
        expect(await storage2.exists("key")).toBe(true);
        // Recreate storage1 to test cleared state
        const storage1New = new InMemoryStageStorage(
          "run-to-clear",
          workflowType,
        );
        expect(await storage1New.exists("key")).toBe(false);
      });

      it("should clear all storage", async () => {
        // Given: Data in multiple workflow runs
        const storage1 = new InMemoryStageStorage("run-a", workflowType);
        const storage2 = new InMemoryStageStorage("run-b", workflowType);
        await storage1.save("key", { data: 1 });
        await storage2.save("key", { data: 2 });

        // When: I clear all
        InMemoryStageStorage.clear();

        // Then: All storage is cleared
        const all = InMemoryStageStorage.getAll("run-a");
        expect(all.size).toBe(0);
      });

      it("should get all data for workflow run", async () => {
        // Given: Multiple items in storage
        const storage = new InMemoryStageStorage("run-get-all", workflowType);
        await storage.save("key1", { data: 1 });
        await storage.save("key2", { data: 2 });

        // When: I get all data
        const all = InMemoryStageStorage.getAll("run-get-all");

        // Then: All data is returned
        expect(all.size).toBe(2);
        expect(all.has("key1")).toBe(true);
        expect(all.has("key2")).toBe(true);
      });

      it("should return empty map for non-existent workflow run", () => {
        // When: I get all data for non-existent run
        const all = InMemoryStageStorage.getAll("non-existent-run");

        // Then: Empty map returned
        expect(all.size).toBe(0);
      });
    });
  });

  describe("createStorage factory", () => {
    it("should create memory storage", () => {
      // When: I create memory storage
      const storage = createStorage({
        provider: "memory",
        workflowRunId,
        workflowType,
      });

      // Then: Returns InMemoryStageStorage
      expect(storage.providerType).toBe("memory");
    });

    it("should throw for prisma without client", () => {
      // When/Then: Creating prisma storage without client throws
      expect(() =>
        createStorage({
          provider: "prisma",
          workflowRunId,
          workflowType,
        }),
      ).toThrow("Prisma storage requires a prisma client");
    });

    it("should throw for unknown provider", () => {
      // When/Then: Creating with unknown provider throws
      expect(() =>
        createStorage({
          provider: "unknown" as "memory",
          workflowRunId,
          workflowType,
        }),
      ).toThrow("Unknown storage provider");
    });
  });

  describe("getDefaultStorageProvider", () => {
    const originalEnv = process.env.WORKFLOW_STORAGE_PROVIDER;

    afterEach(() => {
      // Restore original env
      if (originalEnv !== undefined) {
        process.env.WORKFLOW_STORAGE_PROVIDER = originalEnv;
      } else {
        delete process.env.WORKFLOW_STORAGE_PROVIDER;
      }
    });

    it("should return prisma as default", () => {
      // Given: No env var set
      delete process.env.WORKFLOW_STORAGE_PROVIDER;

      // When: I get default provider
      const provider = getDefaultStorageProvider();

      // Then: Returns prisma
      expect(provider).toBe("prisma");
    });

    it("should return memory when env var is memory", () => {
      // Given: Env var set to memory
      process.env.WORKFLOW_STORAGE_PROVIDER = "memory";

      // When: I get default provider
      const provider = getDefaultStorageProvider();

      // Then: Returns memory
      expect(provider).toBe("memory");
    });

    it("should return prisma when env var is prisma", () => {
      // Given: Env var set to prisma
      process.env.WORKFLOW_STORAGE_PROVIDER = "prisma";

      // When: I get default provider
      const provider = getDefaultStorageProvider();

      // Then: Returns prisma
      expect(provider).toBe("prisma");
    });

    it("should return prisma for invalid env var", () => {
      // Given: Env var set to invalid value
      process.env.WORKFLOW_STORAGE_PROVIDER = "invalid";

      // When: I get default provider
      const provider = getDefaultStorageProvider();

      // Then: Returns prisma (default)
      expect(provider).toBe("prisma");
    });
  });
});
