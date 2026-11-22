import { afterEach, describe, expect, it, vi } from "vitest";
import { StepLeaseLostError, type StepRunContext } from "../../core/steps.js";
import { MAX_TIMER_MS } from "../../kernel/helpers/host-support.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

function setup() {
  const clock = new FakeClock();
  const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
  const api = () =>
    createStepApi({ stageRecordId: "stage", stepLedger: ledger, clock });
  const leaseOf = async (id: string) =>
    (await ledger.get("stage", id))?.leaseExpiresAt?.getTime();
  return { clock, ledger, api, leaseOf };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("durable run lease heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("extends the lease by the step's lease from now when the body heartbeats", async () => {
    const { clock, api, leaseOf } = setup();
    const gate = deferred<void>();
    let step!: StepRunContext;

    const run = api().run(
      "export",
      async (ctx) => {
        step = ctx;
        await gate.promise;
        return "done";
      },
      { lease: "1m" },
    );
    await Promise.resolve();
    expect(await leaseOf("export")).toBe(clock.now().getTime() + 60_000);

    clock.advance(45_000);
    await step.heartbeat();
    expect(await leaseOf("export")).toBe(clock.now().getTime() + 60_000);

    gate.resolve();
    await expect(run).resolves.toBe("done");
    expect(await leaseOf("export")).toBeUndefined();
  });

  it("rejects the heartbeat with StepLeaseLostError once the step was taken over", async () => {
    const { clock, ledger, api, leaseOf } = setup();
    const gate = deferred<void>();
    let step!: StepRunContext;

    const stalled = api().run(
      "export",
      async (ctx) => {
        step = ctx;
        await gate.promise;
        return "stale";
      },
      { lease: "1m" },
    );
    await Promise.resolve();

    // The lease expires unattended; the next replay takes the step over.
    clock.advance(60_001);
    await expect(api().run("export", async () => "fresh")).resolves.toBe(
      "fresh",
    );
    expect(await ledger.get("stage", "export")).toMatchObject({
      status: "completed",
      attempt: 2,
    });

    await expect(step.heartbeat()).rejects.toBeInstanceOf(StepLeaseLostError);
    await expect(step.heartbeat()).rejects.toMatchObject({
      stepId: "export",
      attempt: 1,
    });
    expect(await leaseOf("export")).toBeUndefined();

    // The stale body's outcome loses the compare-and-set as before.
    gate.resolve();
    await expect(stalled).resolves.toBe("fresh");
  });

  it("extends the lease on the heartbeat interval without the body doing anything", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    const { clock, api, leaseOf } = setup();
    const gate = deferred<void>();

    const run = api().run(
      "export",
      async () => {
        await gate.promise;
        return "done";
      },
      { lease: "1m", heartbeat: "10s" },
    );
    await Promise.resolve();
    const claimedAt = clock.now().getTime();
    expect(await leaseOf("export")).toBe(claimedAt + 60_000);

    clock.advance(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await leaseOf("export")).toBe(claimedAt + 10_000 + 60_000);

    clock.advance(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await leaseOf("export")).toBe(claimedAt + 20_000 + 60_000);

    gate.resolve();
    await expect(run).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a heartbeat interval that is not shorter than the lease", async () => {
    const { api } = setup();
    await expect(
      api().run("export", async () => "done", { lease: "1m", heartbeat: "1m" }),
    ).rejects.toThrow("heartbeat");
  });

  it("refuses a heartbeat a timer cannot honour before the step is claimed, and accepts its bounds", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { api, ledger } = setup();
    const lease = MAX_TIMER_MS;
    let ran = 0;
    const body = async () => {
      ran += 1;
      return "done";
    };

    for (const bad of [0, -1, NaN, Infinity, 0.5, MAX_TIMER_MS + 1, "25d"]) {
      await expect(
        api().run("export", body, { lease, heartbeat: bad }),
        String(bad),
      ).rejects.toThrow(
        new RegExp(
          `heartbeat must be a number of milliseconds from 1 to ${MAX_TIMER_MS}`,
        ),
      );
    }
    expect(ran).toBe(0);
    expect(await ledger.get("stage", "export")).toBeNull();

    await expect(
      api().run("min", body, { lease: "1m", heartbeat: 1 }),
    ).resolves.toBe("done");
    await expect(
      api().run("max", body, { lease, heartbeat: MAX_TIMER_MS - 1 }),
    ).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });
});
