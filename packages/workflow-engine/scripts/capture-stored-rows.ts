import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureAllScenarios,
  openCaptureDatabase,
  storedRowsDatabase,
  storedRowsReleaseVersion,
} from "../src/__tests__/stored-rows/capture-harness.js";
import { encodeSnapshot } from "../src/__tests__/stored-rows/snapshot.js";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(
  process.env.STORED_ROWS_OUTPUT_DIR ?? `${packageDirectory}/src/__tests__/stored-rows/snapshots`,
);
const database = storedRowsDatabase();
const prismaMajor = Number(process.env.PRISMA_MAJOR ?? "7");

if (!Number.isInteger(prismaMajor) || prismaMajor < 6) {
  throw new Error(`PRISMA_MAJOR must be an integer Prisma major, got ${process.env.PRISMA_MAJOR}`);
}
if (database === "postgresql" && !process.env.DATABASE_URL) {
  throw new Error("Postgres capture requires DATABASE_URL on this command");
}

const db = await openCaptureDatabase();
try {
  const snapshots = await captureAllScenarios(db.client, database, prismaMajor);
  for (const [scenario, snapshot] of snapshots) {
    const path = resolve(
      outputRoot,
      snapshot.metadata.release,
      snapshot.metadata.database,
      `prisma-${snapshot.metadata.prismaMajor}`,
      `${scenario}.json`,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encodeSnapshot(snapshot));
    console.log(`captured ${snapshot.metadata.release} ${database} Prisma ${prismaMajor}: ${scenario}`);
  }
} finally {
  await db.close();
}
