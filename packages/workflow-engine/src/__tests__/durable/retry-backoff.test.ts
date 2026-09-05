import { describe, expect, it } from "vitest";
import { type StepRunOptions, StepSuspend } from "../../core/steps.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

function setup(random?: () => number) {
  const clock = new FakeClock();
  const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
  const api = () =>
    createStepApi({
      stageRecordId: "stage",
      stepLedger: ledger,
      clock,
      random,
    });
  return { clock, ledger, api };
}

const fail = async () => {
  throw new Error("transient");
};

/** Run one failing attempt and return how far out the retry was scheduled. */
async function retryGap(
  clock: FakeClock,
  attempt: Promise<unknown>,
): Promise<number> {
  const error = await attempt.catch((value: unknown) => value);
  if (!(error instanceof StepSuspend)) throw new Error("expected suspension");
  const gap = error.nextPollAt.getTime() - clock.now().getTime();
  clock.advance(gap);
  return gap;
}

describe("durable run retry backoff", () => {
  it("grows the delay by the factor per attempt, capped at maxDelay", async () => {
    const { clock, api } = setup();
    const opts: StepRunOptions = {
      retries: 3,
      retryDelay: "10s",
      retryBackoff: { factor: 2, maxDelay: "30s" },
    };

    const gaps = [
      await retryGap(clock, api().run("flaky", fail, opts)),
      await retryGap(clock, api().run("flaky", fail, opts)),
      await retryGap(clock, api().run("flaky", fail, opts)),
    ];
    expect(gaps).toEqual([10_000, 20_000, 30_000]);
    await expect(api().run("flaky", fail, opts)).rejects.toThrow("transient");
  });

  it("draws a full-jitter delay from the injected random source", async () => {
    const { clock, api } = setup(() => 0.25);
    const opts: StepRunOptions = {
      retries: 2,
      retryDelay: "10s",
      retryBackoff: { factor: 2, jitter: true },
    };

    expect(await retryGap(clock, api().run("flaky", fail, opts))).toBe(2_500);
    expect(await retryGap(clock, api().run("flaky", fail, opts))).toBe(5_000);
  });

  it("computes the delay from the attempt recorded on the row", async () => {
    const { clock, ledger, api } = setup();
    const opts: StepRunOptions = {
      retries: 5,
      retryDelay: "1s",
      retryBackoff: { factor: 2 },
    };
    // A failed row written by another process: this worker has no counter.
    await ledger.claim({
      stageRecordId: "stage",
      stepId: "flaky",
      seq: 1,
      kind: "run",
      status: "failed",
      attempt: 3,
      leaseExpiresAt: null,
      deadlineAt: null,
      error: "transient",
    });

    // Attempt 4 fails: the delay is 1s * 2^(4-1).
    expect(await retryGap(clock, api().run("flaky", fail, opts))).toBe(8_000);
  });
});
