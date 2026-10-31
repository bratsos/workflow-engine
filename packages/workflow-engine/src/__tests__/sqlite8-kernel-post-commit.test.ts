import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type KernelDatabase,
  kernelDatabase,
  kernelWorkflow,
  override,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";
import { wrapStepLedger } from "./utils/step-ledger-double.js";

describe.skipIf(!realDatabase)(
  "kernel side effects against a real database",
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

    async function seedPurge() {
      const row = await db.seed("COMPLETED", "COMPLETED");
      await db.stepLedger.claim({
        stageRecordId: row.stage.id,
        stepId: "work",
        seq: 1,
        kind: "run",
        status: "completed",
        attempt: 1,
        result: "kept on rollback",
        leaseExpiresAt: null,
        deadlineAt: null,
      });
      const key = `workflow-v2/kernel/${row.id}/first/output`;
      await db.blobStore.put(key, { value: "kept on rollback" });
      return { ...row, key };
    }

    it("cleans external data after selection commits and deletes the run last", async () => {
      const { id, stage, key } = await seedPurge();
      const observed: string[] = [];
      const beforeDelete = async (name: string) => {
        expect((await db.persistence.getRun(id))?.status).toBe("COMPLETED");
        observed.push(name);
      };
      const kernel = db.makeKernel({
        stepLedger: wrapStepLedger(db.stepLedger, {
          async clear(recordId) {
            await beforeDelete("ledger");
            await db.stepLedger.clear(recordId);
          },
        }),
        jobTransport: override(db.jobTransport, {
          deleteByRunAndStages: async (runId, stages) => {
            await beforeDelete("jobs");
            return db.jobTransport.deleteByRunAndStages(runId, stages);
          },
        }),
        blobStore: override(db.blobStore, {
          delete: async (blobKey) => {
            await beforeDelete("blob");
            await db.blobStore.delete(blobKey);
          },
        }),
      });
      await expect(
        kernel.dispatch({ type: "run.purge", olderThan: new Date() }),
      ).resolves.toEqual({ purged: 1, workflowRunIds: [id] });
      expect(observed).toEqual(["ledger", "jobs", "blob"]);
      expect(await db.stepLedger.list(stage.id)).toEqual([]);
      expect(await db.jobTransport.getJobsByWorkflowRun(id)).toEqual([]);
      expect(await db.blobStore.has(key)).toBe(false);
      expect(await db.persistence.getRun(id)).toBeNull();
    });

    it("rolls back a purge without removing jobs, ledger results or blobs", async () => {
      const { id, stage, key } = await seedPurge();
      const kernel = db.makeKernel({
        persistence: override(db.persistence, {
          withTransaction: (fn) =>
            db.persistence.withTransaction(async (tx) => {
              await fn(tx);
              throw new Error("abort purge commit");
            }),
        }),
      });
      await expect(
        kernel.dispatch({ type: "run.purge", olderThan: new Date() }),
      ).rejects.toThrow("abort purge commit");
      expect((await db.persistence.getRun(id))?.status).toBe("COMPLETED");
      expect(
        (await db.stepLedger.list(stage.id)).map((row) => row.result),
      ).toEqual(["kept on rollback"]);
      expect(await db.jobTransport.getJobsByWorkflowRun(id)).toHaveLength(1);
      expect(await db.blobStore.has(key)).toBe(true);
    });

    it.each([
      "workflow_steps",
      "job_queue",
      "workflow_blobs",
      "workflow_runs",
    ])("retries purge after a real %s delete failure without losing cleanup keys", async (table) => {
      const rows = [await seedPurge(), await seedPurge()];
      const command = { type: "run.purge" as const, olderThan: new Date() };
      if (sqlite) {
        await db.client.$executeRawUnsafe(
          `CREATE TRIGGER purge_cleanup_blocked BEFORE DELETE ON "${table}" BEGIN SELECT RAISE(ABORT, 'purge cleanup blocked'); END`,
        );
      } else {
        await db.client.$executeRawUnsafe(
          "CREATE FUNCTION purge_cleanup_blocked() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'purge cleanup blocked'; END $$",
        );
        await db.client.$executeRawUnsafe(
          `CREATE TRIGGER purge_cleanup_blocked BEFORE DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION purge_cleanup_blocked()`,
        );
      }
      try {
        await expect(db.kernel.dispatch(command)).rejects.toThrow();
        // Both the interrupted run and the unattempted run remain discoverable.
        for (const { id } of rows) {
          expect((await db.persistence.getRun(id))?.status).toBe("COMPLETED");
        }
        if (table === "job_queue") {
          for (const { id } of rows) {
            expect(await db.jobTransport.getJobsByWorkflowRun(id)).toHaveLength(
              1,
            );
          }
        }
      } finally {
        await db.client.$executeRawUnsafe(
          sqlite
            ? "DROP TRIGGER purge_cleanup_blocked"
            : `DROP TRIGGER purge_cleanup_blocked ON "${table}"`,
        );
        if (!sqlite) {
          await db.client.$executeRawUnsafe(
            "DROP FUNCTION purge_cleanup_blocked()",
          );
        }
      }
      await expect(db.kernel.dispatch(command)).resolves.toEqual({
        purged: 2,
        workflowRunIds: expect.arrayContaining(rows.map(({ id }) => id)),
      });
      for (const { id, stage, key } of rows) {
        expect(await db.persistence.getRun(id)).toBeNull();
        expect(await db.stepLedger.list(stage.id)).toEqual([]);
        expect(await db.jobTransport.getJobsByWorkflowRun(id)).toEqual([]);
        expect(await db.blobStore.has(key)).toBe(false);
      }
      await expect(db.kernel.dispatch(command)).resolves.toEqual({
        purged: 0,
        workflowRunIds: [],
      });
    });

    it.each([
      undefined,
      "provider failed",
    ])("settles a polled job after its stage commits (%s)", async (error) => {
      const { id } = await db.seed("RUNNING", "SUSPENDED");
      const workflow = kernelWorkflow(error);
      const observed: string[] = [];
      const verify = async () => {
        observed.push((await db.persistence.getStage(id, "first"))!.status);
      };
      const kernel = db.makeKernel({
        registry: { getWorkflow: () => workflow },
        jobTransport: override(db.jobTransport, {
          complete: async (jobId) => {
            await verify();
            return db.jobTransport.complete(jobId);
          },
          fail: async (jobId, message, retryable) => {
            await verify();
            return db.jobTransport.fail(jobId, message, retryable);
          },
        }),
      });
      await expect(
        kernel.dispatch({ type: "stage.pollSuspended" }),
      ).resolves.toMatchObject({
        checked: 1,
        resumed: error ? 0 : 1,
        failed: error ? 1 : 0,
      });
      expect(observed).toEqual([error ? "FAILED" : "COMPLETED"]);
      expect((await db.jobTransport.getJobsByWorkflowRun(id))[0]!.status).toBe(
        error ? "FAILED" : "COMPLETED",
      );
    });

    it("keeps a suspended job when the poll outcome transaction rolls back", async () => {
      const { id } = await db.seed("RUNNING", "SUSPENDED");
      const before = await db.persistence.getRun(id);
      const kernel = db.makeKernel({
        persistence: override(db.persistence, {
          withTransaction: (fn) =>
            db.persistence.withTransaction(async (tx) => {
              await fn(tx);
              throw new Error("abort poll commit");
            }),
        }),
      });
      await expect(
        kernel.dispatch({ type: "stage.pollSuspended" }),
      ).rejects.toThrow("abort poll commit");
      expect((await db.persistence.getStage(id, "first"))?.status).toBe(
        "SUSPENDED",
      );
      expect((await db.persistence.getRun(id))?.version).toBe(before?.version);
      expect((await db.jobTransport.getJobsByWorkflowRun(id))[0]!.status).toBe(
        "SUSPENDED",
      );
      expect(await db.persistence.getUnpublishedOutboxEvents(100)).toEqual([]);
    });

    it("keeps the committed poll outcome when best-effort job cleanup fails", async () => {
      const { id } = await db.seed("RUNNING", "SUSPENDED");
      const kernel = db.makeKernel({
        jobTransport: override(db.jobTransport, {
          complete: async () => {
            throw new Error("queue unavailable");
          },
        }),
      });
      await expect(
        kernel.dispatch({ type: "stage.pollSuspended" }),
      ).resolves.toMatchObject({ resumed: 1, failed: 0 });
      expect((await db.persistence.getStage(id, "first"))?.status).toBe(
        "COMPLETED",
      );
      expect((await db.jobTransport.getJobsByWorkflowRun(id))[0]!.status).toBe(
        "SUSPENDED",
      );
    });

    it("reaps job leases without holding a persistence transaction", async () => {
      const { jobId } = await db.seed();
      await db.client.jobQueue.update({
        where: { id: jobId },
        data: {
          status: "RUNNING",
          workerId: "dead",
          lockedAt: new Date("2020-01-01T00:00:00Z"),
        },
      });
      let transactions = 0;
      const kernel = db.makeKernel({
        persistence: override(db.persistence, {
          withTransaction: async (fn) => {
            transactions++;
            return db.persistence.withTransaction(fn);
          },
        }),
      });
      await expect(
        kernel.dispatch({
          type: "lease.reapStale",
          staleThresholdMs: 1000,
          absoluteTimeoutMs: 60_000,
        }),
      ).resolves.toEqual({ released: 1, expired: 0 });
      expect(transactions).toBe(0);
      expect(
        (await db.client.jobQueue.findUnique({ where: { id: jobId } })).status,
      ).toBe("PENDING");
    });

    it("writes durable signal payloads outside the stage/outbox transaction, including spills", async () => {
      const { id } = await db.seed("RUNNING", "SUSPENDED");
      let active = false;
      const writes: string[] = [];
      const outside = (port: string) => {
        expect(active).toBe(false);
        writes.push(port);
      };
      const kernel = db.makeKernel({
        spillThresholdBytes: 1,
        persistence: override(db.persistence, {
          withTransaction: (fn) =>
            db.persistence.withTransaction(async (tx) => {
              active = true;
              try {
                return await fn(tx);
              } finally {
                active = false;
              }
            }),
        }),
        stepLedger: wrapStepLedger(db.stepLedger, {
          claim: async (row) => {
            outside("ledger");
            return db.stepLedger.claim(row);
          },
        }),
        blobStore: override(db.blobStore, {
          put: async (key, data) => {
            outside("blob");
            await db.blobStore.put(key, data);
          },
        }),
      });
      await expect(
        kernel.dispatch({
          type: "step.signal",
          workflowRunId: id,
          stageId: "first",
          stepId: "approval",
          payload: { approved: true },
        }),
      ).resolves.toEqual({
        signalled: true,
        ok: true,
        alreadyCompleted: false,
      });
      expect(writes).toEqual(["blob", "ledger"]);
      expect(
        (await db.persistence.getUnpublishedOutboxEvents(100)).map(
          (event) => event.eventType,
        ),
      ).toEqual(["step:signalled"]);
    });
  },
);
