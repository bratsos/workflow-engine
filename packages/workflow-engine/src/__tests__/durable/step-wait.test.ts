import { describe, expect, it } from "vitest";
import { StepSuspend } from "../../core/steps.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

function setup() {
  const clock = new FakeClock();
  const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
  const api = () =>
    createStepApi({
      stageRecordId: "stage-1",
      stepLedger: ledger,
      clock,
    });
  return { clock, ledger, api };
}

describe("durable waits", () => {
  it("suspends with the configured poll and timeout, then resolves", async () => {
    const { clock, api } = setup();
    let ready = false;
    const poll = async () => ({ ready });
    const opts = {
      poll,
      ready: (value: { ready: boolean }) => value.ready,
      every: "30s",
      timeout: "5m",
    };

    const first = api().waitFor("job", opts);
    await expect(first).rejects.toBeInstanceOf(StepSuspend);
    const error = await first.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(StepSuspend);
    if (!(error instanceof StepSuspend)) throw new Error("expected suspension");
    expect(error.nextPollAt.getTime()).toBe(clock.now().getTime() + 30_000);
    expect(error.maxWaitUntil.getTime()).toBe(
      clock.now().getTime() + 5 * 60_000,
    );

    clock.advance(30_000);
    ready = true;
    await expect(api().waitFor("job", opts)).resolves.toEqual({ ready: true });
  });

  it("sleeps until its durable wake time", async () => {
    const { clock, api, ledger } = setup();

    await expect(api().sleep("pause", "30s")).rejects.toBeInstanceOf(
      StepSuspend,
    );
    expect((await ledger.get("stage-1", "pause"))?.waitState?.wakeAt).toBe(
      new Date(clock.now().getTime() + 30_000).toISOString(),
    );
    clock.advance(30_000);
    await expect(api().sleep("pause", "30s")).resolves.toBeUndefined();
    expect((await ledger.get("stage-1", "pause"))?.status).toBe("completed");
  });

  it("waits for a signal and resolves its payload", async () => {
    const { clock, ledger, api } = setup();

    await expect(
      api().waitForSignal("approval", { timeout: "5m" }),
    ).rejects.toBeInstanceOf(StepSuspend);
    await ledger.update("stage-1", "approval", {
      status: "completed",
      result: { approved: true },
    });
    await expect(
      api().waitForSignal("approval", { timeout: "5m" }),
    ).resolves.toEqual({
      approved: true,
    });
    expect(clock.now()).toEqual(new Date("2025-01-01T00:00:00.000Z"));
  });

  it("accepts an early signal before the wait is first requested", async () => {
    const { ledger, api } = setup();

    await ledger.claim({
      stageRecordId: "stage-1",
      stepId: "approval",
      seq: 0,
      kind: "signal",
      status: "completed",
      result: { approved: true },
    });
    await expect(
      api().waitForSignal("approval", { timeout: "5m" }),
    ).resolves.toEqual({
      approved: true,
    });
  });
});
