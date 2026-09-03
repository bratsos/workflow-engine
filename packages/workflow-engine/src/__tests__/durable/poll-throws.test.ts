import { describe, expect, it } from "vitest";
import { StepSuspend } from "../../core/steps.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

describe("durable wait polling failures", () => {
  it("logs and backs off without failing the wait", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    const warnings: string[] = [];
    const api = createStepApi({
      stageRecordId: "stage",
      stepLedger: ledger,
      clock,
      onLog: (_level, message) => warnings.push(message),
    });

    const error = await api
      .waitFor("poll", {
        poll: async () => {
          throw new Error("provider unavailable");
        },
        ready: () => false,
        every: 1_000,
        timeout: 3_000,
        pollBackoffMs: 10_000,
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(StepSuspend);
    expect((error as StepSuspend).nextPollAt.getTime()).toBe(
      clock.now().getTime() + 3_000,
    );
    expect(warnings).toEqual([expect.stringContaining("provider unavailable")]);
    expect((await ledger.get("stage", "poll"))?.status).toBe("pending");
  });
});
