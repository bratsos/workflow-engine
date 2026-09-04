/**
 * Claim-check spilling for job payloads.
 *
 * `createSpillingJobTransport` is wired once and shared by the kernel (which
 * enqueues) and the host (which dequeues), so a payload above the threshold
 * leaves the queue row — or a real queue's message — carrying only a key.
 */

import { describe, expect, it } from "vitest";
import type { JobTransport } from "../../kernel/ports.js";
import { createSpillingJobTransport, isSpillRef } from "../../kernel/spill.js";
import { InMemoryBlobStore } from "../../kernel/testing/in-memory-blob-store.js";
import type { EnqueueJobInput } from "../../persistence/interface.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";

function setup(thresholdBytes = 1000) {
  const queue = new InMemoryJobQueue("test-worker");
  const blobStore = new InMemoryBlobStore();
  return {
    queue,
    blobStore,
    transport: createSpillingJobTransport(queue, {
      blobStore,
      thresholdBytes,
    }),
  };
}

describe("payload spill: job transport", () => {
  it("a large payload is a reference in the queue row and the whole payload on dequeue", async () => {
    const { queue, transport } = setup();
    const payload = { config: { blob: "q".repeat(5000) } };

    await transport.enqueueParallel([
      {
        workflowRunId: "run-1",
        workflowId: "wf-1",
        stageId: "stage-1",
        payload,
      },
    ]);

    const raw = await queue.getJobsByWorkflowRun("run-1");
    expect(raw).toHaveLength(1);
    expect(isSpillRef(raw[0]!.payload)).toBe(true);

    const dequeued = await transport.dequeue();
    expect(dequeued?.payload).toEqual(payload);
    expect((await transport.getJobsByWorkflowRun("run-1"))[0]?.payload).toEqual(
      payload,
    );
  });

  it("a small payload is stored inline", async () => {
    const { queue, blobStore, transport } = setup();
    const payload = { config: { blob: "short" } };

    await transport.enqueueParallel([
      {
        workflowRunId: "run-1",
        workflowId: "wf-1",
        stageId: "stage-1",
        payload,
      },
    ]);

    const raw = await queue.getJobsByWorkflowRun("run-1");
    expect(raw[0]!.payload).toEqual(payload);
    expect(isSpillRef(raw[0]!.payload)).toBe(false);
    expect(await blobStore.list("")).toEqual([]);
  });

  it("deleteByRunAndStages removes the spilled payload", async () => {
    const { blobStore, transport } = setup();
    await transport.enqueueParallel([
      {
        workflowRunId: "run-1",
        workflowId: "wf-1",
        stageId: "stage-1",
        payload: { config: { blob: "q".repeat(5000) } },
      },
    ]);
    expect(await blobStore.list("workflow-v2/spill/jobs/")).toHaveLength(1);

    await transport.deleteByRunAndStages("run-1", ["stage-1"]);

    expect(await blobStore.list("workflow-v2/spill/jobs/")).toEqual([]);
  });

  it("delegates adoptWorkerId to the wrapped transport", () => {
    const { transport } = setup();
    expect(transport.adoptWorkerId?.("host-1")).toBe("test-worker");
  });

  it("forwards the acknowledgement fence, so wrapping does not un-fence a stale worker", async () => {
    // The decorator sits between the host and the real transport. A
    // delegation that drops the optional `fence` parameter still typechecks
    // (fewer parameters is assignable to more), so the only thing that can
    // catch it is a test that rescues a claim and acknowledges the old one.
    const { queue, transport } = setup();
    await transport.enqueueParallel([
      {
        workflowRunId: "run-fence",
        workflowId: "wf-1",
        stageId: "stage-1",
        payload: { config: {} },
      },
    ]);

    const first = await transport.dequeue();
    expect(first?.startedAt).toBeInstanceOf(Date);
    // A negative threshold makes the held lease stale immediately.
    expect(await transport.releaseStaleJobs(-1000)).toBe(1);
    const second = await transport.dequeue();
    expect(second?.jobId).toBe(first?.jobId);

    const stale = await transport.complete(first!.jobId, {
      startedAt: first!.startedAt,
      attempt: first!.attempt,
    });
    expect(stale).toBe("superseded");
    expect((await queue.getJobsByWorkflowRun("run-fence"))[0]?.status).toBe(
      "RUNNING",
    );

    const live = await transport.complete(second!.jobId, {
      startedAt: second!.startedAt,
      attempt: second!.attempt,
    });
    expect(live).toBe("acknowledged");
    expect((await queue.getJobsByWorkflowRun("run-fence"))[0]?.status).toBe(
      "COMPLETED",
    );
  });

  it("forwards expireRunawayJobs, so wrapping does not remove the absolute-timeout tier", async () => {
    const { transport } = setup();
    expect(typeof transport.expireRunawayJobs).toBe("function");
    await transport.enqueueParallel([
      {
        workflowRunId: "run-runaway",
        workflowId: "wf-1",
        stageId: "stage-1",
        payload: { config: {} },
      },
    ]);
    await transport.dequeue();
    expect(await transport.expireRunawayJobs?.(-1000)).toBe(1);
  });

  it("hoists the fairness group key out of a payload that spills", async () => {
    const recorded: EnqueueJobInput[] = [];
    const fakeTransport: JobTransport = {
      fairnessGroupBy: "config.tenantId",
      async enqueueParallel(jobs) {
        recorded.push(...jobs);
        return jobs.map((_, i) => `job-${i}`);
      },
      async deleteByRunAndStages() {
        return 0;
      },
      async dequeue() {
        return null;
      },
      async complete() {
        return "acknowledged";
      },
      async suspend() {
        return "acknowledged";
      },
      async fail() {
        return "acknowledged";
      },
      async releaseStaleJobs() {
        return 0;
      },
      async cancelByRun() {
        return 0;
      },
      async getJobsByWorkflowRun() {
        return [];
      },
      async touchJob() {},
    };
    const blobStore = new InMemoryBlobStore();
    const thresholdBytes = 100;
    const transport = createSpillingJobTransport(fakeTransport, {
      blobStore,
      thresholdBytes,
    });

    const smallPayload = { config: { tenantId: "acme" } };
    const largePayload = {
      config: { tenantId: "globex" },
      blob: "x".repeat(200),
    };

    await transport.enqueueParallel([
      {
        workflowRunId: "run-small",
        workflowId: "wf-1",
        stageId: "stage-1",
        payload: smallPayload,
      },
      {
        workflowRunId: "run-large",
        workflowId: "wf-1",
        stageId: "stage-2",
        payload: largePayload,
      },
    ]);

    expect(recorded).toHaveLength(2);
    const [smallJob, spilledJob] = recorded;

    expect(spilledJob?.groupKey).toBe("globex");
    expect(isSpillRef(spilledJob?.payload)).toBe(true);

    expect(smallJob?.groupKey).toBeUndefined();
    expect(smallJob?.payload).toEqual(smallPayload);
  });

  it("leaves an explicit groupKey alone", async () => {
    const recorded: EnqueueJobInput[] = [];
    const fakeTransport: JobTransport = {
      fairnessGroupBy: "config.tenantId",
      async enqueueParallel(jobs) {
        recorded.push(...jobs);
        return jobs.map((_, i) => `job-${i}`);
      },
      async deleteByRunAndStages() {
        return 0;
      },
      async dequeue() {
        return null;
      },
      async complete() {
        return "acknowledged";
      },
      async suspend() {
        return "acknowledged";
      },
      async fail() {
        return "acknowledged";
      },
      async releaseStaleJobs() {
        return 0;
      },
      async cancelByRun() {
        return 0;
      },
      async getJobsByWorkflowRun() {
        return [];
      },
      async touchJob() {},
    };
    const blobStore = new InMemoryBlobStore();
    const thresholdBytes = 100;
    const transport = createSpillingJobTransport(fakeTransport, {
      blobStore,
      thresholdBytes,
    });

    const largePayload = {
      config: { tenantId: "globex" },
      blob: "x".repeat(200),
    };

    await transport.enqueueParallel([
      {
        workflowRunId: "run-explicit",
        workflowId: "wf-1",
        stageId: "stage-1",
        payload: largePayload,
        groupKey: "explicit",
      },
    ]);

    expect(recorded).toHaveLength(1);
    const [job] = recorded;

    expect(job?.groupKey).toBe("explicit");
    expect(isSpillRef(job?.payload)).toBe(true);
  });
});
