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
  return { clock, ledger, api };
}

describe("durable run option names", () => {
  it("accepts `lease` as a duration string and keeps `leaseMs` as an alias", async () => {
    const { clock, ledger, api } = setup();
    const leaseOf = async (id: string) =>
      (await ledger.get("stage", id))?.leaseExpiresAt?.getTime();

    const canonical = api().run("canonical", () => new Promise(() => {}), {
      lease: "2m",
    });
    const alias = api().run("alias", () => new Promise(() => {}), {
      leaseMs: 90_000,
    });
    const both = api().run("both", () => new Promise(() => {}), {
      lease: "2m",
      leaseMs: 90_000,
    });
    void canonical;
    void alias;
    void both;
    await Promise.resolve();

    expect(await leaseOf("canonical")).toBe(clock.now().getTime() + 120_000);
    expect(await leaseOf("alias")).toBe(clock.now().getTime() + 90_000);
    expect(await leaseOf("both")).toBe(clock.now().getTime() + 120_000);
  });

  it("accepts `retryDelay` and prefers it over the `retryDelayMs` alias", async () => {
    const { clock, api } = setup();
    const fail = async () => {
      throw new Error("transient");
    };

    const canonical = await api()
      .run("canonical", fail, { retries: 1, retryDelay: "10s" })
      .catch((error: unknown) => error);
    expect(canonical).toBeInstanceOf(StepSuspend);
    expect((canonical as StepSuspend).nextPollAt.getTime()).toBe(
      clock.now().getTime() + 10_000,
    );

    const both = await api()
      .run("both", fail, { retries: 1, retryDelay: "10s", retryDelayMs: 2_000 })
      .catch((error: unknown) => error);
    expect((both as StepSuspend).nextPollAt.getTime()).toBe(
      clock.now().getTime() + 10_000,
    );
  });
});
