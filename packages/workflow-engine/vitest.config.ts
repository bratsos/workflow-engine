import { defineConfig } from "vitest/config";

/**
 * Previously this package ran on Vitest's zero-config defaults (no
 * vitest.config.ts at all). An explicit (near-empty) config is required
 * now that the repo root has its own `vitest.config.ts` with
 * `test.projects` -- without a config file here, Vite/Vitest walks up
 * from this directory, finds the root config instead, and resolves its
 * `projects` entries (e.g. "packages/workflow-engine") against *this*
 * directory as `root`, producing a broken doubled path. This file's
 * presence stops that upward search, so `pnpm test` here keeps running
 * only this package's suite, exactly as before.
 */
export default defineConfig({});
