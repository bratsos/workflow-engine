import { describe, expect, it } from "vitest";
import { StepInFlight } from "../../core/steps.js";
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
});
