import { AsyncResource } from "node:async_hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaWorkflowPersistence } from "../persistence/prisma/index.js";
import {
  type KernelDatabase,
  kernelDatabase,
  kernelWorkflow,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";

describe.skipIf(!realDatabase)(
  "published control regressions on a real database",
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

    async function block(table: string) {
      await db.client.$executeRawUnsafe(
        sqlite
          ? `CREATE TRIGGER control_blocked BEFORE UPDATE ON "${table}" BEGIN SELECT RAISE(ABORT, 'control blocked'); END`
          : "CREATE FUNCTION control_blocked() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'control blocked'; END $$",
      );
      if (!sqlite)
        await db.client.$executeRawUnsafe(
          `CREATE TRIGGER control_blocked BEFORE UPDATE ON "${table}" FOR EACH ROW EXECUTE FUNCTION control_blocked()`,
        );
      return async () => {
        await db.client.$executeRawUnsafe(
          sqlite
            ? "DROP TRIGGER control_blocked"
            : `DROP TRIGGER control_blocked ON "${table}"`,
        );
        if (!sqlite)
          await db.client.$executeRawUnsafe("DROP FUNCTION control_blocked()");
      };
    }

    it.each([
      false,
      true,
    ])("retries the signal wake after a stage update failure (existing wait: %s)", async (waiting) => {
      const { id, stage } = await db.seed("RUNNING", "SUSPENDED");
      const future = new Date("2099-01-01T00:00:00Z");
      await db.persistence.updateStage(stage.id, { nextPollAt: future });
      if (waiting)
        await db.stepLedger.claim({
          stageRecordId: stage.id,
          stepId: "approval",
          seq: 1,
          kind: "signal",
          status: "pending",
          attempt: 1,
          leaseExpiresAt: null,
          deadlineAt: null,
        });
      const unblock = await block("workflow_stages");
      const command = {
        type: "step.signal" as const,
        workflowRunId: id,
        stageId: "first",
        stepId: "approval",
        payload: { approved: true },
      };
      try {
        await expect(db.kernel.dispatch(command)).rejects.toThrow();
      } finally {
        await unblock();
      }
      expect((await db.stepLedger.get(stage.id, "approval"))?.status).toBe(
        "completed",
      );
      await db.kernel.dispatch({ ...command, payload: { approved: false } });
      expect(
        (await db.persistence.getStage(id, "first"))!.nextPollAt!.getTime(),
      ).toBeLessThan(future.getTime());
      await db.kernel.dispatch(command);
      const events = await db.persistence.getUnpublishedOutboxEvents(100);
      const signals = events.filter(
        (row) => row.eventType === "step:signalled",
      );
      expect(signals).toHaveLength(1);
      expect(signals[0]?.payload).toMatchObject({
        payload: { approved: true },
      });
    });

    it.each([
      undefined,
      "provider failed",
    ])("retries poll settlement without replaying the terminal stage (%s)", async (error) => {
      const { id } = await db.seed("RUNNING", "SUSPENDED");
      const workflow = kernelWorkflow(error);
      const kernel = db.makeKernel({
        registry: { getWorkflow: () => workflow },
      });
      const unblock = await block("job_queue");
      try {
        await kernel.dispatch({ type: "stage.pollSuspended" }).catch(() => {});
      } finally {
        await unblock();
      }
      const status = error ? "FAILED" : "COMPLETED";
      expect((await db.persistence.getStage(id, "first"))?.status).toBe(status);
      const before = await db.persistence.getUnpublishedOutboxEvents(100);
      // A new kernel has no in-memory retry state from the failed poll.
      await db
        .makeKernel({ registry: { getWorkflow: () => workflow } })
        .dispatch({ type: "stage.pollSuspended" });
      expect((await db.jobTransport.getJobsByWorkflowRun(id))[0]?.status).toBe(
        status,
      );
      expect(
        (await db.persistence.getStage(id, "first"))?.nextPollAt,
      ).toBeNull();
      expect(await db.persistence.getUnpublishedOutboxEvents(100)).toEqual(
        before,
      );
    });

    it.skipIf(!sqlite)(
      "rejects an outer adapter write after rollback without relying on async context",
      async () => {
        const resource = new AsyncResource("external-adapter-host");
        let late: Promise<void> | undefined;
        try {
          await expect(
            db.persistence.withTransaction(async (tx) => {
              await tx.createLog({ level: "INFO", message: "rollback" });
              late = resource.runInAsyncScope(() =>
                db.persistence.createLog({ level: "INFO", message: "late" }),
              );
              await late;
            }),
          ).rejects.toMatchObject({ code: "P2028" });
          await expect(late).rejects.toMatchObject({ code: "P2028" });
          expect(await db.client.workflowLog.findMany()).toEqual([]);
        } finally {
          resource.emitDestroy();
        }
      },
      15_000,
    );

    it.skipIf(!sqlite || process.env.PRISMA_MAJOR === "8")(
      "fences a root adapter write inside a consumer's native transaction",
      async () => {
        const resource = new AsyncResource("external-native-host");
        let late: Promise<void> | undefined;
        try {
          await expect(
            db.client.$transaction(
              async (tx: any) => {
                await tx.workflowLog.create({
                  data: { level: "INFO", message: "rollback" },
                });
                late = resource.runInAsyncScope(() =>
                  db.persistence.createLog({ level: "INFO", message: "late" }),
                );
                await late;
              },
              { timeout: 100 },
            ),
          ).rejects.toMatchObject({ code: "P2028" });
          await expect(late).rejects.toMatchObject({ code: "P2028" });
          expect(await db.client.workflowLog.findMany()).toEqual([]);
        } finally {
          resource.emitDestroy();
        }
      },
    );

    it.skipIf(!sqlite)(
      "invalidates queued outer writes on an explicit rollback and releases the gate",
      async () => {
        const resource = new AsyncResource("external-rollback-host");
        let late: Promise<void> | undefined;
        try {
          await expect(
            db.persistence.withTransaction(async (tx) => {
              await tx.createLog({ level: "INFO", message: "rollback" });
              late = resource.runInAsyncScope(() =>
                db.persistence.createLog({ level: "INFO", message: "late" }),
              );
              await Promise.resolve();
              throw new Error("abort transaction");
            }),
          ).rejects.toThrow("abort transaction");
          await expect(late).rejects.toMatchObject({ code: "P2028" });
          expect(await db.client.workflowLog.findMany()).toEqual([]);
          await db.persistence.createLog({
            level: "INFO",
            message: "after rollback",
          });
          expect(
            (await db.client.workflowLog.findMany()).map(
              (row: any) => row.message,
            ),
          ).toEqual(["after rollback"]);
        } finally {
          resource.emitDestroy();
        }
      },
    );

    it.skipIf(!sqlite).each(["batch", "callback"] as const)(
      "rejects a queued %s transaction after its enclosing transaction rolls back",
      async (kind) => {
        const resource = new AsyncResource("external-transaction-host");
        const id = crypto.randomUUID();
        let late: Promise<unknown> | undefined;
        try {
          await expect(
            db.client.$transaction(
              async (tx: any) => {
                await tx.workflowLog.create({
                  data: { level: "INFO", message: "outer rollback" },
                });
                late = resource.runInAsyncScope(() =>
                  kind === "batch"
                    ? db.jobTransport.enqueueParallel([
                        {
                          workflowRunId: id,
                          workflowId: db.workflow.id,
                          stageId: "late",
                        },
                      ])
                    : db.persistence.withTransaction((inner) =>
                        inner.createLog({
                          level: "INFO",
                          message: "late callback",
                        }),
                      ),
                );
                await late;
              },
              { timeout: 100 },
            ),
          ).rejects.toMatchObject({ code: "P2028" });
          await expect(late).rejects.toMatchObject({ code: "P2028" });
          expect(await db.jobTransport.getJobsByWorkflowRun(id)).toEqual([]);
          expect(await db.client.workflowLog.findMany()).toEqual([]);
        } finally {
          resource.emitDestroy();
        }
      },
    );

    it.skipIf(!sqlite || process.env.PRISMA_MAJOR !== "7")(
      "balances native nested transaction fences after commit and rollback",
      async () => {
        await db.client.$transaction(async (outer: any) => {
          const scoped = createPrismaWorkflowPersistence(outer, {
            databaseType: "sqlite",
          });
          await scoped.withTransaction((inner) =>
            inner.createLog({ level: "INFO", message: "nested commit" }),
          );
          await expect(
            scoped.withTransaction(async (inner) => {
              await inner.createLog({
                level: "INFO",
                message: "nested rollback",
              });
              throw new Error("abort nested");
            }),
          ).rejects.toThrow("abort nested");
          await scoped.createLog({ level: "INFO", message: "outer commit" });
        });
        await db.persistence.createLog({
          level: "INFO",
          message: "after nested",
        });
        expect(
          (
            await db.client.workflowLog.findMany({
              orderBy: { message: "asc" },
            })
          ).map((row: any) => row.message),
        ).toEqual(["after nested", "nested commit", "outer commit"]);
      },
    );

    it.skipIf(!sqlite || process.env.PRISMA_MAJOR !== "8")(
      "rejects a queued root write after rollback even if its async context is lost",
      async () => {
        const resource = new AsyncResource("external-host");
        let late: Promise<unknown> | undefined;
        try {
          await expect(
            db.client.$transaction(
              async (tx: any) => {
                await tx.workflowLog.create({
                  data: { level: "INFO", message: "rollback" },
                });
                late = resource.runInAsyncScope(() =>
                  Promise.resolve(
                    db.client.workflowLog.create({
                      data: { level: "INFO", message: "late" },
                    }),
                  ),
                );
                await late;
              },
              { timeout: 50 },
            ),
          ).rejects.toMatchObject({ code: "P2028" });
          await expect(late).rejects.toMatchObject({ code: "P2028" });
          expect(await db.client.workflowLog.findMany()).toEqual([]);
        } finally {
          resource.emitDestroy();
        }
      },
    );
  },
);
