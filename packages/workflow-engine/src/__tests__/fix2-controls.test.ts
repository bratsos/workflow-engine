import { AsyncResource } from "node:async_hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../core/stage-factory.js";
import { WorkflowBuilder } from "../core/workflow.js";
import { executeJobWithHeartbeat } from "../kernel/helpers/host-support.js";
import { createPrismaWorkflowPersistence } from "../persistence/prisma/index.js";
import { withTransactionWriteGuard } from "../persistence/prisma/transaction-writes.js";
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

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const logged = async () =>
      (
        await db.client.workflowLog.findMany({ orderBy: { message: "asc" } })
      ).map((row: any) => row.message);
    const schema = z.object({ value: z.string() });
    const oneStage = (execute: (ctx: any) => Promise<{ output: any }>) =>
      new WorkflowBuilder("controls", "Controls", "controls", schema, schema)
        .pipe(
          defineStage({
            id: "first",
            name: "First",
            schemas: { input: schema, output: schema, config: z.object({}) },
            execute,
          }),
        )
        .build();

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
      "runs an outer adapter write after rollback when async context is lost",
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
          await late;
          expect(await logged()).toEqual(["late"]);
        } finally {
          resource.emitDestroy();
        }
      },
      15_000,
    );

    it.skipIf(!sqlite || process.env.PRISMA_MAJOR === "8")(
      "runs a root adapter write after a consumer's native transaction rolls back",
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
          await late;
          expect(await logged()).toEqual(["late"]);
        } finally {
          resource.emitDestroy();
        }
      },
    );

    it.skipIf(!sqlite)(
      "invalidates a transaction's own queued writes on an explicit rollback and releases the gate",
      async () => {
        let late: Promise<void> | undefined;
        await expect(
          db.persistence.withTransaction(async (tx) => {
            await tx.createLog({ level: "INFO", message: "rollback" });
            late = db.persistence.createLog({ level: "INFO", message: "late" });
            late.catch(() => {});
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
        expect(await logged()).toEqual(["after rollback"]);
      },
    );

    it.each([
      "adapter",
      "client",
    ] as const)("lets an unrelated writer survive the rollback of another %s transaction", async (kind) => {
      let opened!: () => void;
      const entered = new Promise<void>((resolve) => {
        opened = resolve;
      });
      const abort = async () => {
        opened();
        await sleep(50);
        throw new Error("abort transaction");
      };
      const transaction =
        kind === "adapter"
          ? db.persistence.withTransaction(async (tx) => {
              await tx.createLog({ level: "INFO", message: "rolled back" });
              await abort();
            })
          : db.client.$transaction(async (tx: any) => {
              await tx.workflowLog.create({
                data: { level: "INFO", message: "rolled back" },
              });
              await abort();
            });
      await entered;
      const writes = Promise.all([
        db.persistence.createLog({ level: "INFO", message: "unrelated write" }),
        db.persistence.withTransaction((tx) =>
          tx.createLog({ level: "INFO", message: "unrelated transaction" }),
        ),
      ]);
      await expect(transaction).rejects.toThrow("abort transaction");
      await writes;
      expect(await logged()).toEqual([
        "unrelated transaction",
        "unrelated write",
      ]);
    });

    it("finishes kernel work that overlaps other transactions' rollbacks", async () => {
      const workflow = oneStage(async (ctx) => {
        for (const step of ["a", "b", "c", "d"])
          await ctx.step.run(step, async () => {
            await sleep(2);
            return step;
          });
        return { output: ctx.input };
      });
      const kernel = db.makeKernel({
        registry: { getWorkflow: () => workflow },
      });
      const create = (value: unknown) =>
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: crypto.randomUUID(),
          workflowId: workflow.id,
          input: { value } as any,
        });
      let running = true;
      const rollbacks = (async () => {
        while (running) {
          await db.persistence
            .withTransaction(async (tx) => {
              await tx.createLog({ level: "INFO", message: "rolled back" });
              await sleep(4);
              throw new Error("abort transaction");
            })
            .catch(() => {});
          // The handler rejects this input inside the kernel's transaction.
          await create(1).catch(() => {});
        }
      })();
      try {
        for (let round = 0; round < 5; round++) {
          const { workflowRunId } = await create("ok");
          await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
          const job = await db.jobTransport.dequeue();
          const result = await executeJobWithHeartbeat(kernel, {
            jobTransport: db.jobTransport,
            job: job!,
            logPrefix: "[overlap]",
          });
          expect(result.outcome).toBe("completed");
          expect((await db.persistence.getRun(workflowRunId))?.status).toBe(
            "COMPLETED",
          );
        }
      } finally {
        running = false;
        await rollbacks;
      }
      expect(await logged()).toEqual([]);
    }, 30_000);

    it("keeps writes and batches that overlap raw rollbacks and deadlines", async () => {
      let running = true;
      const aborting = (timeout: number, hold: number) =>
        (async () => {
          while (running)
            await db.client
              .$transaction(
                async (tx: any) => {
                  await tx.workflowLog.create({
                    data: { level: "INFO", message: "rolled back" },
                  });
                  await sleep(hold);
                  throw new Error("abort transaction");
                },
                { timeout },
              )
              .catch(() => {});
        })();
      const rollbacks = [aborting(1000, 1), aborting(10, 30)];
      const id = crypto.randomUUID();
      const expected: string[] = [];
      try {
        for (let round = 10; round < 40; round++) {
          expected.push(`write ${round}`);
          await Promise.all([
            db.persistence.createLog({
              level: "INFO",
              message: `write ${round}`,
            }),
            db.jobTransport.enqueueParallel([
              {
                workflowRunId: id,
                workflowId: db.workflow.id,
                stageId: `stage-${round}`,
              },
            ]),
          ]);
        }
      } finally {
        running = false;
        await Promise.all(rollbacks);
      }
      expect(await logged()).toEqual(expected);
      expect(await db.jobTransport.getJobsByWorkflowRun(id)).toHaveLength(30);
    }, 30_000);

    it("does not reject a queued write after its own transaction committed", async () => {
      const client = withTransactionWriteGuard(
        db.client,
        sqlite ? "sqlite" : "postgresql",
      ) as any;
      let long: Promise<unknown> | undefined;
      let late: Promise<void> | undefined;
      await client.$transaction(
        async (tx: any) => {
          await tx.workflowLog.create({
            data: { level: "INFO", message: "committed" },
          });
          long = client.$transaction(
            async () => {
              await sleep(250);
            },
            { timeout: 1000 },
          );
          late = db.persistence.createLog({ level: "INFO", message: "late" });
        },
        { timeout: 100 },
      );
      await long;
      await late;
      expect(await logged()).toEqual(["committed", "late"]);
    });

    it.skipIf(!sqlite).each(["write", "transaction"] as const)(
      "ends a %s queued behind its own transaction at the deadline",
      async (kind) => {
        const client = withTransactionWriteGuard(db.client, "sqlite") as any;
        let own: Promise<unknown> | undefined;
        await expect(
          client.$transaction(
            async (tx: any) => {
              await tx.workflowLog.create({
                data: { level: "INFO", message: "rollback" },
              });
              own =
                kind === "write"
                  ? db.persistence.createLog({
                      level: "INFO",
                      message: "own",
                    })
                  : db.persistence.withTransaction((inner) =>
                      inner.createLog({ level: "INFO", message: "own" }),
                    );
              await own;
            },
            { timeout: 100 },
          ),
        ).rejects.toMatchObject({ code: "P2028" });
        await expect(own).rejects.toMatchObject({ code: "P2028" });
        await db.persistence.createLog({ level: "INFO", message: "after" });
        expect(await logged()).toEqual(["after"]);
      },
    );

    const enqueueClaims = (count: number) =>
      db.jobTransport.enqueueParallel(
        Array.from({ length: count }, (_, index) => ({
          workflowRunId: crypto.randomUUID(),
          workflowId: db.workflow.id,
          stageId: `claim-${index}`,
        })),
      );

    it.skipIf(!sqlite)(
      "gives every concurrent claim on one client its own job",
      async () => {
        const count = 24;
        await enqueueClaims(count);
        const claims = await Promise.all(
          Array.from({ length: count }, () => db.jobTransport.dequeue()),
        );
        expect(new Set(claims.map((job) => job?.stageId)).size).toBe(count);
        expect(claims).not.toContain(null);
      },
    );

    it.skipIf(!sqlite)(
      "rejects only the claim queued behind its own transaction",
      async () => {
        await enqueueClaims(2);
        const client = withTransactionWriteGuard(db.client, "sqlite") as any;
        const unrelated = new AsyncResource("unrelated-host");
        let other: ReturnType<typeof db.jobTransport.dequeue> | undefined;
        let own: Promise<unknown> | undefined;
        try {
          await expect(
            client.$transaction(
              async (tx: any) => {
                await tx.workflowLog.create({
                  data: { level: "INFO", message: "rollback" },
                });
                other = unrelated.runInAsyncScope(() =>
                  db.jobTransport.dequeue(),
                );
                own = db.jobTransport.dequeue();
                await own;
              },
              { timeout: 100 },
            ),
          ).rejects.toMatchObject({ code: "P2028" });
          const claimed = await other;
          await expect(own).rejects.toMatchObject({ code: "P2028" });
          const left = await db.jobTransport.dequeue();
          expect([claimed?.stageId, left?.stageId].sort()).toEqual([
            "claim-0",
            "claim-1",
          ]);
          expect(await logged()).toEqual([]);
        } finally {
          unrelated.emitDestroy();
        }
      },
    );

    it.skipIf(!sqlite).each(["batch", "callback"] as const)(
      "runs a queued %s transaction after a rollback when async context is lost",
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
          await late;
          expect(await db.jobTransport.getJobsByWorkflowRun(id)).toHaveLength(
            kind === "batch" ? 1 : 0,
          );
          expect(await logged()).toEqual(
            kind === "batch" ? [] : ["late callback"],
          );
        } finally {
          resource.emitDestroy();
        }
      },
    );

    it.skipIf(!sqlite)(
      "releases the write queue when a transaction callback never settles",
      async () => {
        await expect(
          db.persistence.withTransaction(async (tx) => {
            await tx.createLog({ level: "INFO", message: "expired callback" });
            await new Promise<never>(() => {});
          }),
        ).rejects.toMatchObject({
          code: "P2028",
          message: expect.stringContaining("timeout passed"),
        });
        await db.persistence.createLog({
          level: "INFO",
          message: "queue released",
        });
        expect(
          (await db.client.workflowLog.findMany()).map(
            (row: any) => row.message,
          ),
        ).toEqual(["queue released"]);
      },
      15_000,
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
      "runs a queued root write after rollback when its async context is lost",
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
          await late;
          expect(await logged()).toEqual(["late"]);
        } finally {
          resource.emitDestroy();
        }
      },
    );

    describe("a signal after its ledger row was reset", () => {
      async function resetSignal() {
        let failing = true;
        const workflow = oneStage(async (ctx) => {
          const value = await ctx.step.waitForSignal("approval", {
            timeout: "10m",
          });
          if (failing) throw new Error("retry me");
          return { output: { value: String(value) } };
        });
        const kernel = db.makeKernel({
          registry: { getWorkflow: () => workflow },
        });
        const id = crypto.randomUUID();
        await db.persistence.createRun({
          id,
          workflowId: workflow.id,
          workflowName: workflow.name,
          workflowType: "controls",
          input: { value: "seed" },
        });
        await db.persistence.updateRun(id, { status: "RUNNING" });
        await db.persistence.createStage({
          workflowRunId: id,
          stageId: "first",
          stageName: "First",
          stageNumber: 1,
          executionGroup: 1,
          status: "PENDING",
        });
        const signal = (payload: unknown) =>
          kernel.dispatch({
            type: "step.signal",
            workflowRunId: id,
            stageId: "first",
            stepId: "approval",
            payload,
          });
        const execute = (attempt: number) =>
          kernel.dispatch({
            type: "job.execute",
            workflowRunId: id,
            workflowId: workflow.id,
            stageId: "first",
            config: {},
            attempt,
            maxAttempts: attempt,
          });
        await signal("first");
        // The last attempt fails, then a re-delivered job resets the ledger.
        await execute(1);
        failing = false;
        expect((await execute(2)).outcome).toBe("suspended");
        const events = async () =>
          (await db.persistence.getUnpublishedOutboxEvents(100))
            .filter((row) => row.eventType === "step:signalled")
            .map((row) => (row.payload as any).payload);
        return { kernel, id, signal, events };
      }

      it("wakes the stage and records the later signal once", async () => {
        const { kernel, signal, id, events } = await resetSignal();
        const future = new Date("2099-01-01T00:00:00Z");
        const stage = await db.persistence.getStage(id, "first");
        await db.persistence.updateStage(stage!.id, { nextPollAt: future });
        await expect(signal("second")).resolves.toMatchObject({
          signalled: true,
          alreadyCompleted: false,
        });
        expect(
          (await db.persistence.getStage(id, "first"))!.nextPollAt!.getTime(),
        ).toBeLessThan(future.getTime());
        await expect(signal("ignored")).resolves.toMatchObject({
          signalled: true,
          alreadyCompleted: true,
        });
        expect(await events()).toEqual(["first", "second"]);
        await expect(
          kernel.dispatch({ type: "stage.pollSuspended" }),
        ).resolves.toMatchObject({ resumed: 1 });
      });

      it("gives parallel later signals one wake and one event", async () => {
        const { signal, events } = await resetSignal();
        const results = await Promise.all(
          ["a", "b", "c", "d"].map((payload) => signal(payload)),
        );
        expect(results.filter((row) => !row.alreadyCompleted)).toHaveLength(1);
        expect(await events()).toHaveLength(2);
      });
    });

    it("leaves no signal wake key behind after run.purge", async () => {
      const { id, stage } = await db.seed("RUNNING", "SUSPENDED");
      await db.kernel.dispatch({
        type: "step.signal",
        workflowRunId: id,
        stageId: "first",
        stepId: "approval",
        payload: true,
      });
      const wakes = () =>
        db.client.idempotencyKey.count({
          where: { commandType: "step.signal.wake" },
        });
      expect(await wakes()).toBe(1);
      await db.persistence.updateRun(id, {
        status: "COMPLETED",
        completedAt: new Date("2020-01-01T00:00:00Z"),
      });
      await db.persistence.updateStage(stage.id, { status: "COMPLETED" });
      await db.kernel.dispatch({ type: "run.purge", olderThan: new Date() });
      expect(await db.persistence.getRun(id)).toBeNull();
      expect(await wakes()).toBe(0);
    });
  },
);
