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
// node:sqlite before Node 24.16 and 26.1 (every 22.x) reads TEXT back cut at a
// NUL (nodejs/node#61954); on Prisma 8 the engine refuses such a value there.
function nodeCutsNul(): boolean {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    return db.prepare("SELECT ? AS v").get("a\0b").v !== "a\0b";
  } finally {
    db.close();
  }
}
const nulRefused = major === "8" && nodeCutsNul();

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
    {
      name: "40,000 duplicate IDs for one kept key",
      keep: Array(40_000).fill("keep-a") as string[],
      remaining: ["keep-a"],
    },
    {
      name: "40,000 duplicate IDs for multiple kept keys and a missing key",
      keep: Array.from(
        { length: 40_000 },
        (_, index) => ["keep-b", "missing", "keep-a"][index % 3]!,
      ),
      remaining: ["keep-a", "keep-b"],
    },
    {
      name: "32,768 distinct IDs",
      keep: [
        "keep-a",
        ...Array.from({ length: 32_766 }, (_, index) => `missing-${index}`),
        "keep-b",
      ],
      remaining: ["keep-a", "keep-b"],
    },
  ])("clears with $name", async ({ keep, remaining }) => {
    const original = [...keep];
    Object.freeze(keep);

    await createPrismaStepLedger(prisma, options).clearExcept!("stage-1", keep);

    expect(await persistedSteps()).toEqual(expectedSteps(remaining));
    expect(keep).toEqual(original);
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

  async function clearsLiterally(nul: string) {
    const stageRecordId = `stage-3-'"\\雪🧪${nul}suffix`;
    const kept = [`keep-'"\\雪🧪`, `nul${nul}kept`];
    await prisma.workflowStage.create({
      data: {
        id: stageRecordId,
        workflowRunId: "ledger-run",
        stageId: stageRecordId,
        stageName: stageRecordId,
        stageNumber: 3,
        executionGroup: 3,
      },
    });
    const ledger = createPrismaStepLedger(prisma, options);
    for (const [seq, stepId] of [...kept, "nul", `nul${nul}drop`].entries()) {
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
    const keep = ["missing", ...kept];
    const original = [...keep];
    Object.freeze(keep);

    await ledger.clearExcept!(stageRecordId, keep);

    expect(await persistedSteps()).toEqual([
      ...expectedSteps(["keep-a", "keep-b", "drop"]),
      ...kept.map((stepId) => ({
        stageRecordId,
        stepId,
        status: "completed",
        result: { stageRecordId, stepId },
      })),
    ]);
    expect(keep).toEqual(original);
  }

  it.skipIf(nulRefused)(
    "matches Unicode, quotes and NULs literally in stage and step IDs",
    () => clearsLiterally("\0"),
  );

  it("matches Unicode and quotes literally in stage and step IDs", () =>
    clearsLiterally(""));

  it.runIf(nulRefused)(
    "refuses a NUL in a stage ID it would read back cut",
    async () => {
      await expect(
        prisma.workflowStage.create({
          data: {
            id: "stage-nul\0suffix",
            workflowRunId: "ledger-run",
            stageId: "stage-nul",
            stageName: "stage-nul",
            stageNumber: 3,
            executionGroup: 3,
          },
        }),
      ).rejects.toThrow(/NUL character/);
      expect(await prisma.workflowStage.count()).toBe(2);
    },
  );

  it("rolls back a large keep-list deletion with the caller's transaction", async () => {
    const keepStepIds = [
      "keep-a",
      ...Array.from({ length: 32_766 }, (_, index) => `missing-${index}`),
      "keep-b",
    ];
    const original = [...keepStepIds];
    Object.freeze(keepStepIds);
    const rollback = new Error("roll back ledger deletion");

    await expect(
      prisma.$transaction(async (tx: any) => {
        await createPrismaStepLedger(tx, options).clearExcept!(
          "stage-1",
          keepStepIds,
        );
        expect(await persistedSteps(tx)).toEqual(
          expectedSteps(["keep-a", "keep-b"]),
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(await persistedSteps()).toEqual(
      expectedSteps(["keep-a", "keep-b", "drop"]),
    );
    expect(keepStepIds).toEqual(original);
  });
});
