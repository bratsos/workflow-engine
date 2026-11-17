import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureAllScenarios,
  openCaptureDatabase,
  storedRowsDatabase,
  storedRowsReleaseVersion,
} from "../src/__tests__/stored-rows/capture-harness.js";
import { STORED_ROW_SCENARIOS } from "../src/__tests__/stored-rows/scenarios.js";
import { encodeSnapshot } from "../src/__tests__/stored-rows/snapshot.js";
import {
  assertSnapshotWritable,
  releaseTagName,
  selectSnapshotLabel,
} from "../src/__tests__/stored-rows/snapshot-label.js";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(
  process.env.STORED_ROWS_OUTPUT_DIR ?? `${packageDirectory}/src/__tests__/stored-rows/snapshots`,
);
const database = storedRowsDatabase();
const prismaMajor = Number(process.env.PRISMA_MAJOR ?? "7");
const packageVersion = storedRowsReleaseVersion();
const releaseTags = new Set(
  execFileSync("git", ["-C", packageDirectory, "tag", "--list"], {
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean),
);
const tagExists = (tag: string) => releaseTags.has(tag);
const requestedLabel = process.env.STORED_ROWS_SNAPSHOT_LABEL;
if (
  requestedLabel &&
  requestedLabel !== packageVersion &&
  requestedLabel !== `${packageVersion}+next`
) {
  throw new Error(
    `STORED_ROWS_SNAPSHOT_LABEL must be ${packageVersion} or ${packageVersion}+next, got ${requestedLabel}`,
  );
}
if (requestedLabel === packageVersion) {
  const releaseTag = releaseTagName(packageVersion);
  if (!tagExists(releaseTag)) {
    throw new Error(
      `STORED_ROWS_SNAPSHOT_LABEL=${packageVersion} requires release tag "${releaseTag}"`,
    );
  }
  const head = execFileSync(
    "git",
    ["-C", packageDirectory, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const releaseCommit = execFileSync(
    "git",
    ["-C", packageDirectory, "rev-parse", `${releaseTag}^{commit}`],
    { encoding: "utf8" },
  ).trim();
  if (head !== releaseCommit) {
    throw new Error(
      `STORED_ROWS_SNAPSHOT_LABEL=${packageVersion} must be captured from release tag "${releaseTag}"`,
    );
  }
}
const snapshotLabel =
  requestedLabel ?? selectSnapshotLabel(packageVersion, tagExists);

if (!Number.isInteger(prismaMajor) || prismaMajor < 6) {
  throw new Error(`PRISMA_MAJOR must be an integer Prisma major, got ${process.env.PRISMA_MAJOR}`);
}
if (database === "postgresql" && !process.env.DATABASE_URL) {
  throw new Error("Postgres capture requires DATABASE_URL on this command");
}

for (const scenario of STORED_ROW_SCENARIOS) {
  const path = resolve(
    outputRoot,
    snapshotLabel,
    database,
    `prisma-${prismaMajor}`,
    `${scenario}.json`,
  );
  assertSnapshotWritable(snapshotLabel, path, tagExists, existsSync);
}

const db = await openCaptureDatabase();
try {
  const snapshots = await captureAllScenarios(db.client, database, prismaMajor);
  for (const [scenario, snapshot] of snapshots) {
    snapshot.metadata.release = snapshotLabel;
    const path = resolve(
      outputRoot,
      snapshotLabel,
      snapshot.metadata.database,
      `prisma-${snapshot.metadata.prismaMajor}`,
      `${scenario}.json`,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encodeSnapshot(snapshot));
    console.log(`captured ${snapshotLabel} ${database} Prisma ${prismaMajor}: ${scenario}`);
  }
} finally {
  await db.close();
}
