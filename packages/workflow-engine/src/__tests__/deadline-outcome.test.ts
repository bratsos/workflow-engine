import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../core/stage-factory.js";
import { type StepApi, StepTimeoutError } from "../core/steps.js";
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

/** A wait's answer as stage output, in either result shape. */
function outcome(answer: unknown): string {
  if (typeof answer !== "object" || answer === null) return String(answer);
  const result = answer as { timedOut: boolean; value?: unknown };
  return result.timedOut ? "timeout" : String(result.value);
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
          timeout: "15m",
        });
        return answer.timedOut ? "approval expired" : answer.value;
      });

      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      expect(await t.record()).toMatchObject({
        status: "pending",
        waitState: { onTimeout: "return" },
      });
      clock.advance(15 * 60_000);
      await t.tick();
      expect(await t.status()).toBe("COMPLETED");
      const { _artifactKey } = (await t.getStage())?.outputData as {
        _artifactKey: string;
      };
      expect(await db.blobStore.get(_artifactKey)).toEqual({
        branch: "approval expired",
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

    it.each([
      { entry: "job", keepalive: "1h" },
      { entry: "replay", keepalive: "1h" },
      { entry: "job", keepalive: 35 },
    ] as const)("wakes at the earliest parallel deadline during $entry suspension with a $keepalive keepalive", async ({
      entry,
      keepalive,
    }) => {
      let advanced = false;
      let longSuspended = Promise.withResolvers<void>();
      const stepLedger = override(db.stepLedger, {
        async get(stageId, stepId) {
          // Let the long wait reject first while preserving both claims, on
          // every replay: a default wait schedules the stage only when it
          // suspends first.
          if (stepId === "approval") await longSuspended.promise;
          return db.stepLedger.get(stageId, stepId);
        },
      });
      const t = await start(
        async (step) => {
          if (entry === "replay") {
            await step.waitForSignal("start", {
              timeout: 50,
              onTimeout: "return",
            });
          }
          longSuspended = Promise.withResolvers<void>();
          const [, approval] = await Promise.all([
            step
              .waitForSignal("long", { timeout: "2h", keepalive })
              .finally(() => longSuspended.resolve()),
            step
              .waitForSignal<string>("approval", {
                timeout: 100,
                onTimeout: "return",
              })
              .finally(() => {
                // Exercise the gap between the short suspension and the
                // stage write without moving the original deadline.
                if (!advanced && keepalive === "1h") {
                  advanced = true;
                  clock.advance(10);
                }
              }),
          ]);
          return approval.timedOut ? "expired" : approval.value;
        },
        { stepLedger },
      );
      const started = clock.now().getTime() + (entry === "replay" ? 50 : 0);
      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      const worker = t.worker({ stepLedger });
      if (entry === "replay") {
        clock.advance(50);
        await t.tick(worker, "second");
      }
      const deadline = new Date(started + 100);
      expect(clock.now().getTime()).toBe(
        started + (keepalive === "1h" ? 10 : 0),
      );
      expect(await t.getStage()).toMatchObject({
        nextPollAt:
          typeof keepalive === "number"
            ? new Date(started + keepalive)
            : deadline,
        maxWaitUntil: deadline,
      });
      if (typeof keepalive === "number") {
        for (const time of [35, 70]) {
          clock.set(new Date(started + time));
          await t.tick(worker, "second");
          expect(await t.getStage()).toMatchObject({
            nextPollAt: new Date(started + Math.min(time + keepalive, 100)),
            maxWaitUntil: deadline,
          });
        }
      }
      clock.set(new Date(started + 99));
      await t.tick(worker, "second");
      expect(await t.record("approval")).toMatchObject({ status: "pending" });
      clock.advance(1);
      await t.tick(worker, "second");
      expect(await t.record("approval")).toMatchObject({
        status: "completed",
        waitState: { timedOut: true },
      });
      clock.advance(60_000);
      await t.tick(worker, "second");
      await expect(t.signal(worker, "late", "approval")).resolves.toMatchObject(
        {
          signalled: false,
          timedOut: true,
        },
      );
      await t.signal(worker, null, "long");
      await t.tick(worker, "second");
      expect(await t.status()).toBe("COMPLETED");
      const { _artifactKey } = (await t.getStage())?.outputData as {
        _artifactKey: string;
      };
      expect(await db.blobStore.get(_artifactKey)).toEqual({
        branch: "expired",
      });
      expect(
        events.getByType("step:signalled").map((event) => event.stepId),
      ).toEqual(["long"]);
    });

    it("schedules a parallel poll's deadline while its external check is still running", async () => {
      const checking = barrier();
      const t = await start(async (step) => {
        const [, approval] = await Promise.all([
          step.waitForSignal("long", { timeout: "2h", keepalive: "1h" }),
          step.waitFor("approval", {
            timeout: 100,
            every: "1h",
            onTimeout: "return",
            async poll() {
              await checking.pause();
              return false;
            },
            ready: (value) => value,
          }),
        ]);
        return approval.timedOut ? "expired" : "approved";
      });
      const execution = t.execute();
      try {
        await checking.reached;
        await expect(execution).resolves.toMatchObject({
          outcome: "suspended",
        });
        expect((await t.getStage())?.nextPollAt).toEqual(
          new Date(clock.now().getTime() + 100),
        );
        clock.advance(100);
        await t.tick(t.worker(), "second");
        expect(await t.record("approval")).toMatchObject({
          status: "completed",
          waitState: { timedOut: true },
        });
      } finally {
        checking.release();
        await execution;
      }
    });

    it("includes a wait started by a parallel branch after a completed step", async () => {
      const longSuspended = Promise.withResolvers<void>();
      const t = await start(
        async (step) => {
          await Promise.all([
            step
              .waitForSignal("long", { timeout: "2h", keepalive: "1h" })
              .finally(() => longSuspended.resolve()),
            (async () => {
              await step.waitForSignal("prerequisite", { timeout: "1h" });
              await step.waitForSignal("approval", {
                onTimeout: "return",
                timeout: 100,
              });
            })(),
          ]);
          return "finished";
        },
        {
          stepLedger: override(db.stepLedger, {
            async get(stageId, stepId) {
              if (stepId === "prerequisite") await longSuspended.promise;
              return db.stepLedger.get(stageId, stepId);
            },
          }),
        },
      );
      const worker = t.worker();
      await t.signal(worker, null, "prerequisite");
      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      const deadline = new Date(clock.now().getTime() + 100);
      expect(await t.getStage()).toMatchObject({
        nextPollAt: deadline,
        maxWaitUntil: deadline,
      });
      clock.advance(100);
      await t.tick(worker, "second");
      expect(await t.record("approval")).toMatchObject({
        status: "completed",
        waitState: { timedOut: true },
      });
    });

    it.each([
      { keepalive: undefined, due: 100, shortId: "short" },
      { keepalive: 50, due: 50, shortId: "short" },
      // A valid step id that a plain object would take as its prototype.
      { keepalive: 50, due: 50, shortId: "__proto__" },
    ] as const)("keeps a persisted wait's schedule when an early replay does not reach it (keepalive $keepalive, step $shortId)", async ({
      keepalive,
      due,
      shortId,
    }) => {
      const shortClaimed = Promise.withResolvers<void>();
      const continuation = Promise.withResolvers<void>();
      let delayContinuation = false;
      const stepLedger = override(db.stepLedger, {
        async claim(record) {
          const claimed = await db.stepLedger.claim(record);
          if (record.stepId === shortId) shortClaimed.resolve();
          return claimed;
        },
        async get(stageId, stepId) {
          // The first execution suspends only after the short wait exists.
          if (stepId === "long") await shortClaimed.promise;
          return db.stepLedger.get(stageId, stepId);
        },
      });
      const t = await start(
        async (step) => {
          const [, short] = await Promise.all([
            step.waitForSignal("long", { timeout: "2h", keepalive: "1h" }),
            (async () => {
              await step.waitForSignal("pre", { timeout: "2h" });
              // Unstepped work between two waits (a fetch, a digest).
              if (delayContinuation) await continuation.promise;
              return step.waitForSignal<string>(shortId, {
                timeout: 100,
                onTimeout: "return",
                ...(keepalive ? { keepalive } : {}),
              });
            })(),
            step.waitForSignal("nudge", { timeout: "2h", keepalive: "1h" }),
          ]);
          return short.timedOut ? "timeout" : short.value;
        },
        { stepLedger },
      );
      const worker = t.worker({ stepLedger });
      const started = clock.now().getTime();
      await t.signal(worker, true, "pre");
      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      const deadline = new Date(started + 100);
      expect(await t.getStage()).toMatchObject({
        nextPollAt: new Date(started + due),
        maxWaitUntil: deadline,
      });

      delayContinuation = true;
      try {
        clock.set(new Date(started + 20));
        await t.signal(worker, true, "nudge");
        await t.tick(worker, "second");
        expect(await t.record(shortId)).toMatchObject({
          status: "pending",
          deadlineAt: deadline,
        });
        expect(await t.getStage()).toMatchObject({
          status: "SUSPENDED",
          nextPollAt: new Date(started + due),
          maxWaitUntil: deadline,
        });
        if (keepalive) {
          clock.set(new Date(started + keepalive));
          await t.tick(worker, "second");
          expect(await t.getStage()).toMatchObject({
            nextPollAt: deadline,
            maxWaitUntil: deadline,
          });
        }

        clock.set(deadline);
        await t.tick(worker, "second");
        expect(await t.record(shortId)).toMatchObject({
          status: "completed",
          waitState: { timedOut: true },
        });
        await expect(
          t.signal(t.worker(), "accepted", shortId),
        ).resolves.toEqual({
          ok: true,
          signalled: false,
          alreadyCompleted: true,
          timedOut: true,
        });
      } finally {
        continuation.resolve();
      }
      await t.signal(worker, true, "long");
      await t.tick(worker, "second");
      expect(await t.status()).toBe("COMPLETED");
      const { _artifactKey } = (await t.getStage())?.outputData as {
        _artifactKey: string;
      };
      expect(await db.blobStore.get(_artifactKey)).toEqual({
        branch: "timeout",
      });
      expect(
        events.getByType("step:signalled").map((event) => event.stepId),
      ).toEqual(["pre", "nudge", "long"]);
    });

    it.each([
      "stops",
      "throws",
    ] as const)("keeps the next deadline when a replay %s after settling an earlier one", async (failure) => {
      const stopped = barrier();
      let executions = 0;
      const t = await start(async (step) => {
        executions++;
        if (executions === 2) {
          if (failure === "stops") await stopped.pause();
          else throw new Error("transient failure");
        }
        const [first, second] = await Promise.all([
          step.waitForSignal("first", { timeout: 100, onTimeout: "return" }),
          step.waitForSignal("second", { timeout: 130, onTimeout: "return" }),
          step.waitForSignal("long", { timeout: "2h", keepalive: "1h" }),
        ]);
        return `${first.timedOut}/${second.timedOut}`;
      });
      const started = clock.now().getTime();
      await t.execute();
      expect((await t.getStage())?.nextPollAt).toEqual(new Date(started + 100));

      clock.set(new Date(started + 100));
      const firstTick = t.tick();
      try {
        await Promise.race([stopped.reached, firstTick]);
        expect(await t.record("first")).toMatchObject({
          status: "completed",
          waitState: { timedOut: true },
        });
        expect((await t.getStage())?.nextPollAt).toEqual(
          new Date(started + 130),
        );
        clock.set(new Date(started + 130));
        const worker = t.worker();
        await t.tick(worker, "second");
        expect(await t.record("second")).toMatchObject({
          status: "completed",
          waitState: { timedOut: true },
        });
      } finally {
        stopped.release();
        await firstTick;
      }
      await t.signal(t.worker(), null, "long");
      await t.tick(t.worker(), "second");
      expect(await t.status()).toBe("COMPLETED");
      const { _artifactKey } = (await t.getStage())?.outputData as {
        _artifactKey: string;
      };
      expect(await db.blobStore.get(_artifactKey)).toEqual({
        branch: "true/true",
      });
    });

    it("starts a parallel branch's next wait on replay after an outstanding poll finishes", async () => {
      const checking = barrier();
      const branchFinished = Promise.withResolvers<void>();
      const t = await start(async (step) => {
        await Promise.all([
          step.waitForSignal("long", { timeout: "2h", keepalive: "1h" }),
          (async () => {
            try {
              await step.waitFor("ready", {
                every: "5m",
                timeout: "1h",
                onTimeout: "throw",
                async poll() {
                  await checking.pause();
                  return true;
                },
                ready: (value) => value,
              });
              await step.waitForSignal("approval", {
                onTimeout: "return",
                timeout: 100,
              });
            } finally {
              branchFinished.resolve();
            }
          })(),
        ]);
        return "finished";
      });

      const execution = t.execute();
      try {
        await checking.reached;
        await expect(execution).resolves.toMatchObject({
          outcome: "suspended",
        });
      } finally {
        checking.release();
        await execution;
      }
      await branchFinished.promise;
      expect(await t.record("approval")).toBeNull();

      clock.advance(5 * 60_000);
      const worker = t.worker();
      await t.tick(worker, "second");
      const deadline = new Date(clock.now().getTime() + 100);
      expect(await t.getStage()).toMatchObject({
        nextPollAt: deadline,
        maxWaitUntil: deadline,
      });
      clock.advance(100);
      await t.tick(worker, "second");
      expect(await t.record("approval")).toMatchObject({
        status: "completed",
        waitState: { timedOut: true },
      });
    });

    it.each([
      "existing wait",
      "concurrent claim",
    ] as const)("records a timeout when a signal finds an overdue %s before the next tick", async (path) => {
      const t = await start(async (step) => {
        const approval = await step.waitForSignal<string>("approval", {
          timeout: 100,
          onTimeout: "return",
        });
        return approval.timedOut ? "expired" : approval.value;
      });
      const missed = barrier();
      const worker = t.worker(
        path === "concurrent claim"
          ? {
              stepLedger: override(db.stepLedger, {
                async get(stageId, stepId) {
                  const record = await db.stepLedger.get(stageId, stepId);
                  if (!record) await missed.pause();
                  return record;
                },
              }),
            }
          : {},
      );
      const late =
        path === "concurrent claim"
          ? t.signal(worker, "late", "approval")
          : undefined;
      try {
        if (late) await Promise.race([missed.reached, late]);
        await expect(t.execute()).resolves.toMatchObject({
          outcome: "suspended",
        });
        clock.advance(101);
      } finally {
        missed.release();
      }
      await expect(
        late ?? t.signal(worker, "late", "approval"),
      ).resolves.toMatchObject({
        signalled: false,
        alreadyCompleted: true,
        timedOut: true,
      });
      expect(await t.record("approval")).toMatchObject({
        status: "completed",
        waitState: { timedOut: true },
      });
      await t.tick(worker, "second");
      expect(await t.status()).toBe("COMPLETED");
      const { _artifactKey } = (await t.getStage())?.outputData as {
        _artifactKey: string;
      };
      expect(await db.blobStore.get(_artifactKey)).toEqual({
        branch: "expired",
      });
      expect(events.getByType("step:signalled")).toEqual([]);
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
      { first: "signal", at: 99 },
      { first: "signal", at: 100 },
      { first: "deadline", at: 100 },
    ] as const)("settles a signal at +$at ms with the $first write first between two workers", async ({
      first,
      at,
    }) => {
      const winner = first;
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
      clock.advance(at);

      const signal = () => t.signal(delivery, "accepted");
      const loser = winner === "signal" ? t.tick() : signal();
      try {
        await Promise.race([losingWrite.reached, loser]);
        if (winner === "signal") {
          // From the deadline on, the signal itself records the timeout.
          await expect(signal()).resolves.toMatchObject(
            at < 100
              ? { signalled: true }
              : { signalled: false, timedOut: true },
          );
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
        at < 100 ? { timedOut: false, value: "accepted" } : timeoutResult;
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen).toEqual(seen.map(() => outcome));
      const answers = events
        .getByType("step:signalled")
        .filter((event) => event.stepId === "answer");
      expect(answers).toHaveLength(at < 100 ? 1 : 0);
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
      "ready after the deadline",
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
                  return path === "ready after the deadline";
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
      expect(polls).toBe(path === "signal" || path === "poll" ? 0 : 1);
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

    const refusal = {
      ok: true,
      signalled: false,
      alreadyCompleted: true,
      timedOut: true,
    };

    it.each([
      { onTimeout: undefined, status: "FAILED" },
      { onTimeout: "throw", status: "FAILED" },
      { onTimeout: "return", status: "COMPLETED" },
    ] as const)("answers a late signal the same before and after the poller settles the timeout (onTimeout $onTimeout)", async ({
      onTimeout,
      status,
    }) => {
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
      // Without onTimeout a signal before the poller's tick is still accepted.
      if (onTimeout) {
        await expect(t.signal(t.worker(), "late")).resolves.toMatchObject(
          refusal,
        );
      }
      await t.tick();
      expect(await t.status()).toBe(status);
      expect(await t.record()).toMatchObject(
        onTimeout === "return"
          ? { status: "completed", waitState: { timedOut: true } }
          : {
              status: "failed",
              error: 'Durable wait step "answer" exceeded its timeout',
            },
      );
      expect(continued).toBe(onTimeout === "return");
      const late = t.signal(t.worker(), "late");
      if (onTimeout) await expect(late).resolves.toMatchObject(refusal);
      else await expect(late).rejects.toThrow("has failed");
      expect(events.getByType("step:signalled")).toEqual([]);
      expect(
        (await db.persistence.getUnpublishedOutboxEvents(100)).filter(
          (event) => event.eventType === "step:signalled",
        ),
      ).toEqual([]);
    });

    it.each([
      undefined,
      "throw",
    ] as const)("answers a signal that loses to the poller's timeout (onTimeout %s)", async (onTimeout) => {
      const t = await start(async (step) => {
        await step.waitForSignal("answer", { onTimeout, timeout: 100 });
        return "answered";
      });
      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      const writing = barrier();
      const signaller = t.worker({
        stepLedger: override(db.stepLedger, {
          async compareAndSet(...args) {
            if (args[3].status === "completed") await writing.pause();
            return db.stepLedger.compareAndSet(...args);
          },
        }),
      });
      clock.advance(99);
      const late = t.signal(signaller, "late");
      await writing.reached;
      clock.advance(1);
      await t.tick(t.worker(), "second");
      expect(await t.record()).toMatchObject({ status: "failed" });
      writing.release();
      if (onTimeout) await expect(late).resolves.toMatchObject(refusal);
      else await expect(late).rejects.toThrow("has failed");
      expect(await t.status()).toBe("FAILED");
    });

    it.each([
      "before its write registers",
      "while its write is registered",
    ] as const)("writes nothing for a run cancelled and erased while a poll times out its wait %s", async (pause) => {
      const t = await start(async (step) => {
        const answer = await step.waitForSignal<string>("answer", {
          onTimeout: "return",
          timeout: 100,
        });
        return answer.timedOut ? "timeout" : answer.value;
      });
      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      const { workflowRunId } = (await t.getStage())!;
      clock.advance(100);

      // The poll's first run write is the timeout of the expired wait.
      const gate = barrier();
      let paused = false;
      const once = async () => {
        if (paused) return;
        paused = true;
        await gate.pause();
      };
      const poller = t.worker(
        pause === "before its write registers"
          ? {
              persistence: override(db.persistence, {
                beginRunWrite: async (...args) => {
                  await once();
                  return db.persistence.beginRunWrite!(...args);
                },
              }),
            }
          : {
              stepLedger: override(db.stepLedger, {
                compareAndSet: async (...args) => {
                  await once();
                  return db.stepLedger.compareAndSet(...args);
                },
              }),
            },
      );
      const polling = poller.dispatch({ type: "stage.pollSuspended" });
      await gate.reached;

      // Installations add erasure's indexes with the attribution columns.
      const ddl = await readFile(
        new URL(
          `../../sql/retention-indexes.${sqlite ? "sqlite" : "postgresql"}.sql`,
          import.meta.url,
        ),
        "utf8",
      );
      for (const statement of ddl.split(";").filter((sql) => sql.trim())) {
        await db.client.$executeRawUnsafe(statement);
      }
      const admin = t.worker({ services: { aiLogger: db.aiLogger } });
      const erase = {
        type: "run.purge",
        workflowRunIds: [workflowRunId],
      } as const;
      try {
        await admin.dispatch({ type: "run.cancel", workflowRunId });
        // A registered write holds the erasure until it ends.
        await expect(admin.dispatch(erase)).resolves.toMatchObject(
          pause === "before its write registers"
            ? { removed: { runs: 1 }, incomplete: [] }
            : {
                removed: { runs: 0 },
                incomplete: [{ workflowRunId, failed: ["writers"] }],
              },
        );
      } finally {
        gate.release();
        await polling;
      }
      if (pause === "while its write is registered") {
        await expect(admin.dispatch(erase)).resolves.toMatchObject({
          removed: { runs: 1 },
          incomplete: [],
        });
      }

      // Nothing the poll did after the erasure left a row behind.
      const counts = await Promise.all([
        db.client.workflowRun.count(),
        db.client.workflowStage.count(),
        db.client.workflowStep.count(),
        db.client.workflowBlob.count(),
        db.client.jobQueue.count(),
        db.client.outboxEvent.count(),
        db.client.idempotencyKey.count(),
      ]);
      expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(events.getByType("step:signalled")).toEqual([]);
    });

    async function storedOutput(t: { getStage: () => Promise<any> }) {
      const { _artifactKey } = (await t.getStage())?.outputData as {
        _artifactKey: string;
      };
      return ((await db.blobStore.get(_artifactKey)) as { branch: string })
        .branch;
    }

    it.each([
      { mode: "return", kick: false },
      // Without `onTimeout` the poll does not schedule the stage: another
      // signal wakes it at +30.
      { mode: undefined, kick: true },
    ] as const)("runs a due poll at the replay that reaches it after a sibling suspended (onTimeout $mode)", async ({
      mode,
      kick,
    }) => {
      let started = 0;
      const polledAt: number[] = [];
      let readyNow = false;
      let hold: ReturnType<typeof barrier> | undefined;
      let branch: Promise<unknown> = Promise.resolve();
      const t = await start(async (step) => {
        const short = (async () => {
          await step.waitForSignal("pre", { timeout: "2h" });
          // Unstepped work that ends after the sibling suspended the stage.
          await hold?.pause();
          return step.waitFor("short", {
            every: 30,
            timeout: 100,
            ...(mode ? { onTimeout: mode } : {}),
            async poll() {
              polledAt.push(clock.now().getTime() - started);
              return readyNow;
            },
            ready: (value: boolean) => value,
          });
        })();
        branch = short.catch(() => {});
        const [, answer] = await Promise.all([
          step.waitForSignal("long", { timeout: "2h", keepalive: "1h" }),
          short,
          ...(kick
            ? [step.waitForSignal("kick", { timeout: "2h", keepalive: "1h" })]
            : []),
        ]);
        return outcome(answer);
      });
      const worker = t.worker();
      started = clock.now().getTime();
      await t.signal(worker, true, "pre");
      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      expect(polledAt).toEqual([0]);

      readyNow = true;
      hold = barrier();
      clock.set(new Date(started + 30));
      if (kick) await t.signal(worker, true, "kick");
      await t.tick(worker, "second");
      await hold.reached;
      hold.release();
      await branch;
      hold = undefined;
      expect(polledAt).toEqual([0, 30]);
      expect(await t.record("short")).toMatchObject({
        status: "completed",
        result: true,
      });

      await t.signal(worker, true, "long");
      await t.tick(worker, "second");
      expect(await t.status()).toBe("COMPLETED");
      expect(await storedOutput(t)).toBe("true");
    });

    it.each([
      {
        mode: undefined,
        firstPoll: 3_600_000,
        shortAfterTick: "pending",
        late: { ok: true, signalled: true, alreadyCompleted: false },
        stored: "accepted",
      },
      {
        mode: "return",
        firstPoll: 100,
        shortAfterTick: "completed",
        late: {
          ok: true,
          signalled: false,
          alreadyCompleted: true,
          timedOut: true,
        },
        stored: "timeout",
      },
    ] as const)("schedules parallel signals with onTimeout $mode when the longer wait suspends first", async ({
      mode,
      firstPoll,
      shortAfterTick,
      late,
      stored,
    }) => {
      const longClaimed = Promise.withResolvers<void>();
      const t = await start(
        async (step) => {
          const [, short] = await Promise.all([
            step.waitForSignal("long", { timeout: "2h", keepalive: "1h" }),
            step.waitForSignal<string>("short", {
              timeout: 100,
              ...(mode ? { onTimeout: mode } : {}),
            }),
          ]);
          return outcome(short);
        },
        {
          stepLedger: override(db.stepLedger, {
            async claim(record) {
              if (record.stepId === "short") await longClaimed.promise;
              const claimed = await db.stepLedger.claim(record);
              if (record.stepId === "long") longClaimed.resolve();
              return claimed;
            },
          }),
        },
      );
      const started = clock.now().getTime();
      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      expect((await t.getStage())?.nextPollAt).toEqual(
        new Date(started + firstPoll),
      );
      expect(await t.record("short")).toMatchObject({
        status: "pending",
        deadlineAt: new Date(started + 100),
      });

      const worker = t.worker();
      clock.set(new Date(started + 100));
      await t.tick(worker, "second");
      expect((await t.record("short"))?.status).toBe(shortAfterTick);
      clock.set(new Date(started + 101));
      await expect(t.signal(worker, "accepted", "short")).resolves.toEqual(
        late,
      );
      await t.signal(worker, true, "long");
      await t.tick(worker, "second");
      expect(await t.status()).toBe("COMPLETED");
      expect(await storedOutput(t)).toBe(stored);
    });

    it.each([
      { mode: "return", verdict: true, stored: "timeout" },
      { mode: "throw", verdict: true, stored: "caught timeout" },
      { mode: undefined, verdict: false, stored: "caught timeout" },
      { mode: undefined, verdict: true, stored: "ready" },
    ] as const)("decides with the clock after the ready check when it crosses the deadline (onTimeout $mode, verdict $verdict)", async ({
      mode,
      verdict,
      stored,
    }) => {
      let deadline = 0;
      const t = await start(async (step) => {
        try {
          const answer = await step.waitFor("check", {
            every: 30,
            timeout: 100,
            ...(mode ? { onTimeout: mode } : {}),
            poll: async () => "ready",
            ready: () => {
              // The verdict takes until the deadline.
              clock.set(new Date(deadline));
              return verdict;
            },
          });
          return outcome(answer);
        } catch (error) {
          if (error instanceof StepTimeoutError) return "caught timeout";
          throw error;
        }
      });
      deadline = clock.now().getTime() + 100;
      await t.execute();
      expect(await t.status()).toBe("COMPLETED");
      expect(await storedOutput(t)).toBe(stored);
    });

    it("replays within the claim lease when a worker dies after opening a wait", async () => {
      const entered = barrier();
      let dies = true;
      const t = await start(async (step) => {
        await step.waitForSignal("pre", { timeout: "2h", keepalive: "1h" });
        const check = await step.waitFor("check", {
          every: 30,
          timeout: 100,
          onTimeout: "return",
          async poll() {
            // Held until the survivor has finished: this worker is gone.
            if (dies) await entered.pause();
            return true;
          },
          ready: (value: boolean) => value,
        });
        return check.timedOut ? "timeout" : "ready";
      });
      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      const started = clock.now().getTime();
      const survivor = t.worker();
      await t.signal(survivor, true, "pre");
      const lost = t.tick(t.worker(), "lost").catch(() => {});
      await entered.reached;
      dies = false;
      expect(await t.record("check")).toMatchObject({
        status: "pending",
        deadlineAt: new Date(started + 100),
      });
      expect((await t.getStage())?.nextPollAt).toEqual(
        new Date(started + 60_000),
      );

      clock.set(new Date(started + 100));
      await t.tick(survivor, "survivor");
      expect((await t.record("check"))?.status).toBe("pending");
      clock.set(new Date(started + 60_000));
      await t.tick(survivor, "survivor");
      expect(await t.status()).toBe("COMPLETED");
      expect(await storedOutput(t)).toBe("timeout");
      // The lost worker's late writes change nothing.
      entered.release();
      await lost;
      expect(await t.status()).toBe("COMPLETED");
      expect(await storedOutput(t)).toBe("timeout");
    });

    it.each([
      undefined,
      "return",
    ] as const)("reads no stored step result while suspending (onTimeout %s)", async (mode) => {
      let suspending = false;
      let reads = 0;
      const blobStore = override(db.blobStore, {
        async get(key: string) {
          if (suspending) reads++;
          return db.blobStore.get(key);
        },
      });
      const t = await start(
        async (step) => {
          for (let i = 0; i < 12; i++) {
            await step.run(`payload-${i}`, async () => "x".repeat(70_000));
          }
          suspending = true;
          await step.waitForSignal("answer", {
            timeout: "1h",
            ...(mode ? { onTimeout: mode } : {}),
          });
          return "done";
        },
        { blobStore },
      );
      await expect(t.execute()).resolves.toMatchObject({
        outcome: "suspended",
      });
      expect(await db.client.workflowBlob.count()).toBeGreaterThanOrEqual(12);
      expect(reads).toBe(0);
    });
  },
);
