import { describe, expect, it } from "vitest";
import { StepLedgerWriteError } from "../../core/steps.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import type { StepLedger } from "../../kernel/ports.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

describe("durable run results", () => {
  it("replays undefined and null as completed JSON null results", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    const api = () =>
      createStepApi({ stageRecordId: "stage", stepLedger: ledger, clock });

    await expect(api().run("void", async () => undefined)).resolves.toBeNull();
    await expect(api().run("void", async () => "rerun")).resolves.toBeNull();
    await expect(api().run("null", async () => null)).resolves.toBeNull();
    await expect(api().run("null", async () => "rerun")).resolves.toBeNull();
    expect((await ledger.get("stage", "void"))?.result).toBeNull();
    expect((await ledger.get("stage", "null"))?.status).toBe("completed");
  });

  it("leaves a running row when committing the completed result fails", async () => {
    const clock = new FakeClock();
    const backing = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    const ledger: StepLedger = {
      claim: (record) => backing.claim(record),
      get: (stageRecordId, stepId) => backing.get(stageRecordId, stepId),
      list: (stageRecordId) => backing.list(stageRecordId),
      clear: (stageRecordId) => backing.clear(stageRecordId),
      // The outcome write is a compare-and-set, not a blind update: that is
      // where a ledger failure has to be caught.
      compareAndSet: async (stageRecordId, stepId, expected, patch) => {
        if (patch.status === "completed") throw new Error("write failed");
        return backing.compareAndSet(stageRecordId, stepId, expected, patch);
      },
      update: (stageRecordId, stepId, patch) =>
        backing.update(stageRecordId, stepId, patch),
    };
    let calls = 0;
    const api = createStepApi({
      stageRecordId: "stage",
      stepLedger: ledger,
      clock,
    });

    await expect(
      api.run("write", async () => {
        calls++;
        return "done";
      }),
    ).rejects.toMatchObject({
      name: "StepLedgerWriteError",
      stepId: "write",
    } satisfies Partial<StepLedgerWriteError>);
    expect(calls).toBe(1);
    const record = await backing.get("stage", "write");
    expect(record?.status).toBe("running");
    expect(record?.error).toBeUndefined();
  });
});
