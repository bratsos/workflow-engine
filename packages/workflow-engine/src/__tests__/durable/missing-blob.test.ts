/**
 * A replay whose blob store lacks a completed stage's output fails with
 * the blob key, not a bare "missing the output of execution group".
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../../core/workflow.js";
import { InMemoryBlobStore } from "../../kernel/testing/in-memory-blob-store.js";
import { createTestHarness } from "../../testing/index.js";

const In = z.object({ v: z.number() });

describe("missing blob on replay", () => {
  it("names the blob key and the shared-store requirement", async () => {
    const workflow = defineWorkflow("missing-blob", { input: In })
      .stage("first", {
        schemas: {
          input: In,
          output: z.object({ v: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { v: ctx.input.v } };
        },
      })
      .stage("second", {
        dependencies: ["first"],
        schemas: {
          input: "none",
          output: z.object({ v: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { v: ctx.require("first").v } };
        },
      })
      .build();
    const blobStore = new InMemoryBlobStore();
    // Another process wrote the first stage's output to a different store.
    const original = blobStore.get.bind(blobStore);
    blobStore.get = async (key: string) => {
      if (key.includes("/first/")) throw new Error(`Blob not found: ${key}`);
      return original(key);
    };
    const harness = createTestHarness({ workflows: [workflow], blobStore });

    // A missing blob is an infrastructure error of the replay, not a stage
    // failure: it propagates (releasing the idempotency key) and names the
    // key and the requirement instead of "missing the output of execution
    // group 1".
    await expect(harness.run("missing-blob", { v: 1 })).rejects.toThrow(
      /Blob ".*\/first\/output\.json" .*share one BlobStore/,
    );
  });
});
