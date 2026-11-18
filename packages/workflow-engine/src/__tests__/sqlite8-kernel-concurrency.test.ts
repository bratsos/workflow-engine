import { createRequire } from "node:module";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { KernelCommand } from "../kernel/commands.js";
import {
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "../persistence/prisma/index.js";
import { isSqliteBusy } from "../persistence/prisma/sql-errors.js";
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

// A root read whose consumer keeps it open (a for-await loop over db.orm, an
// iterator left unfinished) must never be waited on without a bound: its
// consumer may be awaiting the very write that would wait for it. Each case
// matches the adapter without the read coordination: what completes there
// completes here at once, what fails there fails here as soon, nothing hangs.
describe
  .skipIf(!sqlite || process.env.PRISMA_MAJOR !== "8")
  .each(["delete", "wal"] as const)(
  "a root read its consumer holds, journal mode %s",
  (mode) => {
    let db: KernelDatabase;
    let n = 0;
    const create = () =>
      db.kernel.dispatch({
        type: "run.create",
        idempotencyKey: `held-${mode}-${n++}`,
        workflowId: db.workflow.id,
        input: { value: "held" },
      });
    const settle = async (work: Promise<unknown>) => {
      const start = Date.now();
      const outcome = await work.then(
        () => "ok",
        (error: Error) => error.message,
      );
      return { outcome, ms: Date.now() - start };
    };
    const runs = () => db.client.workflowRun.count();
    beforeAll(async () => {
      db = await kernelDatabase();
      if (mode === "wal")
        await db.client
          .$withColumns({ journal_mode: "text" })
          .$queryRawUnsafe("PRAGMA journal_mode = WAL");
      for (let i = 0; i < 3; i++) await create();
    }, 120_000);
    afterAll(async () => {
      await db?.close();
    });

    it("runs a write awaited inside the loop without waiting for the loop's read", async () => {
      const before = await runs();
      let inside: { outcome: string; ms: number } | undefined;
      let dispatched: { outcome: string; ms: number } | undefined;
      for await (const _ of db.native.orm.WorkflowRun.all()) {
        inside ??= await settle(
          db.client.workflowRun.create({
            data: {
              workflowId: db.workflow.id,
              workflowName: "w",
              workflowType: "t",
              input: {},
            },
          }),
        );
        dispatched ??= await settle(create());
      }
      expect(inside?.outcome).toBe("ok");
      expect(inside!.ms).toBeLessThan(1000);
      // Bounded by the busy timeout (5 s), as without the coordination: on a
      // rollback journal the open read keeps the commit out.
      expect(dispatched!.ms).toBeLessThan(8000);
      if (dispatched!.outcome !== "ok")
        expect(dispatched!.outcome).toMatch(
          /Transaction commit failed|database is locked/,
        );
      // In WAL a refused dispatch may still be stored: the kernel completes
      // its idempotency key after the commit, a known limit on any database.
      expect(await runs()).toBeGreaterThanOrEqual(
        before + 1 + (dispatched!.outcome === "ok" ? 1 : 0),
      );
    }, 30_000);

    it("lets every later caller through after an iterator is left unfinished", async () => {
      const it = db.native.orm.WorkflowRun.all()[Symbol.asyncIterator]();
      try {
        await it.next();
        const dispatched = await settle(create());
        expect(dispatched.ms).toBeLessThan(8000);
        const later = await settle(
          db.client.workflowRun.create({
            data: {
              workflowId: db.workflow.id,
              workflowName: "w",
              workflowType: "t",
              input: {},
            },
          }),
        );
        // In WAL the open read's snapshot is older than the dispatch's commit:
        // a write on its connection fails at once, as without the coordination.
        if (mode === "delete") expect(later).toMatchObject({ outcome: "ok" });
        else expect(later.outcome).toMatch(/^ok$|database is locked/);
        expect(later.ms).toBeLessThan(1000);
        expect(
          (await db.persistence.getRunsByStatus("PENDING")).length,
        ).toBeGreaterThan(0);
        expect(
          (await db.native.orm.WorkflowRun.all().toArray()).length,
        ).toBeGreaterThan(0);
      } finally {
        await it.return?.();
      }
      expect(await settle(create())).toMatchObject({ outcome: "ok" });
    }, 30_000);

    it("finishes a loop of nested root reads while the engine writes beside it", async () => {
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const before = await runs();
      const background = pause(20).then(() => settle(create()));
      let rows = 0;
      for await (const row of db.native.orm.WorkflowRun.all()) {
        await db.persistence.getRun((row as { id: string }).id);
        await db.native.orm.WorkflowRun.all().toArray();
        rows++;
        await pause(1);
      }
      // The loop reads its snapshot: in WAL the dispatch beside it may commit meanwhile.
      expect(rows).toBe(before);
      // As without the coordination: on a rollback journal it fails.
      expect((await background).ms).toBeLessThan(8000);
      expect(await settle(create())).toMatchObject({ outcome: "ok" });
    }, 30_000);
  },
);

// node:sqlite waits for a lock synchronously. Root clients of one process on
// one file write through one queue and a write holds the other roots' reads
// back, so none waits on another for its busy timeout with the event loop
// blocked; an idle flush takes no write lock.
describe
  .skipIf(!sqlite || process.env.PRISMA_MAJOR !== "8")
  .each(["delete", "wal"] as const)(
  "several root clients of one process on the file, journal mode %s",
  (mode) => {
    const { DatabaseSync } =
      process.env.PRISMA_MAJOR === "8"
        ? createRequire(import.meta.url)("node:sqlite")
        : ({} as any);
    let db: KernelDatabase;
    const roots: Array<{ close(): void }> = [];
    beforeEach(async () => {
      db = await kernelDatabase();
      const raw = new DatabaseSync(db.file);
      raw.exec(`PRAGMA journal_mode = ${mode}`);
      raw.close();
    }, 120_000);
    afterEach(async () => {
      for (const root of roots.splice(0)) root.close();
      await db?.close();
    });
    const open = (count: number) =>
      Array.from({ length: count }, (_, i) => {
        const native =
          i === 0
            ? db.native
            : createRequire(
                createRequire(import.meta.url).resolve(
                  "../../../prisma-fixtures/v8-sqlite/index.cjs",
                ),
              )("@prisma/orm-sqlite/runtime").default({
                contract: db.native.contract,
                path: db.file,
              });
        if (i > 0) roots.push(native);
        const persistence = createPrismaWorkflowPersistence(
          i === 0 ? db.client : fromPrisma8(native),
          { databaseType: "sqlite" },
        );
        return { persistence, kernel: db.makeKernel({ persistence }) };
      });
    // The longest a 1 ms timer fired late while `work` ran.
    const loopDelay = async <T>(work: () => Promise<T>) => {
      let late = 0;
      let due = Date.now() + 1;
      const timer = setInterval(() => {
        late = Math.max(late, Date.now() - due);
        due = Date.now() + 1;
      }, 1);
      try {
        const results = await Promise.allSettled([work()]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { result: results[0]!, late };
      } finally {
        clearInterval(timer);
      }
    };

    it.each([
      [2, 0],
      [2, 20],
      [13, 0],
      [13, 20],
    ])(
      "%i roots flush an outbox of %i events and create runs at once without blocking the event loop",
      async (count, events) => {
        const stacks = open(count);
        for (let i = 0; i < events; i++)
          await db.persistence.appendOutboxEvents([
            {
              workflowRunId: `run-${String(i).padStart(2, "0")}`,
              eventType: "probe",
              payload: { i },
              causationId: `c-${i}`,
              occurredAt: new Date(),
            },
          ]);
        // Each root's storage check runs before the burst.
        for (const { persistence } of stacks) await persistence.getRun("warm");
        const { result, late } = await loopDelay(() =>
          Promise.all(
            stacks.flatMap(({ kernel }, i) => [
              kernel.dispatch({ type: "outbox.flush", maxEvents: 1 }),
              kernel.dispatch({
                type: "run.create",
                idempotencyKey: `root-${count}-${events}-${i}`,
                workflowId: db.workflow.id,
                input: { value: "root" },
              }),
            ]),
          ),
        );
        expect(result.status).toBe("fulfilled");
        const values = (result as PromiseFulfilledResult<any[]>).value;
        expect(
          values.reduce((sum, value) => sum + (value.published ?? 0), 0),
        ).toBe(Math.min(count, events));
        expect(late).toBeLessThan(1000);
        expect(await db.client.workflowRun.count()).toBe(count);
      },
      60_000,
    );

    it("commits one root's writes while another root's reads are in flight", async () => {
      const [first, second] = open(2);
      for (let i = 0; i < 60; i++)
        await first!.kernel.dispatch({
          type: "run.create",
          idempotencyKey: `seed-${i}`,
          workflowId: db.workflow.id,
          input: { value: "seed" },
        });
      const run = (await db.client.workflowRun.findFirst({})).id;
      await second!.persistence.getRun("warm");
      let done = false;
      const reads = Array.from({ length: 3 }, async () => {
        while (!done) {
          await second!.persistence.getRunsByStatus("PENDING");
          await new Promise((resolve) => setImmediate(resolve));
        }
      });
      // Versioned updates: a count-returning write (`updateMany`), which runs
      // outside the returning-write path.
      const { result, late } = await loopDelay(async () => {
        for (let i = 0; i < 10; i++) {
          const { version } = (await first!.persistence.getRun(run))!;
          await first!.persistence.updateRun(run, {
            totalTokens: i,
            expectedVersion: version,
          });
        }
      });
      done = true;
      await Promise.all(reads);
      expect(result).toEqual({ status: "fulfilled", value: undefined });
      expect(late).toBeLessThan(1000);
    }, 60_000);

    it("flushes an empty outbox while another connection holds the write lock", async () => {
      const [{ kernel, persistence }] = open(1);
      await persistence.getRun("warm");
      const holder = new DatabaseSync(db.file);
      holder.exec("BEGIN IMMEDIATE");
      try {
        const { result, late } = await loopDelay(() =>
          kernel.dispatch({ type: "outbox.flush", maxEvents: 10 }),
        );
        expect(result).toMatchObject({
          status: "fulfilled",
          value: { published: 0 },
        });
        expect(late).toBeLessThan(1000);
      } finally {
        holder.exec("ROLLBACK");
        holder.close();
      }
    }, 30_000);
  },
);

// A transaction the consumer opens on the root connection itself, before the
// adapter's first call (the takeover is installed then), must never take an
// acknowledged engine write with it: engine writes wait for it to end, for
// at most 5 s, and then fail busy. Ending it is never refused.
describe
  .skipIf(!sqlite || process.env.PRISMA_MAJOR !== "8")
  .each(["delete", "wal"] as const)(
  "a transaction the consumer opens on the root connection, journal mode %s",
  (mode) => {
    // A skipped suite still runs this callback, and Node 22.12 (the Prisma 6
    // and 7 floor) has no node:sqlite to load.
    const { DatabaseSync } =
      process.env.PRISMA_MAJOR === "8"
        ? createRequire(import.meta.url)("node:sqlite")
        : ({} as any);
    let db: KernelDatabase;
    beforeEach(async () => {
      db = await kernelDatabase();
      const raw = new DatabaseSync(db.file);
      raw.exec(`PRAGMA journal_mode = ${mode}`);
      raw.close();
    }, 120_000);
    afterEach(async () => {
      await db?.close();
    });
    const sql = (text: string) =>
      db.native.execute(
        db.native.raw
          .sql([text] as any)
          .affectedCount()
          .build(),
      );
    const settle = (work: Promise<unknown>) =>
      work.then(
        () => "ok",
        (error: Error) => error,
      );
    const create = (key: string) =>
      db.kernel.dispatch({
        type: "run.create",
        idempotencyKey: key,
        workflowId: db.workflow.id,
        input: { value: key },
      });
    // What another connection sees: what is durable.
    const stored = () => {
      const other = new DatabaseSync(db.file);
      try {
        return other
          .prepare("SELECT id, priority FROM workflow_runs ORDER BY id")
          .all();
      } finally {
        other.close();
      }
    };
    // Dates in the form the client binds: the storage check refuses a file that mixes forms.
    const seed = (id: string) =>
      sql(
        `INSERT INTO workflow_runs (id, "workflowId", "workflowName", "workflowType", input, status, priority, "createdAt", "updatedAt") VALUES ('${id}', 'w', 'w', 't', '{}', 'PENDING', 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      );

    it.each([
      "COMMIT",
      "ROLLBACK",
    ])("holds engine writes until the consumer's %s, and keeps each one acknowledged", async (end) => {
      await seed("a");
      await sql("BEGIN");
      await sql("UPDATE workflow_runs SET priority = 7 WHERE id = 'a'");
      const update = settle(
        db.client.workflowRun.updateMany({
          where: { id: "a" },
          data: { priority: 9 },
        }),
      );
      const dispatched = settle(create("inside"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await sql(end);
      expect(await update).toBe("ok");
      expect(await dispatched).toBe("ok");
      expect(stored()).toEqual(
        expect.arrayContaining([{ id: "a", priority: 9 }]),
      );
      expect(stored()).toHaveLength(2);
    }, 30_000);

    it("fails an engine write busy after 5 s when the transaction never ends, and stores nothing of it", async () => {
      await seed("a");
      await sql("BEGIN");
      const start = Date.now();
      const update = await settle(
        db.client.workflowRun.updateMany({
          where: { id: "a" },
          data: { priority: 9 },
        }),
      );
      expect(Date.now() - start).toBeLessThan(7000);
      expect(Date.now() - start).toBeGreaterThan(4000);
      expect(isSqliteBusy(update)).toBe(true);
      expect(String(update)).toMatch(/did not open/);
      await sql("COMMIT");
      expect(stored()).toEqual([{ id: "a", priority: 5 }]);
      await expect(create("after")).resolves.toBeTruthy();
      expect(stored()).toHaveLength(2);
    }, 30_000);

    it("lets a savepoint opened before the takeover end through the wrapper, then refuses a new one", async () => {
      await sql("SAVEPOINT s1");
      await seed("a");
      const update = settle(
        db.client.workflowRun.updateMany({
          where: { id: "a" },
          data: { priority: 9 },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await db.client.$executeRawUnsafe("RELEASE s1");
      expect(await update).toBe("ok");
      expect(stored()).toEqual([{ id: "a", priority: 9 }]);
      await expect(sql("SAVEPOINT s2")).rejects.toThrow(/Use \$transaction/);
      await expect(sql("BEGIN")).rejects.toThrow(/Use \$transaction/);
      // Ending is never refused: SQLite answers it.
      await expect(sql("ROLLBACK")).rejects.toThrow(/no transaction is active/);
      await expect(db.client.$executeRawUnsafe("COMMIT")).rejects.toThrow(
        /no transaction is active/,
      );
    }, 30_000);
  },
);
