#!/usr/bin/env node
// Appends "Tested on: ..." to the newest section of every CHANGELOG.md that
// `changeset version` just changed, so the release notes name the Node, Bun and
// Prisma versions CI ran. Run it right after `changeset version`; it reads
// the Node and Bun versions from .github/workflows/ci.yml and the Prisma
// versions from pnpm-lock.yaml, and skips a section that already has the line.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const lock = readFileSync("pnpm-lock.yaml", "utf8");

// The text of one top-level job, up to the next job.
const job = (name) => {
  const start = ci.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`ci.yml has no job "${name}"`);
  return ci.slice(start + 1).split(/\n  [\w-]+:\n/)[0];
};
const first = (text, pattern, what) => {
  const match = text.match(pattern);
  if (!match) throw new Error(`cannot find ${what} in ci.yml`);
  return match[1];
};

const node = first(job("ci"), /node-version: \[([^\]]+)\]/, "the Node matrix")
  .replaceAll('"', "")
  .replace(/\s*,\s*/g, ", ");
const bun = first(job("bun-conformance"), /bun-version: "?([^"\s]+)"?/, "bun-version");

// A fixture's `prisma` entry in the lockfile: the resolved version without peer suffixes.
const resolved = (fixture, pkg) => {
  const block = lock.split(`\n  packages/prisma-fixtures/${fixture}:\n`)[1];
  const match = block?.split("\n\n")[0].match(
    new RegExp(`\\n      ${pkg}:\\n        specifier: .*\\n        version: ([^(\\s]+)`),
  );
  if (!match) throw new Error(`pnpm-lock.yaml has no ${pkg} for ${fixture}`);
  return match[1];
};

const line =
  `Tested on: Node ${node}; Bun ${bun}; ` +
  `Prisma 6 ${resolved("v6", "prisma")}, 7 ${resolved("v7", "prisma")}, ` +
  `8 ${resolved("v8", "prisma")} (@prisma/orm-postgres ${resolved("v8", "'@prisma/orm-postgres'")}).`;

const changed = execFileSync(
  "git",
  ["diff", "--name-only", "--", "packages/*/CHANGELOG.md"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

for (const file of changed) {
  const text = readFileSync(file, "utf8");
  const start = text.indexOf("\n## ") + 1;
  const end = text.indexOf("\n## ", start);
  const section = text.slice(start, end < 0 ? undefined : end);
  if (section.includes("Tested on:")) continue;
  const body = `${section.trimEnd()}\n\n${line}\n`;
  writeFileSync(
    file,
    text.slice(0, start) + body + (end < 0 ? "" : `${text.slice(end)}`),
  );
  console.log(`${file}: ${line}`);
}
