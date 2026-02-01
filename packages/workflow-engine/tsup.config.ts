import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    client: "src/client.ts",
    "testing/index": "src/testing/index.ts",
    "persistence/index": "src/persistence/index.ts",
    "persistence/prisma/index": "src/persistence/prisma/index.ts",
    "cli/sync-models": "src/cli/sync-models.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // IMPORTANT: splitting=true ensures shared modules (like model-helper.ts)
  // are in a single chunk, so MODEL_REGISTRY is shared across all entry points.
  // Without this, each entry gets its own copy and registerModels() doesn't work.
  splitting: true,
  treeshake: true,
  external: [
    // Peer dependencies - don't bundle these
    "@prisma/client",
    "@anthropic-ai/sdk",
    "@google/genai",
    "openai",
  ],
});
