import path from "node:path";
import { defineConfig, type UserConfig } from "vitest/config";

/**
 * Shared Vitest base config for the host packages
 * (workflow-engine-host-{node,remote,serverless}).
 *
 * Aliases `@bratsos/workflow-engine*` to the sibling `workflow-engine`
 * package's TypeScript source (not its built `dist/`) so host-package
 * tests exercise the same source a `pnpm -r test` / root `vitest run`
 * pass would, without requiring a build step first.
 *
 * Resolved relative to *this file's* location (the repo root), not the
 * consuming package's directory -- every host package lives at
 * `packages/<name>/`, so the path to the core package is identical from
 * each of them, and anchoring it here keeps that logic in one place.
 *
 * Each host package's own `vitest.config.ts` stays a thin file that
 * merges this base with `mergeConfig`, so `pnpm test` (`vitest run` run
 * from inside that package) keeps working unchanged -- Vitest/Vite only
 * loads a config file from the current working directory, it does not
 * walk up to a parent config, so this shared file has no effect on
 * per-package runs unless a package's own config imports it.
 */
const coreSrc = path.resolve(__dirname, "packages/workflow-engine/src");

export const hostPackageBaseConfig: UserConfig = defineConfig({
  resolve: {
    alias: {
      "@bratsos/workflow-engine/kernel/testing": path.join(
        coreSrc,
        "kernel/testing/index.ts",
      ),
      "@bratsos/workflow-engine/kernel": path.join(coreSrc, "kernel/index.ts"),
      "@bratsos/workflow-engine/testing": path.join(coreSrc, "testing/index.ts"),
      "@bratsos/workflow-engine": path.join(coreSrc, "index.ts"),
    },
  },
  test: {
    globals: false,
  },
});
