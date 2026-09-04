/**
 * Per-group fairness in the dequeue.
 *
 * The starvation this guards: one tenant enqueues thousands of jobs, and
 * every later arrival from every other tenant sits behind all of them,
 * because the dequeue orders by `priority DESC, "createdAt" ASC` and nothing
 * else.
 *
 * Fairness fixes it with a concurrency cap per group, not a reordering — a
 * group already holding its share of the RUNNING pool is skipped, which
 * leaves the quiet group's job as the only candidate. (Reordering cannot
 * work: whatever rule ranks the pending rows, the flooding group's next row
 * is re-ranked to the front the instant its previous one is claimed.)
 *
 * These run against `InMemoryJobQueue`; the same behaviour is checked
 * against real Postgres in 12-persistence-adapters/prisma-postgres-conformance.
 */

import { describe, expect, it } from "vitest";
import type { EnqueueJobInput } from "../../persistence/interface.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";

function job(
  runId: string,
  groupKey: string | undefined,
  extra: Partial<EnqueueJobInput> = {},
): EnqueueJobInput {
  return {
    workflowRunId: runId,
    workflowId: "wf",
    stageId: "stage-1",
    payload: {},
    ...(groupKey === undefined ? {} : { groupKey }),
    ...extra,
  };
}

/** 50 jobs from one group, then a single job from another. */
async function floodThenOne(queue: InMemoryJobQueue) {
  for (let i = 0; i < 50; i++) {
    await queue.enqueue(job(`flood-${i}`, "noisy-tenant"));
  }
  await queue.enqueue(job("quiet-run", "quiet-tenant"));
}

describe("dequeue group fairness", () => {
  it("starves the quiet group when fairness is off (the default)", async () => {
    const queue = new InMemoryJobQueue("w");
    await floodThenOne(queue);

    const first = await queue.dequeue();
    const second = await queue.dequeue();

    // Plain FIFO: the single quiet job is behind all fifty.
    expect(first?.workflowRunId).toBe("flood-0");
    expect(second?.workflowRunId).toBe("flood-1");
  });

  it("serves the quiet group once the noisy one is at its cap", async () => {
    const queue = new InMemoryJobQueue("w", {
      fairness: { maxConcurrentPerGroup: 1 },
    });
    await floodThenOne(queue);

    const first = await queue.dequeue();
    const second = await queue.dequeue();

    // The noisy group is holding its one slot, so it is skipped and the
    // quiet group's job is second out rather than fifty-first.
    expect(first?.workflowRunId).toBe("flood-0");
    expect(second?.workflowRunId).toBe("quiet-run");
  });

  it("lets a group back in as soon as it drops below the cap", async () => {
    const queue = new InMemoryJobQueue("w", {
      fairness: { maxConcurrentPerGroup: 1 },
    });
    await floodThenOne(queue);

    const first = await queue.dequeue();
    await queue.dequeue(); // quiet-run takes the other slot
    // Both groups are at their cap now.
    expect(await queue.dequeue()).toBeNull();

    await queue.complete(first!.jobId);
    expect((await queue.dequeue())?.workflowRunId).toBe("flood-1");
  });

  it("gives a group the whole cap when no other group is competing", async () => {
    const queue = new InMemoryJobQueue("w", {
      fairness: { maxConcurrentPerGroup: 3 },
    });
    for (let i = 0; i < 5; i++) {
      await queue.enqueue(job(`solo-${i}`, "only-tenant"));
    }

    expect((await queue.dequeue())?.workflowRunId).toBe("solo-0");
    expect((await queue.dequeue())?.workflowRunId).toBe("solo-1");
    expect((await queue.dequeue())?.workflowRunId).toBe("solo-2");
    // ...and no further, which is the cost of the cap.
    expect(await queue.dequeue()).toBeNull();
  });

  it("still honours priority between eligible groups", async () => {
    const queue = new InMemoryJobQueue("w", {
      fairness: { maxConcurrentPerGroup: 1 },
    });
    await queue.enqueue(job("low", "a", { priority: 1 }));
    await queue.enqueue(job("high", "b", { priority: 9 }));

    // Fairness only removes candidates; among what is left the ordinary
    // priority-then-FIFO rule is unchanged.
    expect((await queue.dequeue())?.workflowRunId).toBe("high");
    expect((await queue.dequeue())?.workflowRunId).toBe("low");
  });

  it("groups on an existing payload field when groupBy names one", async () => {
    const queue = new InMemoryJobQueue("w", {
      fairness: { maxConcurrentPerGroup: 1, groupBy: "config.tenantId" },
    });
    for (let i = 0; i < 5; i++) {
      await queue.enqueue({
        workflowRunId: `noisy-${i}`,
        workflowId: "wf",
        stageId: "stage-1",
        payload: { config: { tenantId: "acme" } },
      });
    }
    await queue.enqueue({
      workflowRunId: "quiet",
      workflowId: "wf",
      stageId: "stage-1",
      payload: { config: { tenantId: "globex" } },
    });

    await queue.dequeue();
    expect((await queue.dequeue())?.workflowRunId).toBe("quiet");
  });

  it("keeps the group key out of the payload handed to the stage", async () => {
    const queue = new InMemoryJobQueue("w", {
      fairness: { maxConcurrentPerGroup: 1 },
    });
    await queue.enqueue(job("run-1", "tenant-a", { payload: { x: 1 } }));

    const claimed = await queue.dequeue();
    expect(claimed?.payload).toEqual({ x: 1 });

    const [record] = await queue.getJobsByWorkflowRun("run-1");
    expect(record?.payload).toEqual({ x: 1 });
  });

  it("caps jobs with no group value as one shared group", async () => {
    const queue = new InMemoryJobQueue("w", {
      fairness: { maxConcurrentPerGroup: 1 },
    });
    await queue.enqueue(job("ungrouped-1", undefined));
    await queue.enqueue(job("ungrouped-2", undefined));

    // Both land in the anonymous group, which is capped like any other —
    // fairness never invents groups for jobs that carry no key.
    expect((await queue.dequeue())?.workflowRunId).toBe("ungrouped-1");
    expect(await queue.dequeue()).toBeNull();
  });

  it("rejects a cap below 1 at construction", () => {
    expect(
      () =>
        new InMemoryJobQueue("w", { fairness: { maxConcurrentPerGroup: 0 } }),
    ).toThrow(/at least 1/);
  });
});
