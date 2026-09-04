/**
 * Claim-check spilling for job payloads.
 *
 * `createSpillingJobTransport` is wired once and shared by the kernel (which
 * enqueues) and the host (which dequeues), so a payload above the threshold
 * leaves the queue row — or a real queue's message — carrying only a key.
 */

import { describe, expect, it } from "vitest";
import { createSpillingJobTransport, isSpillRef } from "../../kernel/spill.js";
import { InMemoryBlobStore } from "../../kernel/testing/in-memory-blob-store.js";
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
});
