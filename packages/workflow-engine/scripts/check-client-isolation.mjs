#!/usr/bin/env node
/**
 * Guards the browser-safe `./client` entry point against server-only deps.
 *
 * This exists because of a real shipped regression: `dist/client.js` used to
 * pull in `@anthropic-ai/sdk`, `@google/genai`, and `openai` — all documented
 * as *optional* peers — so any consumer who honored that and skipped them got
 * three `Could not resolve` errors when bundling.
 *
 * The leak was not a direct import. `tsup`'s `splitting: true` puts shared
 * modules in one chunk, and the chunk holding `model-helper.ts` (which client
 * genuinely needs) also held `batch-helper.ts` (which statically imported the
 * vendor SDKs). So a source-level check passes while the build stays dirty —
 * the check has to run against `dist/`.
 *
 * Run after `build`. Wired into the package's `verify` script.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "dist");

/**
 * Packages that must never be reachable from the client entry's module graph.
 * Optional peers belong here: a consumer who did not install them must still
 * be able to bundle `./client`.
 */
const FORBIDDEN = [
  "@ai-sdk/anthropic",
  "@ai-sdk/openai",
  "@anthropic-ai/sdk",
  "@google/genai",
  "@prisma/client",
  "openai",
  "vitest",
];

/** Entry points that must stay free of the forbidden set. */
// `testing/index.js` is imported by plain scripts (tsx seeds, smoke checks)
// as well as test files, so it must not pull vitest in: "Vitest failed to
// access its internal state" is what a consumer sees otherwise.
const GUARDED_ENTRIES = ["client.js", "testing/index.js"];

/** Matches `from "x"` in import/export statements and `import("x")`. */
const STATIC_FROM = /\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function matchAll(source, re) {
  const out = [];
  for (const m of source.matchAll(re)) out.push(m[1]);
  return out;
}

/**
 * Collect every module specifier statically reachable from `entry`, following
 * relative chunk imports. Dynamic `import()` is deliberately NOT followed:
 * a dynamic specifier is what makes an optional peer genuinely optional, and
 * bundlers keep it out of the eager graph.
 */
function collectStaticGraph(entryFile) {
  const seen = new Set();
  const bare = new Set();
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");

    const dynamic = new Set(matchAll(source, DYNAMIC_IMPORT));
    const statics = [
      ...matchAll(source, STATIC_FROM),
      ...matchAll(source, BARE_IMPORT),
    ];

    for (const spec of statics) {
      if (dynamic.has(spec)) continue;
      if (spec.startsWith(".")) {
        queue.push(resolve(dirname(file), spec));
      } else {
        bare.add(spec);
      }
    }
  }

  return { bare, files: seen };
}

function main() {
  if (!existsSync(DIST)) {
    console.error(
      "check-client-isolation: dist/ not found. Run `pnpm build` first.",
    );
    process.exit(1);
  }

  let failed = false;

  for (const entry of GUARDED_ENTRIES) {
    const entryPath = join(DIST, entry);
    if (!existsSync(entryPath)) {
      console.error(`check-client-isolation: missing ${entry} in dist/.`);
      failed = true;
      continue;
    }

    const { bare, files } = collectStaticGraph(entryPath);
    const leaked = FORBIDDEN.filter((pkg) => bare.has(pkg));

    if (leaked.length > 0) {
      failed = true;
      console.error(
        `\n✖ ${entry} statically imports server-only packages: ${leaked.join(", ")}`,
      );
      console.error(
        "  These are optional peers or server-only deps. A consumer who did not\n" +
          "  install them cannot bundle the client entry.\n" +
          "  Fix: make the import dynamic (`await import(...)`) so it stays out of\n" +
          "  the eager graph, or move the module off the client entry's graph.\n" +
          `  Chunks walked: ${[...files].map((f) => f.replace(`${DIST}/`, "")).join(", ")}`,
      );
    } else {
      console.log(
        `✔ ${entry} is clean (${files.size} chunk(s), ${bare.size} external import(s): ${[...bare].sort().join(", ") || "none"})`,
      );
    }
  }

  if (failed) process.exit(1);
  console.log("check-client-isolation: OK");
}

main();
