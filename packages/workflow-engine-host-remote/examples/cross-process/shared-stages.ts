/**
 * Stages shared between orchestrator.ts and worker.ts.
 *
 * Both files import from here so stage IDs and schemas are guaranteed to match.
 *
 * - heavyStage: runs on the remote worker. Writes an array artifact to scoped
 *   storage and returns the key in its output.
 * - makeCoreStage: runs in-process on the orchestrator. Reads the artifact
 *   written by the worker and doubles its length.
 */

import { defineStage } from "@bratsos/workflow-engine";
import { z } from "zod";

export const heavyStage = defineStage({
  id: "heavy",
  name: "Heavy",
  schemas: {
    input: z.object({ seed: z.number() }),
    output: z.object({ artifactKey: z.string(), size: z.number() }),
    config: z.object({}),
  },
  async execute(ctx) {
    console.log(`[worker] Running heavy stage, seed=${ctx.input.seed}`);
    const key = ctx.storage.getStageKey("heavy", "blob.json");
    const payload = { data: new Array(ctx.input.seed).fill("x") };
    await ctx.storage.save(key, payload);
    console.log(`[worker] Artifact saved at key=${key}`);
    return { output: { artifactKey: key, size: payload.data.length } };
  },
});

export function makeCoreStage(blobStore: { get(key: string): Promise<unknown> }) {
  return defineStage({
    id: "core",
    name: "Core",
    schemas: {
      input: z.object({ artifactKey: z.string(), size: z.number() }),
      output: z.object({ doubled: z.number() }),
      config: z.object({}),
    },
    async execute(ctx) {
      const blob = (await blobStore.get(ctx.input.artifactKey)) as {
        data: unknown[];
      };
      return { output: { doubled: blob.data.length * 2 } };
    },
  });
}
