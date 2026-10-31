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

    it.skipIf(!sqlite)(
      "purges with 100 concurrent sweeps and removes every job",
      async () => {
        for (let i = 0; i < BURST; i++) await db.seed("COMPLETED", "COMPLETED");
        await burst(
          Array.from({ length: BURST }, () => ({
            type: "run.purge",
            olderThan: new Date(),
            limit: 1,
          })),
        );
        expect(await db.client.workflowRun.count()).toBe(0);
        expect(await db.client.jobQueue.count()).toBe(0);
      },
      120_000,
    );

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
