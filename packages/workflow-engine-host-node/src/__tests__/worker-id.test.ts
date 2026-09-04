/**
 * `NodeHostConfig.workerId` reaches `job_queue.workerId`.
 *
 * The transport is built before the host, so it used to invent its own id
 * (`worker-<pid>-<ts>` for `PrismaJobQueue`) unless the consumer also
 * passed `workerId` to the factory — every job row was then labelled with
 * an id no host answered to. `start()` now offers the host's id to the
 * transport, and says something when the transport keeps its own.
 */

import { createKernel } from "@bratsos/workflow-engine/kernel";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
} from "@bratsos/workflow-engine/kernel/testing";
import {
  InMemoryJobQueue,
  InMemoryWorkflowPersistence,
} from "@bratsos/workflow-engine/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeHost, type NodeHost } from "../host.js";

function createEnv(jobTransport: InMemoryJobQueue) {
  return createKernel({
    persistence: new InMemoryWorkflowPersistence(),
    blobStore: new InMemoryBlobStore(),
    jobTransport,
    eventSink: new CollectingEventSink(),
    clock: new FakeClock(),
    registry: { getWorkflow: () => undefined },
  });
}

describe("NodeHost workerId plumbing", () => {
  let host: NodeHost | null = null;

  afterEach(async () => {
    if (host) await host.stop();
    host = null;
    vi.restoreAllMocks();
  });

  it("stamps its workerId on a transport that was not given one", async () => {
    const jobTransport = new InMemoryJobQueue();
    expect(jobTransport.getWorkerId()).not.toBe("node-host-1");

    host = createNodeHost({
      kernel: createEnv(jobTransport),
      jobTransport,
      workerId: "node-host-1",
      orchestrationIntervalMs: 60_000,
      jobPollIntervalMs: 5,
    });
    await host.start();

    expect(jobTransport.getWorkerId()).toBe("node-host-1");
  });

  it("keeps an explicitly configured transport id and reports the mismatch", async () => {
    const jobTransport = new InMemoryJobQueue("queue-chosen-id");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    host = createNodeHost({
      kernel: createEnv(jobTransport),
      jobTransport,
      workerId: "node-host-1",
      orchestrationIntervalMs: 60_000,
      jobPollIntervalMs: 5,
    });
    await host.start();

    expect(jobTransport.getWorkerId()).toBe("queue-chosen-id");
    const warnings = logged.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("workerId mismatch"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("node-host-1");
    expect(warnings[0]).toContain("queue-chosen-id");
  });
});
