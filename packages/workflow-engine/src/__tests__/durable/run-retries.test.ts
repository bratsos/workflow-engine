import { describe, expect, it } from "vitest";
import { StepSuspend } from "../../core/steps.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

describe("durable run retries", () => {
  it("suspends transient failures and reclaims while retry budget remains", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    const api = () =>
      createStepApi({ stageRecordId: "stage", stepLedger: ledger, clock });
    let calls = 0;
    const work = async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "done";
    };

    const first = await api()
      .run("retry", work, { retries: 1, retryDelayMs: 2_000 })
      .catch((error: unknown) => error);
    expect(first).toBeInstanceOf(StepSuspend);
    expect(first).toMatchObject({ kind: "retry" });
    expect((first as StepSuspend).resumeAt.getTime()).toBe(
      clock.now().getTime() + 2_000,
    );
    expect(await ledger.get("stage", "retry")).toMatchObject({
      status: "failed",
      attempt: 1,
    });

    clock.advance(2_000);
    await expect(
      api().run("retry", work, { retries: 1, retryDelayMs: 2_000 }),
    ).resolves.toBe("done");
    expect(calls).toBe(2);
    expect(await ledger.get("stage", "retry")).toMatchObject({
      status: "completed",
      attempt: 2,
    });
  });

  it("throws the stored error after retries are exhausted", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    const api = () =>
      createStepApi({ stageRecordId: "stage", stepLedger: ledger, clock });
    const fail = async () => {
      throw new Error("still broken");
    };

    await expect(
      api().run("retry", fail, { retries: 1 }),
    ).rejects.toBeInstanceOf(StepSuspend);
    await expect(api().run("retry", fail, { retries: 1 })).rejects.toThrow(
      "still broken",
    );
    await expect(api().run("retry", fail, { retries: 1 })).rejects.toThrow(
      "still broken",
    );
    expect((await ledger.get("stage", "retry"))?.attempt).toBe(2);
  });
});
