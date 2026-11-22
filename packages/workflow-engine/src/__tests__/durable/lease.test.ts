import { describe, expect, it, vi } from "vitest";
import { STEP_API_SETTLE_IN_FLIGHT, StepInFlight } from "../../core/steps.js";
import { MAX_TIMER_MS } from "../../kernel/helpers/host-support.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

describe("durable run leases", () => {
  it("reclaims an expired lease but suspends for a live lease", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    await ledger.claim({
      stageRecordId: "stage",
      stepId: "expired",
      seq: 1,
      kind: "run",
      status: "running",
      attempt: 1,
      leaseExpiresAt: new Date(clock.now().getTime() - 1),
      deadlineAt: null,
    });
    await ledger.claim({
      stageRecordId: "stage",
      stepId: "live",
      seq: 1,
      kind: "run",
      status: "running",
      attempt: 1,
      leaseExpiresAt: new Date(clock.now().getTime() + 60_000),
      deadlineAt: null,
    });
    await ledger.claim({
      stageRecordId: "stage",
      stepId: "contended",
      seq: 1,
      kind: "run",
      status: "running",
      attempt: 1,
      leaseExpiresAt: new Date(clock.now().getTime() - 1),
      deadlineAt: null,
    });
    const api = () =>
      createStepApi({ stageRecordId: "stage", stepLedger: ledger, clock });

    await expect(api().run("expired", async () => "recovered")).resolves.toBe(
      "recovered",
    );
    expect(await ledger.get("stage", "expired")).toMatchObject({
      status: "completed",
      attempt: 2,
      leaseExpiresAt: null,
    });
    await expect(
      api().run("live", async () => "duplicate"),
    ).rejects.toBeInstanceOf(StepInFlight);
    expect((await ledger.get("stage", "live"))?.attempt).toBe(1);

    let concurrentCalls = 0;
    const contenders = await Promise.allSettled([
      api().run("contended", async () => ++concurrentCalls),
      api().run("contended", async () => ++concurrentCalls),
    ]);
    expect(
      contenders.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      contenders.some(
        (result) =>
          result.status === "rejected" && result.reason instanceof StepInFlight,
      ),
    ).toBe(true);
    expect(concurrentCalls).toBe(1);
  });

  it("refuses a lease a timer cannot honour, the bound settleInFlight waits on, and waits out the longest one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const clock = new FakeClock();
      const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
      const api = () =>
        createStepApi({ stageRecordId: "stage", stepLedger: ledger, clock });
      const message = new RegExp(
        `lease must be a number of milliseconds from 1 to ${MAX_TIMER_MS}`,
      );
      let ran = 0;

      for (const bad of [0, -1, NaN, Infinity, 0.5, MAX_TIMER_MS + 1, "25d"]) {
        // `run` reads the lease synchronously, so it throws rather than rejects.
        expect(
          () => api().run("slow", async () => ++ran, { lease: bad }),
          String(bad),
        ).toThrow(message);
      }
      expect(ran).toBe(0);
      expect(await ledger.get("stage", "slow")).toBeNull();
      expect(() =>
        createStepApi({ clock, defaultLeaseMs: MAX_TIMER_MS + 1 }),
      ).toThrow(/defaultLeaseMs must be a number of milliseconds/);

      // At the bound the wait is a real timer: it does not fire at once.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const steps = api();
      const run = steps.run("slow", () => gate, { lease: MAX_TIMER_MS });
      await Promise.resolve();
      let settled = false;
      const settling = steps[STEP_API_SETTLE_IN_FLIGHT]?.().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      release();
      await run;
      await settling;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
