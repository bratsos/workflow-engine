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
      "@bratsos/workflow-engine": path.join(coreSrc, "index.ts"),
    },
  },
  test: { globals: false },
});
