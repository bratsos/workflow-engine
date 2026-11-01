import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type KernelDatabase,
  kernelDatabase,
  override,
  realDatabase,
} from "./sqlite8-kernel-utils.js";

const stuckThresholdMs = 1_000;
const staleAfterMs = 120_000;
const terminalAt = new Date("2020-01-02T03:04:05.000Z");

describe.skipIf(!realDatabase)(
  "kernel: run.reapStuck database regressions",
  () => {
    let db: KernelDatabase;
    let failedAt: Date;

    beforeEach(async () => {
      db = await kernelDatabase();
      await db.reset();
      failedAt = new Date(Date.now() + staleAfterMs);
      db.clock.now = () => failedAt;
    });

    afterEach(async () => {
      try {
        await db.reset();
      } finally {
        await db.close();
      }
    });

    it("fails active stages with the stale run and preserves terminal stages", async () => {
      const run = await db.persistence.createRun({
        id: crypto.randomUUID(),
        workflowId: db.workflow.id,
        workflowName: db.workflow.name,
        workflowType: "kernel",
        input: { value: "stale" },
      });
      await db.persistence.updateRun(run.id, {
        status: "RUNNING",
        startedAt: new Date(Date.now() - staleAfterMs),
      });

      await db.persistence.createStage({
        workflowRunId: run.id,
        stageId: "running-child",
        stageName: "Running child",
        stageNumber: 1,
        executionGroup: 1,
        status: "RUNNING",
        startedAt: new Date(Date.now() - staleAfterMs),
      });
      const pending = await db.persistence.createStage({
        workflowRunId: run.id,
        stageId: "pending-child",
        stageName: "Pending child",
        stageNumber: 2,
        executionGroup: 2,
        status: "PENDING",
      });
      const pendingJobId = await db.jobTransport.enqueue({
        workflowRunId: run.id,
        workflowId: run.workflowId,
        stageId: pending.stageId,
      });
      expect(pendingJobId).toBeTruthy();

      const suspended = await db.persistence.createStage({
        workflowRunId: run.id,
        stageId: "suspended-child",
        stageName: "Suspended child",
        stageNumber: 3,
        executionGroup: 3,
        status: "SUSPENDED",
      });
      await db.persistence.updateStage(suspended.id, {
        nextPollAt: failedAt,
        pollInterval: 1_000,
        suspendedState: { batchId: "suspended-batch" },
      });
      const suspendedJobId = await db.jobTransport.enqueue({
        workflowRunId: run.id,
        workflowId: run.workflowId,
        stageId: suspended.stageId,
      });
      await db.jobTransport.suspend(suspendedJobId, failedAt);

      const terminalStages = [
        {
          stageId: "completed-child",
          status: "COMPLETED" as const,
          errorMessage: null,
        },
        {
          stageId: "failed-child",
          status: "FAILED" as const,
          errorMessage: "preserve prior failure",
        },
        {
          stageId: "cancelled-child",
          status: "CANCELLED" as const,
          errorMessage: "preserve prior cancellation",
        },
        {
          stageId: "skipped-child",
          status: "SKIPPED" as const,
          errorMessage: null,
        },
      ];
      const terminalRecords = [];
      for (const [index, stage] of terminalStages.entries()) {
        const record = await db.persistence.createStage({
          workflowRunId: run.id,
          stageId: stage.stageId,
          stageName: stage.stageId,
          stageNumber: index + 4,
          executionGroup: index + 4,
          status: stage.status,
        });
        await db.persistence.updateStage(record.id, {
          completedAt: terminalAt,
          errorMessage: stage.errorMessage,
        });
        terminalRecords.push({ ...record, ...stage });
      }

      const result = await db.kernel.dispatch({
        type: "run.reapStuck",
        stuckThresholdMs,
      });

      const afterRun = await db.persistence.getRun(run.id);
      const afterStages = await db.persistence.getStagesByRun(run.id);
      const stageById = new Map(
        afterStages.map((stage) => [stage.stageId, stage]),
      );
      const message = `Run stuck for >${stuckThresholdMs}ms with no activity`;

      expect(result).toMatchObject({ failed: 1, transitioned: 1, healed: 0 });
      expect(afterRun).toMatchObject({
        status: "FAILED",
        completedAt: failedAt,
        output: {
          error: {
            code: "STUCK_RUN_REAPED",
            message,
            stageStatuses: [
              { stageId: "running-child", status: "RUNNING" },
              { stageId: "pending-child", status: "PENDING" },
              { stageId: "suspended-child", status: "SUSPENDED" },
              ...terminalStages.map(({ stageId, status }) => ({
                stageId,
                status,
              })),
            ],
          },
        },
      });
      expect
        .soft(
          ["running-child", "pending-child", "suspended-child"].map(
            (stageId) => {
              const stage = stageById.get(stageId)!;
              return {
                stageId,
                status: stage.status,
                completedAt: stage.completedAt,
                errorMessage: stage.errorMessage,
                nextPollAt: stage.nextPollAt,
              };
            },
          ),
        )
        .toEqual([
          {
            stageId: "running-child",
            status: "FAILED",
            completedAt: failedAt,
            errorMessage: message,
            nextPollAt: null,
          },
          {
            stageId: "pending-child",
            status: "FAILED",
            completedAt: failedAt,
            errorMessage: message,
            nextPollAt: null,
          },
          {
            stageId: "suspended-child",
            status: "FAILED",
            completedAt: failedAt,
            errorMessage: message,
            nextPollAt: null,
          },
        ]);
      expect(
        terminalRecords.map(({ stageId, status, errorMessage }) => {
          const stage = stageById.get(stageId)!;
          return {
            stageId,
            status: stage.status,
            completedAt: stage.completedAt,
            errorMessage: stage.errorMessage,
            expectedStatus: status,
            expectedErrorMessage: errorMessage,
          };
        }),
      ).toEqual(
        terminalRecords.map(({ stageId, status, errorMessage }) => ({
          stageId,
          status,
          completedAt: terminalAt,
          errorMessage,
          expectedStatus: status,
          expectedErrorMessage: errorMessage,
        })),
      );
    });

    it("does not reap after a competing version update", async () => {
      const run = await db.persistence.createRun({
        id: crypto.randomUUID(),
        workflowId: db.workflow.id,
        workflowName: db.workflow.name,
        workflowType: "kernel",
        input: { value: "stale race" },
      });
      await db.persistence.updateRun(run.id, { status: "RUNNING" });
      await db.persistence.createStage({
        workflowRunId: run.id,
        stageId: "running-child",
        stageName: "Running child",
        stageNumber: 1,
        executionGroup: 1,
        status: "RUNNING",
      });

      const persistence = override(db.persistence, {
        withTransaction: async (fn: any) =>
          db.persistence.withTransaction((tx) =>
            fn(
              override(tx, {
                getStuckRuns: async (stuckSince: Date) => {
                  const runs = await tx.getStuckRuns(stuckSince);
                  const snapshot = runs.find(
                    (candidate) => candidate.id === run.id,
                  );
                  if (snapshot) {
                    await tx.updateRun(snapshot.id, {
                      expectedVersion: snapshot.version,
                    });
                  }
                  return runs;
                },
              }),
            ),
          ),
      });

      const result = await db.makeKernel({ persistence }).dispatch({
        type: "run.reapStuck",
        stuckThresholdMs,
      });

      expect(result).toMatchObject({ failed: 0, transitioned: 0, healed: 0 });
      expect(await db.persistence.getRun(run.id)).toMatchObject({
        status: "RUNNING",
        completedAt: null,
      });
    });
  },
);
