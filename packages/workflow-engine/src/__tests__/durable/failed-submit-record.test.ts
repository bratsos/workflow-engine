/**
 * A batch submit step keeps the submit record its body wrote through the
 * step's failure write and its re-open.
 *
 * `run.cancel` and the redriven submit read the submit record (the partial
 * record that keeps accepted partitions reachable, the tombstone, a cancel
 * sweep's fence). A failure write that replaced the result would erase the
 * one the body had just written. The kernel-level cases
 * (the sweep's hold and release, the submit step's own writes, the stage-level
 * verdict) are in `kernel/run-cancel-batches.test.ts` and
 * `kernel/run-cancel-provider-state.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { NonRetryableError } from "../../core/steps.js";
import { parseStoredSubmit } from "../../kernel/helpers/batch-submit-record.js";
import { reopenFailedSteps } from "../../kernel/helpers/stage-retry.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import type { KernelDeps } from "../../kernel/kernel.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";

const REF = {
  version: 1,
  type: "text",
  id: "batch-1",
  provider: "openrouter",
  modelId: "openai/gpt-4o",
} as const;

/** What the submit body records while it executes, after a partition was rejected. */
const PARTIAL = {
  handleId: "batch-1",
  refs: [REF],
  requestIds: ["a", "b"],
  totalRequests: 2,
  externalKey: "wfe-0123456789abcdef0123456789abcdef",
  partial: true,
};

function setup() {
  const clock = new FakeClock();
  const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
  const api = () =>
    createStepApi({ stageRecordId: "stage", stepLedger: ledger, clock });
  /** The body of a submit step that recorded its partial result, then failed. */
  const submitFailing = (error: () => Error) => async () => {
    await ledger.update("stage", "x:submit", { result: PARTIAL });
    throw error();
  };
  return { clock, ledger, api, submitFailing };
}

describe("a failed batch submit step", () => {
  it("keeps its submit record", async () => {
    const { ledger, api, submitFailing } = setup();

    await api()
      .run(
        "x:submit",
        submitFailing(() => new Error("HTTP 503")),
      )
      .catch(() => {});

    const row = (await ledger.get("stage", "x:submit"))!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("HTTP 503");
    expect(row.result).toEqual(PARTIAL);
    expect(parseStoredSubmit(row.result)).toMatchObject(PARTIAL);
  });

  it("with retries left, the retry runs and finds the record the failed attempt wrote", async () => {
    const { ledger, api, clock } = setup();
    let seen: unknown;
    const body = async () => {
      if (
        seen === undefined &&
        (await ledger.get("stage", "x:submit"))?.attempt === 1
      ) {
        await ledger.update("stage", "x:submit", { result: PARTIAL });
        seen = null;
        throw new Error("HTTP 503");
      }
      seen = (await ledger.get("stage", "x:submit"))?.result;
      return "submitted";
    };

    const first = await api()
      .run("x:submit", body, { retries: 1 })
      .catch((error: unknown) => error);
    expect(first).toMatchObject({ kind: "retry" });
    const failed = (await ledger.get("stage", "x:submit"))!;
    expect(failed.status).toBe("failed");
    expect(parseStoredSubmit(failed.result)).toMatchObject(PARTIAL);

    clock.advance(1);
    await expect(api().run("x:submit", body, { retries: 1 })).resolves.toBe(
      "submitted",
    );

    // The retry saw the record, and completing replaced the result.
    expect(parseStoredSubmit(seen)).toMatchObject(PARTIAL);
    expect(await ledger.get("stage", "x:submit")).toMatchObject({
      status: "completed",
      attempt: 2,
      result: "submitted",
    });
  });

  it("keeps the submit record under a NonRetryableError and through a stage retry's re-open", async () => {
    const { ledger, api, submitFailing } = setup();

    await api()
      .run(
        "x:submit",
        submitFailing(() => new NonRetryableError("rejected for good")),
        { retries: 3 },
      )
      .catch(() => {});

    const row = (await ledger.get("stage", "x:submit"))!;
    expect(row).toMatchObject({ status: "failed", attempt: 1 });
    expect(row.result).toEqual(PARTIAL);
    await reopenFailedSteps("stage", {
      stepLedger: ledger,
    } as unknown as KernelDeps);
    const reopened = (await ledger.get("stage", "x:submit"))!;
    expect(reopened).toMatchObject({ status: "running", leaseExpiresAt: null });
    expect(parseStoredSubmit(reopened.result)).toMatchObject(PARTIAL);
  });
});

describe("a failed step that is not a batch submit", () => {
  it("keeps an object already in the row's result", async () => {
    const { ledger, api } = setup();

    await api()
      .run("ordinary", async () => {
        await ledger.update("stage", "ordinary", { result: PARTIAL });
        throw new Error("boom");
      })
      .catch(() => {});

    const row = (await ledger.get("stage", "ordinary"))!;
    expect(row.result).toEqual(PARTIAL);
  });
});
