/**
 * Kernel Tests: one job row per stage across reruns and recovery sweeps
 *
 * `run.rerunFrom` used to delete a stage record and then re-enqueue the
 * same `(workflowRunId, stageId)` with an unconditional insert, leaving
 * the old `job_queue` row behind: on a schema declaring
 * `@@unique([workflowRunId, stageId])` (which this package's reference
 * schema now does) the insert failed, post-commit, wedging the run as
 * RUNNING with a fresh PENDING stage and only a stale terminal job row;
 * on a schema without the unique, every rerun accumulated another row.
 * `run.reapStuck`'s PENDING-without-job sweep re-enqueued through the
 * same path, so the run could never self-heal.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import type { JobRecord } from "../../persistence/interface.js";
import { createTestHarness, createTestKernel } from "../utils/index.js";

const schema = z.object({ data: z.string() });

/** Three piped stages; the middle one throws while `failing` is true. */
function createFlakyPipeline(failing: { value: boolean }) {
  const first = defineStage({
    id: "first",
    name: "First",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
  const middle = defineStage({
    id: "middle",
    name: "Middle",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      if (failing.value) throw new Error("middle stage exploded");
      return { output: ctx.input };
    },
  });
  const last = defineStage({
    id: "last",
    name: "Last",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });

  return new WorkflowBuilder(
    "flaky-pipeline",
    "Flaky Pipeline",
    "Test",
    schema,
    schema,
  )
    .pipe(first)
    .pipe(middle)
    .pipe(last)
    .build();
}

/** Job rows for a run, keyed by stage id. */
function byStage(jobs: JobRecord[]): Map<string, JobRecord[]> {
  const map = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    const list = map.get(job.stageId) ?? [];
    list.push(job);
    map.set(job.stageId, list);
  }
  return map;
}

describe("kernel: rerun and recovery keep one job row per stage", () => {
  it("survives two consecutive reruns of a failed multi-stage run", async () => {
    const failing = { value: true };
    const harness = createTestHarness({
      workflows: [createFlakyPipeline(failing)],
      maxTicks: 60,
    });

    // A multi-stage run whose second stage fails all its attempts.
    const first = await harness.run("flaky-pipeline", { data: "hello" });
    expect(first.status).toBe("FAILED");

    const runId = first.workflowRunId;
    const afterFailure = byStage(
      await harness.jobQueue.getJobsByWorkflowRun(runId),
    );
    expect(afterFailure.get("first")).toHaveLength(1);
    expect(afterFailure.get("middle")).toHaveLength(1);
    expect(afterFailure.get("middle")![0]!.status).toBe("FAILED");

    /** Rerun from `middle` and drive the run back to a terminal state. */
    async function rerun(): Promise<string> {
      await harness.kernel.dispatch({
        type: "run.rerunFrom",
        workflowRunId: runId,
        fromStageId: "middle",
      });
      for (let i = 0; i < 60; i++) {
        await harness.tick([runId]);
        const record = await harness.persistence.getRun(runId);
        if (record && record.status !== "RUNNING") return record.status;
      }
      throw new Error("rerun did not reach a terminal state");
    }

    // Rerun 1 — the stage still fails, so the run fails again. The point
    // is that the enqueue does not throw and does not duplicate rows.
    expect(await rerun()).toBe("FAILED");
    const afterFirstRerun = byStage(
      await harness.jobQueue.getJobsByWorkflowRun(runId),
    );
    expect(afterFirstRerun.get("first")).toHaveLength(1);
    expect(afterFirstRerun.get("middle")).toHaveLength(1);

    // Rerun 2 — the stage is fixed, so the rerun target and the stage
    // after it both run and the run completes.
    failing.value = false;
    expect(await rerun()).toBe("COMPLETED");

    const afterSecondRerun = byStage(
      await harness.jobQueue.getJobsByWorkflowRun(runId),
    );
    expect([...afterSecondRerun.keys()].sort()).toEqual([
      "first",
      "last",
      "middle",
    ]);
    for (const [stageId, rows] of afterSecondRerun) {
      expect(`${stageId}:${rows.length}`).toBe(`${stageId}:1`);
      expect(rows[0]!.status).toBe("COMPLETED");
      // Reset by the re-enqueue and consumed by exactly one delivery.
      expect(rows[0]!.attempt).toBe(1);
    }

    // The stage before the rerun target never re-ran.
    const firstStage = await harness.persistence.getStage(runId, "first");
    expect(firstStage?.attempt).toBe(0);
  });

  it("run.rerunFrom retires the job rows of downstream stages it deletes without recreating", async () => {
    const harness = createTestHarness({
      workflows: [createFlakyPipeline({ value: false })],
      maxTicks: 60,
    });

    const result = await harness.run("flaky-pipeline", { data: "hello" });
    expect(result.status).toBe("COMPLETED");
    const runId = result.workflowRunId;
    expect(await harness.jobQueue.getJobsByWorkflowRun(runId)).toHaveLength(3);

    await harness.kernel.dispatch({
      type: "run.rerunFrom",
      workflowRunId: runId,
      fromStageId: "middle",
    });

    // `middle` is recreated and re-enqueued; `last` was deleted without
    // being recreated, so nothing would ever enqueue over its old row.
    const jobs = await harness.jobQueue.getJobsByWorkflowRun(runId);
    expect(jobs.map((j) => j.stageId).sort()).toEqual(["first", "middle"]);
    expect(jobs.find((j) => j.stageId === "middle")?.status).toBe("PENDING");
    expect(jobs.find((j) => j.stageId === "middle")?.attempt).toBe(0);
  });

  it("run.reapStuck re-enqueues a PENDING stage whose stale job row still exists", async () => {
    // The wedged shape E1 produced in production: run RUNNING, stage
    // PENDING, and only a terminal job row for it. The sweep must heal it
    // rather than throw on a duplicate insert every tick.
    const { kernel, persistence, jobTransport, clock } = createTestKernel(
      [createFlakyPipeline({ value: false })],
      { clockStart: new Date() },
    );

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "reap-stale-job-row",
      workflowId: "flaky-pipeline",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // Fail the stage's job row terminally while leaving the stage PENDING.
    const job = await jobTransport.dequeue();
    expect(job).not.toBeNull();
    await jobTransport.fail(job!.jobId, "worker died", false);
    await persistence.updateStageByRunAndStageId(workflowRunId, "first", {
      status: "PENDING",
    });

    clock.advance(10 * 60 * 1000);

    const swept = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    // The run was healed, not reaped...
    expect(swept.failed).toBe(0);
    expect(await persistence.getRunStatus(workflowRunId)).toBe("RUNNING");

    // ...and the stale row was replaced, not duplicated.
    const jobs = await jobTransport.getJobsByWorkflowRun(workflowRunId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("PENDING");
    expect(jobs[0]!.attempt).toBe(0);

    // A second sweep is a no-op: the row it needs now exists.
    clock.advance(10 * 60 * 1000);
    await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });
    expect(await jobTransport.getJobsByWorkflowRun(workflowRunId)).toHaveLength(
      1,
    );
  });
});
