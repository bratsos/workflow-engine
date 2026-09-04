/**
 * Source hygiene guard.
 *
 * A raw NUL byte inside a source file makes git classify the whole file as
 * binary: `git diff` shows no text, `grep` skips it, and a merge on it is a
 * binary conflict that has to be resolved by picking a whole side. Separator
 * NULs in template literals must therefore be written as the `\u0000`
 * escape, which produces the identical string at runtime.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      collectSourceFiles(path, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

describe("source hygiene", () => {
  it("keeps every TypeScript source file free of raw NUL bytes", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const offenders = files
      .filter((path) => readFileSync(path, "latin1").includes("\u0000"))
      .map((path) => path.slice(SRC_ROOT.length));

    // Guards against the scan silently walking an empty tree.
    expect(files.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
