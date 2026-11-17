import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  captureScenario,
  createReplayRuntime,
  driveToTerminal,
  hostTick,
  openCaptureDatabase,
  storedRowsDatabase,
} from "./capture-harness.js";
import { createScenario, STORED_ROW_SCENARIOS } from "./scenarios.js";
import {
  decodeValue,
  firstShapeDifference,
  loadSnapshot,
  readPrismaSchema,
  type StoredRowsSnapshot,
  snapshotShape,
} from "./snapshot.js";

const snapshotRoot = resolve(new URL("./snapshots", import.meta.url).pathname);
const currentSchema = readPrismaSchema(
  resolve(new URL("../../../prisma/schema.prisma", import.meta.url).pathname),
);
const isGated =
  storedRowsDatabase() === "sqlite" || Boolean(process.env.DATABASE_URL);
const gatedIt = isGated ? it : it.skip;
const CAPTURE_COMMAND =
  "pnpm --filter @bratsos/workflow-engine run capture:stored-rows";

function listSnapshotFiles(directory = snapshotRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? listSnapshotFiles(path)
      : path.endsWith(".json")
        ? [path]
        : [];
  });
}

function loadSnapshots(): Array<{
  path: string;
  snapshot: StoredRowsSnapshot;
}> {
  if (
    !existsSync(snapshotRoot) ||
    !readdirSync(snapshotRoot, { withFileTypes: true }).length
  )
    return [];
  return listSnapshotFiles().map((path) => ({
    path,
    snapshot: JSON.parse(readFileSync(path, "utf8")) as StoredRowsSnapshot,
  }));
}

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function outboxMatches(
  event: Record<string, unknown>,
  row: Record<string, unknown>,
) {
  return (
    event.type === row.eventType &&
    canonical(event) === canonical(decodeValue(row.payload))
  );
}

function newestBaselineByScenario() {
  const snapshots = loadSnapshots();
  const baseline = new Map<string, StoredRowsSnapshot>();
  for (const { snapshot } of snapshots) {
    const previous = baseline.get(snapshot.metadata.scenario);
    if (
      !previous ||
      compareRelease(snapshot.metadata.release, previous.metadata.release) > 0
    ) {
      baseline.set(snapshot.metadata.scenario, snapshot);
    }
  }
  return baseline;
}

function compareRelease(left: string, right: string) {
  const alpha = (value: string) =>
    Number(value.match(/alpha\.(\d+)/)?.[1] ?? 0);
  return alpha(left) - alpha(right);
}

async function assertTerminalRows(client: Record<string, any>) {
  const [runs, stages, steps, jobs] = await Promise.all([
    client.workflowRun.findMany({}),
    client.workflowStage.findMany({}),
    client.workflowStep.findMany({}),
    client.jobQueue.findMany({}),
  ]);
  expect(
    runs.every((row: any) =>
      ["COMPLETED", "FAILED", "CANCELLED"].includes(row.status),
    ),
  ).toBe(true);
  expect(
    stages.every((row: any) =>
      ["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(row.status),
    ),
  ).toBe(true);
  expect(
    steps.every((row: any) => ["completed", "failed"].includes(row.status)),
  ).toBe(true);
  expect(
    jobs.every((row: any) =>
      ["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(row.status),
    ),
  ).toBe(true);
}

describe("stored rows from earlier releases", () => {
  let database: Awaited<ReturnType<typeof openCaptureDatabase>> | undefined;

  afterAll(async () => {
    await database?.close();
  });

  gatedIt(
    "loads each release snapshot and finishes it on the current build",
    async () => {
      const snapshots = loadSnapshots();
      expect(
        snapshots.length,
        "no stored-row snapshots; run the capture command",
      ).toBeGreaterThan(0);
      database = await openCaptureDatabase();

      for (const { path, snapshot } of snapshots) {
        await loadSnapshot(database.client, currentSchema, snapshot);
        const scenario = createScenario(snapshot.metadata.scenario);
        const runtime = createReplayRuntime(database.client, scenario);
        const runId = String(snapshot.tables.WorkflowRun?.[0]?.id ?? "");
        expect(runId, `${path} does not contain a workflow run`).not.toBe("");

        scenario.release();
        await scenario.beforeReplay?.(runtime.kernel, runId, runtime.clock);
        const run = await driveToTerminal(runtime, runId);
        expect(run.status, path).toBe(
          snapshot.metadata.expectedFinalOutcome.status,
        );
        expect(run.output, path).toEqual(
          snapshot.metadata.expectedFinalOutcome.output,
        );

        const capturedSteps = snapshot.tables.WorkflowStep ?? [];
        for (const completed of capturedSteps.filter(
          (step) => step.status === "completed" && step.kind === "run",
        )) {
          const stage = (snapshot.tables.WorkflowStage ?? []).find(
            (row) => row.id === completed.stageRecordId,
          );
          const key = `${String(stage?.stageId)}:${String(completed.stepId)}`;
          if (scenario.completedStepBodies.includes(key)) {
            expect(
              scenario.stepBodyExecutions[key] ?? 0,
              `${path} reran ${key}`,
            ).toBe(0);
          }
        }
        if (snapshot.metadata.scenario === "ai-map-poll") {
          expect(
            scenario.fakeBatch.startCount,
            `${path} resubmitted the batch`,
          ).toBe(0);
          expect(
            scenario.fakeBatch.pollCount,
            `${path} did not poll the stored batch`,
          ).toBeGreaterThan(0);
        }

        await hostTick(runtime);
        const outbox = snapshot.tables.OutboxEvent ?? [];
        const sinkEvents = runtime.eventSink.events as unknown as Record<
          string,
          unknown
        >[];
        for (const row of outbox.filter(
          (event) => event.publishedAt !== null,
        )) {
          expect(
            sinkEvents.some((event: Record<string, unknown>) =>
              outboxMatches(event, row),
            ),
            `${path} republished ${row.id}`,
          ).toBe(false);
        }
        for (const row of outbox.filter(
          (event) => event.publishedAt === null,
        )) {
          expect(
            sinkEvents.filter((event: Record<string, unknown>) =>
              outboxMatches(event, row),
            ),
            `${path} did not publish ${row.id} exactly once`,
          ).toHaveLength(1);
        }
        await assertTerminalRows(database.client);
      }
    },
    5 * 60_000,
  );

  gatedIt(
    "guards stored table and JSON shapes against the newest committed snapshot",
    async () => {
      const baseline = newestBaselineByScenario();
      expect(
        baseline.size,
        "no stored-row snapshots; run the capture command",
      ).toBeGreaterThan(0);
      database ??= await openCaptureDatabase();
      const databaseKind = storedRowsDatabase() as "postgresql" | "sqlite";
      const prismaMajor = Number(process.env.PRISMA_MAJOR ?? "7");

      for (const scenarioId of STORED_ROW_SCENARIOS) {
        const expected = baseline.get(scenarioId);
        expect(
          expected,
          `no committed baseline for ${scenarioId}`,
        ).toBeDefined();
        const captured = await captureScenario(
          database.client,
          scenarioId,
          databaseKind,
          prismaMajor,
        );
        const difference = firstShapeDifference(
          snapshotShape(expected!),
          snapshotShape(captured),
        );
        expect(
          difference,
          difference
            ? `Stored-row shape changed: ${difference}. Run ${CAPTURE_COMMAND} and commit the new snapshot.`
            : undefined,
        ).toBeUndefined();
      }
    },
  );
});
