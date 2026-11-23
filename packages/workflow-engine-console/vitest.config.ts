import path from "node:path";
import { defineConfig } from "vitest/config";

const coreSrc = path.resolve(__dirname, "../workflow-engine/src");

export default defineConfig({
  resolve: {
    alias: {
      "@bratsos/workflow-engine/persistence": path.join(
        coreSrc,
        "persistence/index.ts",
      ),
      "@bratsos/workflow-engine/kernel": path.join(coreSrc, "kernel/index.ts"),
      "@bratsos/workflow-engine/testing": path.join(coreSrc, "testing/index.ts"),
      "@bratsos/workflow-engine": path.join(coreSrc, "index.ts"),
    },
  },
  test: {
    globals: false,
    // Vitest on Bun drops zod's named `z` export (it reads `export default z`
    // as CJS interop); inlining zod avoids that. Nothing changes under Node.
    server: { deps: { inline: process.versions.bun ? ["zod"] : [] } },
  },
});
