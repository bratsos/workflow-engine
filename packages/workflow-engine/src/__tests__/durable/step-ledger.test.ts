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
      result: { value: 42 },
    });
    expect(updated.status).toBe("completed");
    expect(await ledger.get("stage-1", "a")).toMatchObject({
      status: "completed",
      result: { value: 42 },
    });
    expect(await ledger.list("stage-1")).toHaveLength(2);

    await ledger.clear("stage-1");
    expect(await ledger.list("stage-1")).toEqual([]);
  });
});
