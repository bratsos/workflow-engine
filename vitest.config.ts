import { defineConfig } from "vitest/config";

/**
 * Root Vitest entry point: boots all four packages' suites in a single
 * `vitest` process (`vitest run` from the repo root) instead of the N
 * separate processes `pnpm -r test` spins up.
 *
 * Each listed directory keeps (or, for workflow-engine, lacks) its own
 * config -- Vitest loads it as an independent project scoped to that
 * directory, so per-package `pnpm test` behavior is unchanged; this file
 * has no effect unless `vitest`/`vitest run` is invoked from the repo
 * root itself.
 *
 * Explicit paths rather than a `packages/*` glob: keeps this list an
 * intentional statement of "the four packages with tests" rather than
 * silently picking up every future `packages/*` entry (e.g. a
 * config-only package that isn't meant to run under Vitest).
 *
 * Deliberately NOT using `isolate: false` / a shared worker pool here --
 * the suite relies on per-file isolation (module-global `registerModels`
 * mutation, `process.env` writes, `vi.mock`), so each project keeps
 * Vitest's default per-file isolation.
 */
export default defineConfig({
  test: {
    projects: [
      "packages/workflow-engine",
      "packages/workflow-engine-host-node",
      "packages/workflow-engine-host-remote",
      "packages/workflow-engine-host-serverless",
    ],
  },
});
