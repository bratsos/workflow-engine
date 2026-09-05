import { describe, expect, it } from "vitest";
import { StepSuspend } from "../../core/steps.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

function setup() {
  const clock = new FakeClock();
  const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
  const api = () =>
    createStepApi({ stageRecordId: "stage", stepLedger: ledger, clock });
  return { clock, api };
}

async function suspension(promise: Promise<unknown>): Promise<StepSuspend> {
  const error = await promise.catch((value: unknown) => value);
  if (!(error instanceof StepSuspend)) throw new Error("expected suspension");
  return error;
}

describe("signal wait keepalive", () => {
  it("re-suspends five minutes out by default", async () => {
    const { clock, api } = setup();

    const first = await suspension(
      api().waitForSignal("approval", { timeout: "7d" }),
    );
    expect(first.nextPollAt.getTime()).toBe(clock.now().getTime() + 5 * 60_000);
    expect(first.pollInterval).toBe(5 * 60_000);

    clock.advance(5 * 60_000);
    const second = await suspension(
      api().waitForSignal("approval", { timeout: "7d" }),
    );
    expect(second.nextPollAt.getTime()).toBe(
      clock.now().getTime() + 5 * 60_000,
    );
  });

  it("honours a keepalive option, bounded by the deadline", async () => {
    const { clock, api } = setup();

    const first = await suspension(
      api().waitForSignal("approval", { timeout: "1h", keepalive: "20m" }),
    );
    expect(first.nextPollAt.getTime()).toBe(
      clock.now().getTime() + 20 * 60_000,
    );

    clock.advance(50 * 60_000);
    const nearDeadline = await suspension(
      api().waitForSignal("approval", { timeout: "1h", keepalive: "20m" }),
    );
    expect(nearDeadline.nextPollAt.getTime()).toBe(
      clock.now().getTime() + 10 * 60_000,
    );
    expect(nearDeadline.nextPollAt).toEqual(nearDeadline.maxWaitUntil);
  });
});
