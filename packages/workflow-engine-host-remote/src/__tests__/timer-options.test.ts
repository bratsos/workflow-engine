/**
 * Every option that reaches a timer is checked when the executor or the
 * worker is created: `Infinity`, `NaN`, zero, a negative number or more than
 * 2**31 - 1 would otherwise become a 1 ms timer (a busy poll loop, a heartbeat
 * every millisecond, a backoff that is no backoff).
 */

import { describe, expect, it } from "vitest";
import { createRemoteExecutor } from "../orchestrator/remote-executor.js";
import { createActivityWorker } from "../worker/worker.js";

const BAD: unknown[] = [Infinity, -Infinity, NaN, 0, -5, 0.5, 2 ** 31, "5000"];

describe("remote timer options", () => {
  for (const option of ["pollEveryMs"] as const) {
    it(`createRemoteExecutor rejects ${option} when a timer cannot honour it`, () => {
      const create = (value: unknown) =>
        createRemoteExecutor({} as never, { [option]: value as number });
      for (const bad of BAD) {
        expect(() => create(bad), `${option}: ${String(bad)}`).toThrow(
          new RegExp(
            `${option} must be a number of milliseconds from 1 to 2147483647`,
          ),
        );
      }
      expect(() => create(1)).not.toThrow();
      expect(() => create(2 ** 31 - 1)).not.toThrow();
      expect(() => createRemoteExecutor({} as never)).not.toThrow();
    });
  }

  for (const option of [
    "heartbeatMs",
    "idleDelayMs",
    "maxBackoffMs",
  ] as const) {
    it(`createActivityWorker rejects ${option} when a timer cannot honour it`, () => {
      const create = (value: unknown) =>
        createActivityWorker({
          registry: new Map(),
          transport: {} as never,
          workerId: "w1",
          stageIds: [],
          stageCodeVersion: "v1",
          [option]: value,
        });
      for (const bad of BAD) {
        expect(() => create(bad), `${option}: ${String(bad)}`).toThrow(
          new RegExp(
            `${option} must be a number of milliseconds from 1 to 2147483647`,
          ),
        );
      }
      expect(() => create(1)).not.toThrow();
      expect(() => create(2 ** 31 - 1)).not.toThrow();
    });
  }

  it("rejects with a RangeError, as the hosts do", () => {
    expect(() =>
      createRemoteExecutor({} as never, { pollEveryMs: Infinity }),
    ).toThrow(RangeError);
  });
});
