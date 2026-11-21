/**
 * `assertTimerMs`: a host option that reaches `setTimeout` or `setInterval`
 * must be a finite number of milliseconds a timer can honour. `Infinity`,
 * `NaN`, a negative number or a value above 2**31 - 1 fires after 1 ms, which
 * turns "no limit" into the tightest bound and an interval into a busy loop.
 */

import { describe, expect, it } from "vitest";
import {
  assertTimerMs,
  executeJobWithHeartbeat,
  MAX_TIMER_MS,
  runTickHook,
} from "../../kernel/helpers/host-support.js";
import { createTestKernel } from "../utils/index.js";

const BAD = [
  Infinity,
  -Infinity,
  NaN,
  -5,
  0,
  0.5,
  MAX_TIMER_MS + 1,
  "5000",
  null,
];

describe("assertTimerMs", () => {
  it("returns a value a timer honours", () => {
    expect(assertTimerMs("x", 1)).toBe(1);
    expect(assertTimerMs("x", 10_000)).toBe(10_000);
    expect(assertTimerMs("x", MAX_TIMER_MS)).toBe(MAX_TIMER_MS);
  });

  it("refuses what a timer cannot honour, naming the option and the range", () => {
    for (const bad of BAD) {
      expect(() => assertTimerMs("someOption", bad), String(bad)).toThrow(
        new RegExp(
          `someOption must be a number of milliseconds from 1 to ${MAX_TIMER_MS}`,
        ),
      );
    }
    expect(() => assertTimerMs("someOption", Infinity)).toThrow(RangeError);
    expect(() => assertTimerMs("x", 0, { hint: "Because." })).toThrow(
      /Because\.$/,
    );
  });

  it("accepts 0 only where the option documents 0 as off", () => {
    expect(assertTimerMs("x", 0, { allowZero: true })).toBe(0);
    expect(() => assertTimerMs("x", -1, { allowZero: true })).toThrow(
      RangeError,
    );
    expect(() => assertTimerMs("x", NaN, { allowZero: true })).toThrow(
      RangeError,
    );
  });
});

describe("the helpers that start the timers", () => {
  it("executeJobWithHeartbeat refuses a heartbeat interval before it touches the job", async () => {
    const { kernel, jobTransport } = createTestKernel([]);
    await expect(
      executeJobWithHeartbeat(kernel, {
        jobTransport,
        job: {} as never,
        jobHeartbeatIntervalMs: Infinity,
      }),
    ).rejects.toThrow(/jobHeartbeatIntervalMs must be/);
  });

  it("runTickHook refuses a bound that is not a timeout", async () => {
    const counts = {} as never;
    await expect(
      runTickHook(async () => {}, counts, "[T]", Infinity),
    ).rejects.toThrow(/timeoutMs must be/);
    await expect(
      runTickHook(undefined, counts, "[T]", Infinity),
    ).resolves.toBeUndefined();
  });
});
