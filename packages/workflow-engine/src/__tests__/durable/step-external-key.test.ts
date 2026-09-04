/**
 * The external key a `run` body receives, and the `onReclaim` declaration
 * that refuses to re-execute a body whose external effect cannot be repeated.
 */

import { describe, expect, it } from "vitest";
import {
  deriveStepExternalKey,
  isStepExternalKey,
  stepExternalKeyPart,
} from "../../core/step-external-key.js";
import { StepNotReplaySafeError } from "../../core/steps.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

const STAGE = "stage-record-1";

function makeApi(ledger: InMemoryStepLedger, clock: FakeClock) {
  return createStepApi({
    stageRecordId: STAGE,
    stepLedger: ledger,
    clock: { now: () => clock.now() },
  });
}

describe("deriveStepExternalKey", () => {
  it("is stable for the same stage record and step id", () => {
    expect(deriveStepExternalKey(STAGE, "submit")).toBe(
      deriveStepExternalKey(STAGE, "submit"),
    );
  });

  it("separates steps and stage records", () => {
    expect(deriveStepExternalKey(STAGE, "submit")).not.toBe(
      deriveStepExternalKey(STAGE, "submit2"),
    );
    expect(deriveStepExternalKey(STAGE, "submit")).not.toBe(
      deriveStepExternalKey("stage-record-2", "submit"),
    );
    // The two halves are hashed with a separator, so a shifted split is not
    // the same key.
    expect(deriveStepExternalKey("a b", "c")).not.toBe(
      deriveStepExternalKey("a", "b c"),
    );
  });

  it("only ever emits characters every provider field accepts", () => {
    const key = stepExternalKeyPart(deriveStepExternalKey(STAGE, "submit"), 3);
    expect(key).toMatch(/^wfe-[0-9a-f]{32}-p3$/);
    expect(key.length).toBeLessThanOrEqual(64);
    expect(isStepExternalKey(key)).toBe(true);
    expect(isStepExternalKey("some-other-batch")).toBe(false);
  });
});

describe("step.run external key", () => {
  it("hands the body a key that is identical on the replay after a crash", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: () => clock.now() });
    const seen: Array<{ key: string; isReclaim: boolean; attempt: number }> =
      [];

    // First worker: takes the lease, never records an outcome.
    const first = makeApi(ledger, clock).run("submit", async (step) => {
      seen.push({
        key: step.externalKey,
        isReclaim: step.isReclaim,
        attempt: step.attempt,
      });
      return new Promise<string>(() => {});
    });
    void first.catch(() => {});
    await Promise.resolve();

    // The lease expires and a second worker takes the step over.
    clock.advance(6 * 60 * 1000);
    const value = await makeApi(ledger, clock).run("submit", async (step) => {
      seen.push({
        key: step.externalKey,
        isReclaim: step.isReclaim,
        attempt: step.attempt,
      });
      return "done";
    });

    expect(value).toBe("done");
    expect(seen).toEqual([
      {
        key: deriveStepExternalKey(STAGE, "submit"),
        isReclaim: false,
        attempt: 1,
      },
      {
        key: deriveStepExternalKey(STAGE, "submit"),
        isReclaim: true,
        attempt: 2,
      },
    ]);
  });

  it("writes the key to the row before the body runs", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: () => clock.now() });
    let rowDuringBody: string | null | undefined;

    await makeApi(ledger, clock).run("submit", async () => {
      rowDuringBody = (await ledger.get(STAGE, "submit"))?.externalKey;
      return 1;
    });

    expect(rowDuringBody).toBe(deriveStepExternalKey(STAGE, "submit"));
  });
});

describe('step.run onReclaim: "fail"', () => {
  it("refuses to re-execute the body and names the step and its key", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: () => clock.now() });
    let executions = 0;

    const first = makeApi(ledger, clock).run(
      "charge",
      async () => {
        executions++;
        return new Promise<string>(() => {});
      },
      { onReclaim: "fail" },
    );
    void first.catch(() => {});
    await Promise.resolve();

    clock.advance(6 * 60 * 1000);
    const replay = makeApi(ledger, clock).run(
      "charge",
      async () => {
        executions++;
        return "charged";
      },
      { onReclaim: "fail" },
    );

    await expect(replay).rejects.toBeInstanceOf(StepNotReplaySafeError);
    await expect(replay).rejects.toThrow(
      new RegExp(deriveStepExternalKey(STAGE, "charge")),
    );
    expect(executions).toBe(1);

    // The row is left failed, so the next replay meets the stored error
    // rather than racing to the same decision again.
    const row = await ledger.get(STAGE, "charge");
    expect(row?.status).toBe("failed");
    await expect(
      makeApi(ledger, clock).run("charge", async () => "charged", {
        onReclaim: "fail",
      }),
    ).rejects.toThrow(/onReclaim: "fail"/);
    expect(executions).toBe(1);
  });

  it('defaults to "rerun", which is what every earlier version did', async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: () => clock.now() });
    let executions = 0;

    const first = makeApi(ledger, clock).run("submit", async () => {
      executions++;
      return new Promise<string>(() => {});
    });
    void first.catch(() => {});
    await Promise.resolve();

    clock.advance(6 * 60 * 1000);
    await expect(
      makeApi(ledger, clock).run("submit", async () => {
        executions++;
        return "done";
      }),
    ).resolves.toBe("done");
    expect(executions).toBe(2);
  });
});
