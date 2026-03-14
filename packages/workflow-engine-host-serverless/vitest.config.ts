import path from "node:path";
import { defineConfig } from "vitest/config";

const coreSrc = path.resolve(__dirname, "../workflow-engine/src");

export default defineConfig({
  resolve: {
    alias: {
      "@bratsos/workflow-engine/kernel/testing": path.join(coreSrc, "kernel/testing/index.ts"),
      "@bratsos/workflow-engine/kernel": path.join(coreSrc, "kernel/index.ts"),
      "@bratsos/workflow-engine/testing": path.join(coreSrc, "testing/index.ts"),
      "@bratsos/workflow-engine": path.join(coreSrc, "index.ts"),
    },
  },
  test: {
    globals: false,
  },
});
