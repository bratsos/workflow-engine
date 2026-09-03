import { describe, expect, it } from "vitest";
import { StepResultNotSerializable } from "../../core/steps.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

function setup(onLog?: (level: "DEBUG" | "WARN", message: string) => void) {
  const clock = new FakeClock();
  const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
  return {
    clock,
    ledger,
    api: () =>
      createStepApi({
        stageRecordId: "stage-1",
        stepLedger: ledger,
        clock,
        onLog,
      }),
  };
}

describe("StepApi.run", () => {
  it("memoizes a successful function across fresh APIs", async () => {
    const { api, ledger } = setup();
    let calls = 0;

    await expect(
      api().run("work", async () => {
        calls++;
        return { answer: 42 };
      }),
    ).resolves.toEqual({ answer: 42 });
    await expect(
      api().run("work", async () => ({ answer: 0 })),
    ).resolves.toEqual({
      answer: 42,
    });

    expect(calls).toBe(1);
    expect((await ledger.get("stage-1", "work"))?.status).toBe("completed");
  });

  it("stores a failed function and rethrows its error on replay", async () => {
    const { api, ledger } = setup();

    await expect(
      api().run("work", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(api().run("work", async () => "new")).rejects.toThrow("boom");
    expect((await ledger.get("stage-1", "work"))?.status).toBe("failed");
  });

  it("rejects a non-JSON result before storing it", async () => {
    const { api, ledger } = setup();

    await expect(
      api().run("work", async () => ({ value: BigInt(1) })),
    ).rejects.toBeInstanceOf(StepResultNotSerializable);
    expect((await ledger.get("stage-1", "work"))?.status).toBe("running");
  });

  it("rejects duplicate step ids within one invocation", async () => {
    const { api } = setup();
    const instance = api();

    await instance.run("work", async () => "done");
    await expect(instance.run("work", async () => "again")).rejects.toThrow(
      /Duplicate durable step id/,
    );
  });

  it("warns when replay requests steps in a different order", async () => {
    const warnings: string[] = [];
    const { api } = setup((_level, message) => warnings.push(message));

    const firstInvocation = api();
    await firstInvocation.run("first", async () => "1");
    await firstInvocation.run("second", async () => "2");
    const replayInvocation = api();
    await replayInvocation.run("second", async () => "2");
    await replayInvocation.run("first", async () => "1");

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/first|second/);
    expect(
      warnings.every((warning) => /non-deterministic step order/.test(warning)),
    ).toBe(true);
  });
});
