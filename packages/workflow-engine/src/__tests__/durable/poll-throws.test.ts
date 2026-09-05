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

  it("logs the first three consecutive failures at DEBUG and escalates to WARN, resetting once a poll answers", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    const logs: string[] = [];
    let mode: "throw" | "not-ready" = "throw";
    const poll = async () => {
      if (mode === "throw") throw new Error("Batch job x not found");
      return false;
    };
    const attempt = () =>
      createStepApi({
        stageRecordId: "stage",
        stepLedger: ledger,
        clock,
        onLog: (level, message) => logs.push(`${level}: ${message}`),
      })
        .waitFor("poll", {
          poll,
          ready: (v) => v === true,
          every: 1_000,
          timeout: 60_000,
          pollBackoffMs: 1_000,
        })
        .catch((value: unknown) => value);

    // Each replay is a fresh step API (a new process): the streak count
    // must come from the ledger row, not from memory.
    for (let i = 0; i < 4; i++) {
      expect(await attempt()).toBeInstanceOf(StepSuspend);
      clock.advance(1_000);
    }
    expect(logs.map((l) => l.split(":")[0])).toEqual([
      "DEBUG",
      "DEBUG",
      "DEBUG",
      "WARN",
    ]);
    expect(logs[3]).toContain("(4 consecutive)");
    expect((await ledger.get("stage", "poll"))?.waitState?.pollFailures).toBe(
      4,
    );

    // A poll that answers (not ready) ends the streak.
    mode = "not-ready";
    expect(await attempt()).toBeInstanceOf(StepSuspend);
    expect(
      (await ledger.get("stage", "poll"))?.waitState?.pollFailures,
    ).toBeUndefined();
    mode = "throw";
    clock.advance(1_000);
    expect(await attempt()).toBeInstanceOf(StepSuspend);
    expect(logs.at(-1)).toMatch(/^DEBUG: .*\(1 consecutive\)/);
  });
});
