import { describe, expect, it } from "vitest";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";

function build() {
  let t = 0;
  const clock = { now: () => new Date(t) };
  const store = new InMemoryBrokerStore();
  const os = new InMemoryObjectStore(clock);
  let n = 0;
  const broker = new Broker({ store, presigner: os, clock, staleLeaseMs: 1_000, stageCodeVersion: "v1", generateId: () => `id${n++}` });
  return { broker, store, os, set: (ms: number) => { t = ms; } };
}

const submitReq = {
  workflowRunId: "r1", stageId: "download", stageName: "D", stageNumber: 1,
  input: { url: "x" }, config: {}, workflowContext: {}, pollInterval: 100, maxWaitTime: 10_000,
};

describe("Broker", () => {
  it("submit → lease hands out a task with a fencing token and a scoped grant", async () => {
    const { broker } = build();
    const { taskId } = await broker.submit(submitReq);
    const task = await broker.lease({ workerId: "w1", stageIds: ["download"], stageCodeVersion: "v1" });
    expect(task?.taskId).toBe(taskId);
    expect(task?.leaseToken).toBeTruthy();
    expect(task?.grant.prefix).toContain(`/${taskId}/`);
  });

  it("rejects a worker on stage-code-version mismatch", async () => {
    const { broker } = build();
    await broker.submit(submitReq);
    await expect(
      broker.lease({ workerId: "w1", stageIds: ["download"], stageCodeVersion: "OLD" }),
    ).rejects.toThrow(/version/i);
  });

  it("re-leases a task whose heartbeat went stale (crash recovery)", async () => {
    const { broker, set } = build();
    await broker.submit(submitReq);
    const a = await broker.lease({ workerId: "w1", stageIds: ["download"], stageCodeVersion: "v1" });
    set(2_000); // exceeds staleLeaseMs (1_000) with no heartbeat
    const poll = await broker.poll(a!.taskId);
    expect(poll.state).toBe("pending");
    const b = await broker.lease({ workerId: "w2", stageIds: ["download"], stageCodeVersion: "v1" });
    expect(b?.taskId).toBe(a!.taskId);
    expect(b?.leaseToken).not.toBe(a!.leaseToken);
  });

  it("fences a stale report after re-lease", async () => {
    const { broker, set } = build();
    await broker.submit(submitReq);
    const a = await broker.lease({ workerId: "w1", stageIds: ["download"], stageCodeVersion: "v1" });
    set(2_000);
    await broker.poll(a!.taskId); // re-leases
    await broker.lease({ workerId: "w2", stageIds: ["download"], stageCodeVersion: "v1" });
    await expect(
      broker.report({ taskId: a!.taskId, leaseToken: a!.leaseToken, outcome: { kind: "completed", output: {} }, logs: [], annotations: [], progress: [] }),
    ).rejects.toThrow(/fenc|lease/i);
  });

  it("marks the task failed once the deadline passes", async () => {
    const { broker, set } = build();
    const { taskId } = await broker.submit({ ...submitReq, maxWaitTime: 500 });
    await broker.lease({ workerId: "w1", stageIds: ["download"], stageCodeVersion: "v1" });
    set(1_000);
    const poll = await broker.poll(taskId);
    expect(poll.state).toBe("failed");
  });

  it("stores a completed report and returns it on poll", async () => {
    const { broker } = build();
    const { taskId } = await broker.submit(submitReq);
    const a = await broker.lease({ workerId: "w1", stageIds: ["download"], stageCodeVersion: "v1" });
    await broker.report({ taskId, leaseToken: a!.leaseToken, outcome: { kind: "completed", output: { ok: 1 } }, logs: [{ level: "INFO", message: "hi" }], annotations: [["k", "v"]], progress: [] });
    const poll = await broker.poll(taskId);
    expect(poll.state).toBe("reported");
    expect(poll.outcome).toEqual({ kind: "completed", output: { ok: 1 } });
    expect(poll.logs).toHaveLength(1);
    expect(poll.annotations).toEqual([["k", "v"]]);
  });

  it("rejects a duplicate report from the same worker (double-report guard)", async () => {
    const { broker } = build();
    const { taskId } = await broker.submit(submitReq);
    const a = await broker.lease({ workerId: "w1", stageIds: ["download"], stageCodeVersion: "v1" });
    const reportReq = { taskId, leaseToken: a!.leaseToken, outcome: { kind: "completed" as const, output: {} }, logs: [], annotations: [], progress: [] };
    await broker.report(reportReq); // first report succeeds
    await expect(broker.report(reportReq)).rejects.toThrow(/ASSIGNED/i); // second report with same token rejected
  });

  it("presigns only within the task prefix", async () => {
    const { broker } = build();
    const { taskId } = await broker.submit(submitReq);
    const a = await broker.lease({ workerId: "w1", stageIds: ["download"], stageCodeVersion: "v1" });
    const ok = await broker.presign({ taskId, leaseToken: a!.leaseToken, relKey: `${a!.grant.prefix}audio.bin`, op: "put" });
    expect(ok.url).toMatch(/^mem:\/\/put\//);
    await expect(
      broker.presign({ taskId, leaseToken: a!.leaseToken, relKey: "someone-elses-key", op: "put" }),
    ).rejects.toThrow(/prefix|scope/i);
  });
});
