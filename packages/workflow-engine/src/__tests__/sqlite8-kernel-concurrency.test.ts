import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelCommand } from "../kernel/commands.js";
import {
  type KernelDatabase,
  kernelDatabase,
  kernelWorkflow,
  override,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";

const BURST = 100;

describe.skipIf(!realDatabase)(
  "kernel job commands against a real database",
  () => {
    let db: KernelDatabase;
    beforeAll(async () => {
      db = await kernelDatabase();
    }, 120_000);
    beforeEach(async () => {
      await db.reset();
    });
    afterAll(async () => {
      await db?.close();
    });

    async function burst(commands: KernelCommand[], kernel = db.kernel) {
      const results = await Promise.allSettled(
        commands.map((command) => kernel.dispatch(command)),
      );
      expect(results.filter((result) => result.status === "rejected")).toEqual(
        [],
      );
      return results.map(
        (result) => (result as PromiseFulfilledResult<any>).value,
      );
    }

    it.skipIf(!sqlite)(
      "claims 100 runs concurrently and publishes each first-stage job",
      async () => {
        const ids: string[] = [];
        for (let i = 0; i < BURST; i++) {
          ids.push(
            (
              await db.kernel.dispatch({
                type: "run.create",
                idempotencyKey: crypto.randomUUID(),
                workflowId: db.workflow.id,
                input: { value: "claim" },
              })
            ).workflowRunId,
          );
        }
        const results = await burst(
          ids.map(() => ({
            type: "run.claimPending",
            workerId: "burst",
            maxClaims: 1,
          })),
        );
        expect(results.flatMap((result) => result.claimed)).toHaveLength(BURST);
        expect(
          await db.client.jobQueue.count({ where: { status: "PENDING" } }),
        ).toBe(BURST);
        expect(
          await db.client.workflowRun.count({ where: { status: "RUNNING" } }),
        ).toBe(BURST);
      },
      120_000,
    );

    it.skipIf(!sqlite)(
      "transitions 100 runs concurrently and enqueues downstream jobs",
      async () => {
        const ids: string[] = [];
        for (let i = 0; i < BURST; i++) {
          const row = await db.seed("RUNNING", "COMPLETED");
          await db.jobTransport.complete(row.jobId);
          await db.persistence.updateStage(row.stage.id, {
            outputData: { value: "finished" },
          });
          ids.push(row.id);
        }
        expect(
          (
            await burst(
              ids.map((workflowRunId) => ({
                type: "run.transition",
                workflowRunId,
              })),
            )
          ).map((result) => result.action),
        ).toEqual(Array(BURST).fill("advanced"));
        expect(
          await db.client.jobQueue.count({
            where: { stageId: "second", status: "PENDING" },
          }),
        ).toBe(BURST);
      },
      120_000,
    );

    it.skipIf(!sqlite)(
      "cancels 100 runs concurrently with their queued jobs",
      async () => {
        const rows = [];
        for (let i = 0; i < BURST; i++) rows.push(await db.seed());
        expect(
          (
            await burst(
              rows.map(({ id }) => ({ type: "run.cancel", workflowRunId: id })),
            )
          ).map((result) => result.cancelled),
        ).toEqual(Array(BURST).fill(true));
        expect(
          await db.client.jobQueue.count({ where: { status: "CANCELLED" } }),
        ).toBe(BURST);
      },
      120_000,
    );

    it.skipIf(!sqlite).each(["run.redrive", "run.rerunFrom"] as const)(
      "%s replaces 100 runs' jobs concurrently",
      async (type) => {
        const rows = [];
        for (let i = 0; i < BURST; i++)
          rows.push(await db.seed("COMPLETED", "COMPLETED"));
        await burst(
          rows.map(({ id }) =>
            type === "run.redrive"
              ? {
                  type,
                  workflowRunId: id,
                  from: { kind: "stage", stageId: "first" },
                }
              : { type, workflowRunId: id, fromStageId: "first" },
          ),
        );
        expect(
          await db.client.jobQueue.count({ where: { status: "PENDING" } }),
        ).toBe(BURST);
        expect(
          await db.client.workflowRun.count({ where: { status: "RUNNING" } }),
        ).toBe(BURST);
      },
      120_000,
    );

    it.skipIf(!sqlite)(
      "reaps 100 concurrent stuck-run sweeps and restores missing jobs",
      async () => {
        const rows = [];
        for (let i = 0; i < BURST; i++) {
          const row = await db.seed();
          await db.jobTransport.deleteByRunAndStages(row.id, ["first"]);
          await db.client.workflowStage.update({
            where: { id: row.stage.id },
            data: { updatedAt: new Date("2020-01-01T00:00:00Z") },
          });
          await db.client.workflowRun.update({
            where: { id: row.id },
            data: { updatedAt: new Date("2020-01-01T00:00:00Z") },
          });
          rows.push(row);
        }
        await burst(
          rows.map(() => ({ type: "run.reapStuck", stuckThresholdMs: 1000 })),
        );
        expect(
          await db.client.jobQueue.count({ where: { status: "PENDING" } }),
        ).toBe(BURST);
        expect(
          await db.client.workflowRun.count({ where: { status: "RUNNING" } }),
        ).toBe(BURST);
      },
      120_000,
    );

    it("purges with 100 concurrent sweeps and removes every job", async () => {
      for (let i = 0; i < BURST; i++) await db.seed("COMPLETED", "COMPLETED");
      const results = await burst(
        Array.from({ length: BURST }, () => ({
          type: "run.purge",
          olderThan: new Date(),
          limit: 1,
        })),
      );
      expect(results.reduce((sum, result) => sum + result.purged, 0)).toBe(
        BURST,
      );
      expect(await db.client.workflowRun.count()).toBe(0);
      expect(await db.client.jobQueue.count()).toBe(0);
    }, 120_000);

    it.skipIf(!sqlite)(
      "executes 100 durable stages concurrently with real ledger, logs and blobs",
      async () => {
        const workflow = kernelWorkflow(undefined, true);
        const kernel = db.makeKernel({
          registry: { getWorkflow: () => workflow },
        });
        const rows = [];
        for (let i = 0; i < BURST; i++) rows.push(await db.seed());
        expect(
          (
            await burst(
              rows.map(({ id }) => ({
                type: "job.execute",
                workflowRunId: id,
                workflowId: workflow.id,
                stageId: "first",
                config: {},
              })),
              kernel,
            )
          ).map((result) => result.outcome),
        ).toEqual(Array(BURST).fill("completed"));
        expect(
          await db.client.workflowStep.count({
            where: { status: "completed" },
          }),
        ).toBe(BURST);
        expect(await db.client.workflowBlob.count()).toBe(BURST);
        expect(await db.client.workflowLog.count()).toBe(BURST);
      },
      120_000,
    );

    it.skipIf(!sqlite)(
      "heartbeats 100 claimed jobs concurrently",
      async () => {
        const rows = [];
        for (let i = 0; i < BURST; i++) rows.push(await db.seed());
        const old = new Date("2020-01-01T00:00:00Z");
        await db.client.jobQueue.updateMany({
          data: { status: "RUNNING", workerId: "kernel-worker", lockedAt: old },
        });
        await burst(
          rows.map(({ id, jobId }) => ({
            type: "job.heartbeat",
            workflowRunId: id,
            jobId,
          })),
        );
        expect(
          await db.client.jobQueue.count({ where: { lockedAt: { gt: old } } }),
        ).toBe(BURST);
      },
      120_000,
    );

    it.skipIf(!sqlite)(
      "reaps stale and runaway jobs with 100 concurrent commands",
      async () => {
        for (let i = 0; i < BURST; i++) await db.seed();
        await db.client.jobQueue.updateMany({
          data: {
            status: "RUNNING",
            workerId: "dead",
            lockedAt: new Date("2020-01-01T00:00:00Z"),
          },
        });
        const results = await burst(
          Array.from({ length: BURST }, () => ({
            type: "lease.reapStale",
            staleThresholdMs: 1000,
            absoluteTimeoutMs: 60_000,
          })),
        );
        expect(results.reduce((sum, result) => sum + result.released, 0)).toBe(
          BURST,
        );
        expect(
          await db.client.jobQueue.count({ where: { status: "PENDING" } }),
        ).toBe(BURST);
      },
      120_000,
    );

    it.skipIf(!sqlite)(
      "signals 100 durable steps concurrently",
      async () => {
        const rows = [];
        for (let i = 0; i < BURST; i++)
          rows.push(await db.seed("RUNNING", "SUSPENDED"));
        await burst(
          rows.map(({ id }) => ({
            type: "step.signal",
            workflowRunId: id,
            stageId: "first",
            stepId: "approval",
            payload: { approved: true },
          })),
        );
        expect(
          await db.client.workflowStep.count({
            where: { kind: "signal", status: "completed" },
          }),
        ).toBe(BURST);
      },
      120_000,
    );

    it.skipIf(!sqlite)(
      "polls 100 suspended stages concurrently and completes their jobs",
      async () => {
        for (let i = 0; i < BURST; i++) await db.seed("RUNNING", "SUSPENDED");
        const results = await burst(
          Array.from({ length: BURST }, () => ({
            type: "stage.pollSuspended",
            maxChecks: BURST,
          })),
        );
        expect(results.reduce((sum, result) => sum + result.resumed, 0)).toBe(
          BURST,
        );
        expect(
          await db.client.jobQueue.count({ where: { status: "COMPLETED" } }),
        ).toBe(BURST);
      },
      120_000,
    );

    it.skipIf(sqlite).each(["run.purge", "stage.pollSuspended"] as const)(
      "%s survives a pool-sized Postgres burst without P2028",
      async (type) => {
        const size = 10;
        const rows = [];
        for (let i = 0; i < size; i++)
          rows.push(
            await db.seed(
              type === "run.purge" ? "COMPLETED" : "RUNNING",
              type === "run.purge" ? "COMPLETED" : "SUSPENDED",
            ),
          );
        let entered = 0;
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
          release = resolve;
        });
        const kernels = rows.map(({ stage }) =>
          db.makeKernel({
            persistence: override(db.persistence, {
              withTransaction: (fn) =>
                db.persistence.withTransaction(async (tx) => {
                  if (++entered === size) release();
                  await ready;
                  return fn(tx);
                }),
              getSuspendedStages: async (now, options) =>
                (await db.persistence.getSuspendedStages(now, options)).filter(
                  (row) => row.id === stage.id,
                ),
            }),
          }),
        );
        const results = await Promise.allSettled(
          kernels.map((kernel) =>
            kernel.dispatch(
              type === "run.purge"
                ? { type, olderThan: new Date() }
                : { type, maxChecks: size },
            ),
          ),
        );
        expect(
          results.filter((result) => result.status === "rejected"),
        ).toEqual([]);
        expect(entered).toBe(size);
        expect(
          await db.client.jobQueue.count({
            where: type === "run.purge" ? {} : { status: "SUSPENDED" },
          }),
        ).toBe(0);
      },
      30_000,
    );
  },
);

