#!/usr/bin/env node
// Prints the newest Prisma 8 release (a release candidate until 8.0.0 ships) of
// `prisma`, `@prisma/orm-postgres` and `@prisma/orm-sqlite` on npm, as
// `name=version` lines. Under GitHub Actions they go to $GITHUB_OUTPUT too.
// Dev, integration and other tagged builds do not match the pattern.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const PACKAGES = {
  prisma: "prisma",
  "orm-postgres": "@prisma/orm-postgres",
  "orm-sqlite": "@prisma/orm-sqlite",
};
const RELEASE = /^8\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

// Higher minor, patch, then rc number; a final release beats its own candidates.
const rank = (version) => {
  const [, minor, patch, rc] = version.match(RELEASE);
  return [Number(minor), Number(patch), rc === undefined ? Infinity : Number(rc)];
};
const newer = (a, b) => {
  const [ra, rb] = [rank(a), rank(b)];
  const i = ra.findIndex((n, k) => n !== rb[k]);
  return i < 0 ? 0 : ra[i] - rb[i];
};

const lines = [];
for (const [key, name] of Object.entries(PACKAGES)) {
  const versions = JSON.parse(
    execFileSync("npm", ["view", name, "versions", "--json"], {
      encoding: "utf8",
    }),
  ).filter((version) => RELEASE.test(version));
  if (versions.length === 0) throw new Error(`npm lists no Prisma 8 ${name}`);
  lines.push(`${key}=${versions.sort(newer).at(-1)}`);
}

console.log(lines.join("\n"));
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}
