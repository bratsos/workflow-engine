import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPrismaStepLedger,
  fromPrisma8,
} from "../../persistence/prisma/index.js";

const major = process.env.PRISMA_MAJOR ?? "7";
const fixtures = createRequire(import.meta.url)(
  "../../../../prisma-fixtures/index.cjs",
);
const options = { databaseType: "sqlite" } as const;

describe(`SQLite ledger keep lists on Prisma ${major}`, () => {
  let directory: string;
  let prisma: any;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "sqlite8-ledger-bind-"));
    const file = join(directory, "workflow.db");
    if (major === "8") {
      const db = fixtures.createSqliteDb(file);
      try {
        prisma = Object.assign(fromPrisma8(db), {
          $disconnect: () => db.close(),
        });
      } catch (error) {
        db.close();
        throw error;
      }
    } else {
      prisma = fixtures.createSqliteClient(file);
    }
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.workflowStep.deleteMany();
    await prisma.workflowStage.deleteMany();
    await prisma.workflowRun.deleteMany();
    await prisma.workflowRun.create({
      data: {
        id: "ledger-run",
        workflowId: "ledger-bind",
        workflowName: "Ledger bind regression",
        workflowType: "ledger-bind",
        input: {},
      },
    });
    const ledger = createPrismaStepLedger(prisma, options);
    for (const [index, stageRecordId] of ["stage-1", "stage-2"].entries()) {
      await prisma.workflowStage.create({
        data: {
          id: stageRecordId,
          workflowRunId: "ledger-run",
          stageId: stageRecordId,
          stageName: stageRecordId,
          stageNumber: index + 1,
          executionGroup: index + 1,
        },
      });
      for (const [seq, stepId] of ["keep-a", "keep-b", "drop"].entries()) {
        await ledger.claim({
          stageRecordId,
          stepId,
          seq,
          kind: "run",
          status: "completed",
          attempt: 0,
          leaseExpiresAt: null,
          deadlineAt: null,
          result: { stageRecordId, stepId },
        });
      }
    }
  });

  async function persistedSteps(client = prisma) {
    const rows = await client.workflowStep.findMany({
      orderBy: [{ stageRecordId: "asc" }, { seq: "asc" }],
    });
    return rows.map((row: any) => ({
      stageRecordId: row.stageRecordId,
      stepId: row.stepId,
      status: row.status,
      result: row.result,
    }));
  }

  function expectedSteps(kept: string[]) {
    return [
      ...kept.map((stepId) => ({ stageRecordId: "stage-1", stepId })),
      { stageRecordId: "stage-2", stepId: "keep-a" },
      { stageRecordId: "stage-2", stepId: "keep-b" },
      { stageRecordId: "stage-2", stepId: "drop" },
    ].map((row) => ({ ...row, status: "completed", result: row }));
  }

  it.each([
    { name: "one kept key", keys: ["keep-a"], remaining: ["keep-a"] },
    {
      name: "multiple kept keys and a missing key",
      keys: ["keep-b", "missing", "keep-a"],
      remaining: ["keep-a", "keep-b"],
    },
  ])("clears with 32,768 duplicate IDs for $name", async ({
    keys,
    remaining,
  }) => {
    const keepStepIds = Array.from(
      { length: 32_768 },
      (_, index) => keys[index % keys.length]!,
    );
    const original = [...keepStepIds];
    Object.freeze(keepStepIds);

    await createPrismaStepLedger(prisma, options).clearExcept!(
      "stage-1",
      keepStepIds,
    );

    expect(await persistedSteps()).toEqual(expectedSteps(remaining));
    expect(keepStepIds).toEqual(original);
  });

  it.each([
    {
      name: "small",
      keep: ["missing", "keep-b", "keep-b"],
      remaining: ["keep-b"],
    },
    { name: "empty", keep: [], remaining: [] },
  ])("clears with a $name keep list", async ({ keep, remaining }) => {
    const original = [...keep];
    await createPrismaStepLedger(prisma, options).clearExcept!("stage-1", keep);
    expect(await persistedSteps()).toEqual(expectedSteps(remaining));
    expect(keep).toEqual(original);
  });

  it("rolls back a large keep-list deletion with the caller's transaction", async () => {
    const keepStepIds = Array(32_768).fill("keep-a");
    const original = [...keepStepIds];
    const rollback = new Error("roll back ledger deletion");

    await expect(
      prisma.$transaction(async (tx: any) => {
        await createPrismaStepLedger(tx, options).clearExcept!(
          "stage-1",
          keepStepIds,
        );
        expect(await persistedSteps(tx)).toEqual(expectedSteps(["keep-a"]));
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(await persistedSteps()).toEqual(
      expectedSteps(["keep-a", "keep-b", "drop"]),
    );
    expect(keepStepIds).toEqual(original);
  });
});