// The Prisma 8 SQLite driver hands a root read's rows over across microtasks,
// holding its read lock between them. An engine transaction commits on another
// connection of the same process: on a rollback journal its COMMIT waited its
// busy timeout synchronously and failed; in WAL a root write behind it failed
// with SQLITE_BUSY_SNAPSHOT. Both must commit.
describe
  .skipIf(!sqlite || process.env.PRISMA_MAJOR !== "8")
  .each(["delete", "wal"] as const)(
  "an engine transaction while a root read hands over rows, journal mode %s",
  (mode) => {
    let db: KernelDatabase;
    beforeAll(async () => {
      db = await kernelDatabase();
      if (mode === "wal")
        await db.client
          .$withColumns({ journal_mode: "text" })
          .$queryRawUnsafe("PRAGMA journal_mode = WAL");
      for (let i = 0; i < 60; i++)
        await db.kernel.dispatch({
          type: "run.create",
          idempotencyKey: `seed-${i}`,
          workflowId: db.workflow.id,
          input: { value: "seed" },
        });
    }, 120_000);
    afterAll(async () => {
      await db?.close();
    });

    it("commits run.create while getRunsByStatus is in flight", async () => {
      for (let round = 0; round < 3; round++) {
        // Root reads keep starting, so one is in flight whenever the commit comes.
        let done = false;
        const reads = Array.from({ length: 3 }, async () => {
          while (!done) await db.persistence.getRunsByStatus("PENDING");
        });
        const created = await db.kernel
          .dispatch({
            type: "run.create",
            idempotencyKey: `round-${round}`,
            workflowId: db.workflow.id,
            input: { value: "round" },
          })
          .then(
            () => "ok",
            (error: unknown) => error,
          );
        done = true;
        await Promise.all(reads);
        expect(created).toBe("ok");
      }
      expect(await db.client.workflowRun.count()).toBe(63);
    }, 120_000);

    // Reads through Prisma 8's own API on the same client, which the docs
    // suggest for the application's queries, reach the same root connection.
    it.each([
      ["db.orm", () => db.native.orm.WorkflowRun.all()],
      [
        "db.query",
        () =>
          db.native
            .query(
              db.native.raw.sql`SELECT id FROM workflow_runs`
                .returnsRow({ id: "sqlite/text@1" })
                .build(),
            )
            .toArray(),
      ],
    ])(
      "commits run.create while reads through %s are in flight",
      async (_, read) => {
        const before = await db.client.workflowRun.count();
        for (let round = 0; round < 3; round++) {
          let done = false;
          const reads = Array.from({ length: 3 }, async () => {
            while (!done) await read();
          });
          const created = await db.kernel
            .dispatch({
              type: "run.create",
              idempotencyKey: `native-${_}-${round}`,
              workflowId: db.workflow.id,
              input: { value: "native" },
            })
            .then(
              () => "ok",
              (error: unknown) => error,
            );
          done = true;
          await Promise.all(reads);
          expect(created).toBe("ok");
        }
        expect(await db.client.workflowRun.count()).toBe(before + 3);
      },
      120_000,
    );

    // The mode can change after the first commit: the next commit follows it.
    it("follows a journal mode changed after the client's first commit", async () => {
      const other = mode === "wal" ? "delete" : "wal";
      const journal = (to: string) =>
        db.client
          .$withColumns({ journal_mode: "text" })
          .$queryRawUnsafe(`PRAGMA journal_mode = ${to}`);
      try {
        await journal(other);
        let done = false;
        const reads = Array.from({ length: 3 }, async () => {
          while (!done) await db.persistence.getRunsByStatus("PENDING");
        });
        const created = await db.kernel
          .dispatch({
            type: "run.create",
            idempotencyKey: `switched-${mode}`,
            workflowId: db.workflow.id,
            input: { value: "switched" },
          })
          .then(
            () => "ok",
            (error: unknown) => error,
          );
        done = true;
        await Promise.all(reads);
        expect(created).toBe("ok");
      } finally {
        await journal(mode);
      }
    }, 120_000);

    it("does not hold back a root read made inside a transaction's own callback", async () => {
      let early: Promise<unknown> | undefined;
      const before = await db.client.workflowRun.count();
      await db.client.$transaction(async (tx: any) => {
        expect(await db.client.workflowRun.count()).toBe(before);
        // Not awaited by the callback: the commit waits for it instead.
        early = db.client.workflowRun
          .findMany()
          .then((rows: unknown[]) => rows);
        await tx.workflowRun.create({
          data: {
            id: "inside",
            workflowId: db.workflow.id,
            workflowName: "w",
            workflowType: "t",
            input: {},
          },
        });
      });
      expect(await early).toHaveLength(before);
      expect(await db.client.workflowRun.count()).toBe(before + 1);
    }, 30_000);
  },
);
