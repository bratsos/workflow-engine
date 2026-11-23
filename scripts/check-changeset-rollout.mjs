#!/usr/bin/env node
// Fails when a change touches the engine's Prisma schemas or SQL and no
// changed changeset states how to roll it out.
//
//   git diff --name-only "$BASE" "$HEAD" | node scripts/check-changeset-rollout.mjs
//
// stdin: the changed file paths, one per line, relative to the repo root.
import { existsSync, readFileSync } from "node:fs";

const SCHEMA_OR_SQL =
  /^packages\/workflow-engine\/(prisma\/[^/]+\.prisma|sql\/[^/]+\.sql)$/;
const CHANGESET = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;
const ROLLOUT = /rolling-safe|stop old hosts first/i;

const changed = readFileSync(0, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const touched = changed.filter((file) => SCHEMA_OR_SQL.test(file));
if (touched.length === 0) {
  console.log("No schema or SQL change; no rollout statement required.");
  process.exit(0);
}

// A deleted changeset is still in the diff but not on disk.
const stated = changed.filter(
  (file) =>
    CHANGESET.test(file) &&
    existsSync(file) &&
    ROLLOUT.test(readFileSync(file, "utf8")),
);
if (stated.length > 0) {
  console.log(`Rollout stated in ${stated.join(", ")}.`);
  process.exit(0);
}

console.error(
  `This change touches schema or SQL:\n${touched.map((f) => `  ${f}`).join("\n")}\n\n` +
    'Add or edit a changeset under .changeset/ that says "rolling-safe" or\n' +
    '"stop old hosts first", with the reason (see CONTRIBUTING.md).',
);
process.exit(1);
