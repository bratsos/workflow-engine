import { describe, expect, it } from "vitest";
import type { StepRecord } from "../../kernel/ports.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

const baseRecord = (
  stepId: string,
): Omit<StepRecord, "createdAt" | "updatedAt"> => ({
  stageRecordId: "stage-1",
  stepId,
  seq: 1,
  kind: "run",
  status: "running",
  attempt: 1,
  leaseExpiresAt: new Date("2025-01-01T00:05:00.000Z"),
  deadlineAt: null,
});

describe("InMemoryStepLedger", () => {
  it("atomically claims a step", async () => {
    const ledger = new InMemoryStepLedger();
    const results = await Promise.all([
      ledger.claim(baseRecord("once")),
      ledger.claim(baseRecord("once")),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.map((result) => result.record.stepId)).toEqual([
      "once",
      "once",
    ]);
  });

  it("updates, gets, lists, and clears stage records", async () => {
    const ledger = new InMemoryStepLedger();
    await ledger.claim(baseRecord("a"));
    await ledger.claim({ ...baseRecord("b"), seq: 2 });

    const updated = await ledger.update("stage-1", "a", {
      status: "completed",
      result: null,
      error: null,
      leaseExpiresAt: null,
    });
    expect(updated.status).toBe("completed");
    expect(await ledger.get("stage-1", "a")).toMatchObject({
      status: "completed",
      result: null,
      error: null,
      leaseExpiresAt: null,
    });
    expect(await ledger.list("stage-1")).toHaveLength(2);

    await ledger.clear("stage-1");
    expect(await ledger.list("stage-1")).toEqual([]);
  });

  it("compareAndSet applies only when status and attempt match", async () => {
    const ledger = new InMemoryStepLedger();
    await ledger.claim(baseRecord("cas"));

    const stale = await ledger.compareAndSet(
      "stage-1",
      "cas",
      { status: "running", attempt: 2 },
      { status: "completed", result: null, leaseExpiresAt: null },
    );
    expect(stale.applied).toBe(false);
    expect(stale.record).toMatchObject({ status: "running", attempt: 1 });

    const applied = await ledger.compareAndSet(
      "stage-1",
      "cas",
      { status: "running", attempt: 1 },
      { status: "running", attempt: 2, error: null },
    );
    expect(applied.applied).toBe(true);
    expect(applied.record).toMatchObject({ status: "running", attempt: 2 });

    const missing = await ledger.compareAndSet(
      "stage-1",
      "nope",
      { status: "running", attempt: 1 },
      { status: "completed" },
    );
    expect(missing).toEqual({ applied: false, record: null });
    expect(await ledger.get("stage-1", "cas")).toMatchObject({
      status: "running",
      attempt: 2,
    });
  });
});
