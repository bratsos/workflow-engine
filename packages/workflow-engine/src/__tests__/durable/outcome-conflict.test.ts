/**
 * Drift detection at the checkpoint.
 *
 * An ordinal ledger gets this free: position is identity, so a second writer
 * is a second position. A keyed ledger has to ask for it. Two mechanisms can
 * now decide a step is takeable — the lease, and the reclaim path — so a
 * wrong liveness verdict can put two workers inside the same body. The write
 * that records a step's outcome is therefore a compare-and-set against the
 * row still being open: whoever checkpoints first owns the outcome, and the
 * loser parks on what is recorded rather than overwriting it.
 *
 * The row is the authority. A caller only ever sees the recorded outcome,
 * whichever worker it is.
 */

import { describe, expect, it } from "vitest";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import type { StepLedger } from "../../kernel/ports.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

const LEASE_MS = 5 * 60 * 1000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("durable step outcome conflicts", () => {
  it("parks the slow worker on the outcome the fast one recorded", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    const logs: [string, string][] = [];
    const annotations: {
      key: string;
      value: string;
      payload: Record<string, unknown>;
    }[] = [];
    const api = () =>
      createStepApi({
        stageRecordId: "stage",
        stepLedger: ledger,
        clock,
        onLog: (level, message) => logs.push([level, message]),
        onAnnotate: (key, value, opts) =>
          annotations.push({ key, value, payload: opts.payload }),
      });

    const gate = deferred<void>();
    let firstBodyRuns = 0;
    // Worker A takes the step and stalls inside the body, holding the lease.
    const slow = api().run("charge", async () => {
      firstBodyRuns++;
      await gate.promise;
      return "A";
    });
    await Promise.resolve();

    // Its lease expires; worker B takes the step over and finishes first.
    clock.advance(LEASE_MS + 1);
    await expect(api().run("charge", async () => "B")).resolves.toBe("B");

    // Worker A now returns from a body that really did run. Its checkpoint
    // finds the row already terminal and does not overwrite it.
    gate.resolve();
    await expect(slow).resolves.toBe("B");
    expect(firstBodyRuns).toBe(1);

    const row = await ledger.get("stage", "charge");
    expect(row).toMatchObject({ status: "completed", result: "B", attempt: 2 });

    // The conflict is reported, not swallowed: the body ran twice, so an
    // external effect may be duplicated.
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[0]).toBe("WARN");
    expect(logs[0]?.[1]).toContain('durable step "charge"');
    expect(logs[0]?.[1]).toContain("checkpointed first");
    expect(annotations).toEqual([
      {
        key: "step.outcome-conflict",
        value: "completed",
        payload: {
          stepId: "charge",
          kind: "run",
          recordedStatus: "completed",
          recordedAttempt: 2,
          externalKey: row?.externalKey,
        },
      },
    ]);
  });

  it("does not bury a recorded success under a later worker's failure", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    const api = () =>
      createStepApi({ stageRecordId: "stage", stepLedger: ledger, clock });

    const gate = deferred<void>();
    const slow = api().run("charge", async () => {
      await gate.promise;
      throw new Error("worker A lost the provider connection");
    });
    await Promise.resolve();

    clock.advance(LEASE_MS + 1);
    await expect(api().run("charge", async () => "B")).resolves.toBe("B");

    // A's body threw, but B already recorded a success for this step. The
    // ledger keeps it, and A is answered from the ledger like any replay.
    gate.resolve();
    await expect(slow).resolves.toBe("B");
    expect(await ledger.get("stage", "charge")).toMatchObject({
      status: "completed",
      result: "B",
      error: null,
    });
  });

  it("lets a delivered signal beat the deadline that was about to fail it", async () => {
    const clock = new FakeClock();
    const backing = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    // The stage reads the row as still pending, and the signal lands before
    // the deadline write reaches the ledger — the interleaving a signal
    // arriving at the deadline actually produces.
    let stale: Awaited<ReturnType<InMemoryStepLedger["get"]>> = null;
    const ledger: StepLedger = {
      claim: (record) => backing.claim(record),
      get: async (stageRecordId, stepId) => {
        const record = await backing.get(stageRecordId, stepId);
        if (stale) {
          const snapshot = stale;
          stale = null;
          return snapshot;
        }
        return record;
      },
      update: (stageRecordId, stepId, patch) =>
        backing.update(stageRecordId, stepId, patch),
      compareAndSet: (stageRecordId, stepId, expected, patch) =>
        backing.compareAndSet(stageRecordId, stepId, expected, patch),
      list: (stageRecordId) => backing.list(stageRecordId),
      clear: (stageRecordId) => backing.clear(stageRecordId),
    };
    const api = () =>
      createStepApi({ stageRecordId: "stage", stepLedger: ledger, clock });

    await expect(
      api().waitForSignal("approval", { timeout: 1_000 }),
    ).rejects.toMatchObject({ name: "StepSuspend" });
    stale = await backing.get("stage", "approval");
    await backing.update("stage", "approval", {
      status: "completed",
      result: { approved: true },
    });

    clock.advance(2_000);
    // The deadline has passed, but the answer is already recorded.
    await expect(
      api().waitForSignal("approval", { timeout: 1_000 }),
    ).resolves.toEqual({ approved: true });
    expect(await backing.get("stage", "approval")).toMatchObject({
      status: "completed",
    });
  });

  it("keeps a step's own in-flight attempt bumps out of the conflict check", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    const logs: string[] = [];
    const api = createStepApi({
      stageRecordId: "stage",
      stepLedger: ledger,
      clock,
      onLog: (_level, message) => logs.push(message),
    });

    // An AI map item retries its model call in-process and bumps the row's
    // attempt while it holds the step. That is the step talking about
    // itself, not a second writer, so its checkpoint must still apply.
    const value = await api.run("item", async () => {
      await ledger.update("stage", "item", { attempt: 4 });
      return "done";
    });

    expect(value).toBe("done");
    expect(await ledger.get("stage", "item")).toMatchObject({
      status: "completed",
      result: "done",
      attempt: 4,
    });
    expect(logs).toEqual([]);
  });
});
