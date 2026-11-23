import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../core/stage-factory.js";
import type { StepApi } from "../core/steps.js";
import { WorkflowBuilder } from "../core/workflow.js";
import {
  executeJobWithHeartbeat,
  runMaintenanceTick,
} from "../kernel/helpers/host-support.js";
import type { Kernel, KernelConfig } from "../kernel/kernel.js";
import { CollectingEventSink, FakeClock } from "../kernel/testing/index.js";
import {
  type KernelDatabase,
  kernelDatabase,
  override,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";

const input = z.object({});
const output = z.object({ branch: z.string() });
const timeoutResult = { timedOut: true } as const;

function barrier() {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: release.resolve,
    async pause() {
      reached.resolve();
      await release.promise;
    },
  };
}

describe.skipIf(!realDatabase)(
  `durable deadline outcomes on ${sqlite ? "SQLite" : "Postgres"}`,
  () => {
    let db: KernelDatabase;
    let clock: FakeClock;
    let events: CollectingEventSink;

    beforeAll(async () => {
      db = await kernelDatabase();
    }, 120_000);
    beforeEach(async () => {
      await db.reset();
      clock = new FakeClock(new Date());
      events = new CollectingEventSink();
    });
    afterAll(async () => {
      await db?.close();
    });

    async function start(
      execute: (step: StepApi) => Promise<string>,
      overrides: Partial<KernelConfig> = {},
    ) {
      const stage = defineStage({
        id: "try",
        name: "Try",
        schemas: { input, output, config: input },
        async execute({ step }) {
          return { output: { branch: await execute(step) } };
        },
      });
      const workflow = new WorkflowBuilder(
        "deadline-outcome",
        "Deadline outcome",
        "deadline-outcome",
        input,
        output,
      )
        .pipe(stage)
        .build();
      const worker = (changes: Partial<KernelConfig> = {}) =>
        db.makeKernel({
          registry: { getWorkflow: () => workflow },
          clock,
          eventSink: events,
          ...changes,
        });
      const first = worker(overrides);
      const { workflowRunId } = await first.dispatch({
        type: "run.create",
        idempotencyKey: crypto.randomUUID(),
        workflowId: workflow.id,
        input: {},
      });
      const tick = (kernel = first, workerId = "first") =>
        runMaintenanceTick(kernel, { workerId });
      await tick();
      const getStage = () => db.persistence.getStage(workflowRunId, stage.id);
      const stageRecord = (await getStage())!;
      const job = (await db.jobTransport.dequeue())!;
      return {
        worker,
        tick,
        getStage,
        record: (stepId = "answer") =>
          db.stepLedger.get(stageRecord.id, stepId),
        execute: () =>
          executeJobWithHeartbeat(first, {
            jobTransport: db.jobTransport,
            job,
          }),
        signal: (kernel: Kernel, payload: unknown, stepId = "answer") =>
          kernel.dispatch({
            type: "step.signal",
            workflowRunId,
            stageId: stage.id,
            stepId,
            payload,
          }),
        async status() {
          return (await db.persistence.getRun(workflowRunId))?.status;
        },
      };
    }

    it("continues on timeout and ignores a late signal without emitting an event", async () => {
      const t = await start(async (step) => {
        const answer = await step.waitForSignal<string>("answer", {
          onTimeout: "return",
          timeout: "20m",
        });
        return answer.timedOut ? "try the next business" : answer.value;
      });

      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      expect(await t.record()).toMatchObject({
        status: "pending",
        waitState: { onTimeout: "return" },
      });
      clock.advance(20 * 60_000);
      await t.tick();
      expect(await t.status()).toBe("COMPLETED");
      const { _artifactKey } = (await t.getStage())?.outputData as {
        _artifactKey: string;
      };
      expect(await db.blobStore.get(_artifactKey)).toEqual({
        branch: "try the next business",
      });
      expect(await t.record()).toMatchObject({
        status: "completed",
        waitState: { onTimeout: "return", timedOut: true },
      });

      const nextPollAt = (await t.getStage())?.nextPollAt;
      await expect(t.signal(t.worker(), "late")).resolves.toEqual({
        ok: true,
        signalled: false,
        alreadyCompleted: true,
        timedOut: true,
      });
      expect((await t.getStage())?.nextPollAt).toEqual(nextPollAt);
      expect(events.getByType("step:signalled")).toEqual([]);
      expect(
        (await db.persistence.getUnpublishedOutboxEvents(100)).filter(
          (event) => event.eventType === "step:signalled",
        ),
      ).toEqual([]);
    });

    it("recovers after a worker stops after reading the timeout but before stage completion", async () => {
      const stopped = barrier();
      const seen: unknown[] = [];
      const t = await start(async (step) => {
        const outcome = await step.waitForSignal("answer", {
          onTimeout: "return",
          timeout: 100,
        });
        seen.push(outcome);
        if (seen.length === 1) await stopped.pause();
        return outcome.timedOut ? "fallback" : "answered";
      });
      await t.execute();
      clock.advance(100);

      const firstTick = t.tick();
      try {
        // A worker can disappear with the ledger write committed and its
        // stage lease held. Advance past the lease and use a fresh kernel.
        await Promise.race([stopped.reached, firstTick]);
        expect(await t.record()).toMatchObject({
          status: "completed",
          waitState: { timedOut: true },
        });
        expect((await t.getStage())?.status).toBe("SUSPENDED");
        clock.advance(5 * 60_000);
        await t.tick(t.worker(), "restarted");
        expect(await t.status()).toBe("COMPLETED");
      } finally {
        stopped.release();
        await firstTick;
      }
      expect(seen).toEqual([timeoutResult, timeoutResult]);
      expect(events.getByType("stage:completed")).toHaveLength(1);
    });

    it.each([
      "signal",
      "deadline",
    ] as const)("keeps the %s when it wins the same-tick race between two workers", async (winner) => {
      const losingWrite = barrier();
      const seen: unknown[] = [];
      const t = await start(
        async (step) => {
          const answer = await step.waitForSignal<string>("answer", {
            onTimeout: "return",
            timeout: 100,
          });
          seen.push(answer);
          await step.waitForSignal("finish", { timeout: "10m" });
          return answer.timedOut ? "fallback" : answer.value;
        },
        winner === "signal"
          ? {
              stepLedger: override(db.stepLedger, {
                async compareAndSet(...args) {
                  if (args[1] === "answer") await losingWrite.pause();
                  return db.stepLedger.compareAndSet(...args);
                },
              }),
            }
          : {},
      );
      const delivery = t.worker(
        winner === "deadline"
          ? {
              stepLedger: override(db.stepLedger, {
                async compareAndSet(...args) {
                  if (args[1] === "answer") await losingWrite.pause();
                  return db.stepLedger.compareAndSet(...args);
                },
              }),
            }
          : {},
      );
      await t.execute();
      clock.advance(100);

      const signal = () => t.signal(delivery, "accepted");
      const loser = winner === "signal" ? t.tick() : signal();
      try {
        await Promise.race([losingWrite.reached, loser]);
        if (winner === "signal") {
          await expect(signal()).resolves.toMatchObject({ signalled: true });
        } else {
          await t.tick();
        }
      } finally {
        losingWrite.release();
      }
      const result = await loser;
      if (winner === "deadline") {
        expect(result).toMatchObject({ signalled: false, timedOut: true });
      }

      // If the signal invalidated the first poller's stage lease, the next
      // tick adopts the persisted signal and suspends on "finish".
      await t.tick(delivery, "second");
      expect(await t.record("finish")).toMatchObject({ status: "pending" });
      await t.signal(delivery, null, "finish");
      await t.tick(delivery, "second");
      expect(await t.status()).toBe("COMPLETED");
      const outcome =
        winner === "signal"
          ? { timedOut: false, value: "accepted" }
          : timeoutResult;
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen).toEqual(seen.map(() => outcome));
      const answers = events
        .getByType("step:signalled")
        .filter((event) => event.stepId === "answer");
      expect(answers).toHaveLength(winner === "signal" ? 1 : 0);
    });

    it("wraps an early signal even though the ledger has no waitState yet", async () => {
      const seen: unknown[] = [];
      const t = await start(async (step) => {
        const answer = await step.waitForSignal("answer", {
          onTimeout: "return",
          timeout: 0,
        });
        seen.push(answer);
        return answer.timedOut ? "fallback" : "answered";
      });
      await t.signal(t.worker(), { accepted: true });
      expect((await t.record())?.waitState).toBeUndefined();
      await expect(t.execute()).resolves.toMatchObject({
        outcome: "completed",
      });
      expect(seen).toEqual([{ timedOut: false, value: { accepted: true } }]);
    });

    it.each([
      "signal",
      "poll",
      "not ready",
      "poll throws",
    ] as const)("returns timeout during job execution (%s)", async (path) => {
      const seen: unknown[] = [];
      let polls = 0;
      const t = await start(async (step) => {
        const opts = {
          onTimeout: "return",
          timeout: path === "signal" || path === "poll" ? 0 : 100,
        } as const;
        const result =
          path === "signal"
            ? await step.waitForSignal("answer", opts)
            : await step.waitFor("answer", {
                ...opts,
                every: 10,
                async poll() {
                  polls++;
                  clock.advance(100);
                  if (path === "poll throws") throw new Error("poll failed");
                  return false;
                },
                ready: (value) => value,
              });
        seen.push(result);
        return result.timedOut ? "fallback" : "answered";
      });

      await expect(t.execute()).resolves.toMatchObject({
        outcome: "completed",
      });
      expect(seen).toEqual([timeoutResult]);
      expect(polls).toBe(
        path === "not ready" || path === "poll throws" ? 1 : 0,
      );
    });

    it("continues after a suspended polling wait reaches its deadline", async () => {
      const seen: unknown[] = [];
      let polls = 0;
      const t = await start(async (step) => {
        const answer = await step.waitFor("answer", {
          onTimeout: "return",
          every: "5m",
          timeout: "20m",
          async poll() {
            polls++;
            return { ready: false };
          },
          ready: (value) => value.ready,
        });
        seen.push(answer);
        return answer.timedOut ? "fallback" : "answered";
      });

      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      clock.advance(20 * 60_000);
      await t.tick(t.worker(), "second");
      expect(await t.status()).toBe("COMPLETED");
      expect(seen).toEqual([timeoutResult]);
      expect(polls).toBe(1);
    });

    it("fails a default deadline alongside other concurrent waits", async () => {
      let firstPass = true;
      const t = await start(async (step) => {
        const waits = [
          step.waitForSignal("answer", { timeout: 100, onTimeout: "return" }),
          step.waitForSignal("required", { timeout: 100 }),
          step.waitForSignal("other", { timeout: "2h", keepalive: "1h" }),
        ] as const;
        if (firstPass) {
          firstPass = false;
          // Let every wait checkpoint before the first suspension, then
          // choose the short deadline regardless of claim order.
          const [answer] = await Promise.allSettled(waits);
          if (answer.status === "rejected") throw answer.reason;
        }
        await Promise.all(waits);
        return "answered";
      });

      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      expect(await t.record("other")).toMatchObject({ status: "pending" });
      clock.advance(100);
      await t.tick();
      expect(await t.status()).toBe("FAILED");
      expect(await t.record("required")).toMatchObject({
        status: "failed",
        error: 'Durable wait step "required" exceeded its timeout',
      });
    });

    it.each([
      "increment",
      "reset",
    ] as const)("keeps the timeout when a stale poll tries to %s its failure streak", async (operation) => {
      const writing = barrier();
      const reset = operation === "reset";
      const seen: unknown[] = [];
      let polls = 0;
      let racing = false;
      const t = await start(
        async (step) => {
          const answer = await step.waitFor("answer", {
            every: 10,
            timeout: 100,
            onTimeout: "return",
            async poll() {
              polls++;
              if (reset ? polls === 1 : polls === 2) {
                throw new Error("poll failed");
              }
              return false;
            },
            ready: (value) => value,
          });
          seen.push(answer);
          return answer.timedOut ? "fallback" : "answered";
        },
        {
          stepLedger: override(db.stepLedger, {
            async compareAndSet(...args) {
              const patch = args[3];
              if (racing && patch.waitState && !patch.status) {
                await writing.pause();
              }
              return db.stepLedger.compareAndSet(...args);
            },
            async update(...args) {
              if (racing && args[2].waitState) await writing.pause();
              return db.stepLedger.update(...args);
            },
          }),
        },
      );
      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      clock.advance(10);
      racing = true;
      const firstTick = t.tick();
      try {
        await Promise.race([writing.reached, firstTick]);
        clock.advance(90);
        await t.tick(t.worker(), "second");
        expect(await t.status()).toBe("COMPLETED");
      } finally {
        writing.release();
        await firstTick;
      }
      expect(await t.record()).toMatchObject({
        status: "completed",
        waitState: { timedOut: true, onTimeout: "return" },
      });
      expect(seen).toEqual([timeoutResult, timeoutResult]);
    });

    it.each([
      undefined,
      "throw",
    ] as const)("preserves the failing timeout with onTimeout %s", async (onTimeout) => {
      let continued = false;
      const t = await start(async (step) => {
        await step.waitForSignal("answer", { onTimeout, timeout: 100 });
        continued = true;
        return "answered";
      });

      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      clock.advance(100);
      await t.tick();
      expect(await t.status()).toBe("FAILED");
      expect(await t.record()).toMatchObject({
        status: "failed",
        error: 'Durable wait step "answer" exceeded its timeout',
      });
      expect(continued).toBe(false);
      await expect(t.signal(t.worker(), "late")).rejects.toThrow("has failed");
    });
  },
);
