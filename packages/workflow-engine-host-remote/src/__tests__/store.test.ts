import { describe, expect, it } from "vitest";
import { InMemoryBrokerStore, type TaskRecord } from "../broker/store.js";

function rec(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "t1",
    workflowRunId: "r1",
    stageId: "download",
    stageName: "D",
    stageNumber: 1,
    status: "PENDING",
    leaseToken: null,
    leasedAt: null,
    attempt: 0,
    deadline: 10_000,
    createdAt: 0,
    payload: { input: {}, config: {}, workflowContext: {} },
    report: null,
    failureError: null,
    ...over,
  };
}

describe("InMemoryBrokerStore", () => {
  it("claims the oldest PENDING task matching stageIds and marks it ASSIGNED", async () => {
    const s = new InMemoryBrokerStore();
    await s.create(rec({ taskId: "t1", createdAt: 1 }));
    await s.create(rec({ taskId: "t2", createdAt: 2 }));
    const claimed = await s.claimNext(["download"], "lt", 5);
    expect(claimed?.taskId).toBe("t1");
    expect((await s.get("t1"))?.status).toBe("ASSIGNED");
    expect((await s.get("t1"))?.leaseToken).toBe("lt");
  });

  it("does not claim a task whose stageId is not requested", async () => {
    const s = new InMemoryBrokerStore();
    await s.create(rec({ stageId: "ffmpeg" }));
    expect(await s.claimNext(["download"], "lt", 5)).toBeNull();
  });
});
