/**
 * Retry classification through the real entry points: `kernel.dispatch` of
 * `job.execute` and `stage.pollSuspended`, on the in-memory ports and, when
 * `SQLITE8_KERNEL_SQLITE=1` or `DATABASE_URL` is set, on the Prisma adapters
 * (the failure verdict travels in a step row's JSON `result`, and the
 * `checkCompletion` retry write is fenced by the stage version).
 *
 * One rule: the same throw gets the same verdict and the same text whether
 * `job.execute` meets it directly or a poll meets it after a round trip
 * through the step ledger.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { z as zodMini } from "zod/mini";
import { z as zodV3 } from "zod/v3";
import { defineAsyncBatchStage, defineStage } from "../core/stage-factory.js";
import { deriveStepExternalKey } from "../core/step-external-key.js";
import { NonRetryableError, type StepRunOptions } from "../core/steps.js";
import { type Workflow, WorkflowBuilder } from "../core/workflow.js";
import { createKernel, type KernelConfig } from "../kernel/kernel.js";
import type { JobTransport, StepLedger } from "../kernel/ports.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
} from "../kernel/testing/index.js";
import type { WorkflowPersistence } from "../persistence/interface.js";
import { InMemoryJobQueue } from "../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../testing/in-memory-persistence.js";
import { InMemoryStepLedger } from "../testing/in-memory-step-ledger.js";
import {
  type KernelDatabase,
  kernelDatabase,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";

interface Env {
  persistence: WorkflowPersistence;
  stepLedger: StepLedger;
  jobTransport: JobTransport;
  clock: FakeClock;
  kernel(workflow: Workflow<any, any>): ReturnType<typeof createKernel>;
}

const out = z.object({ ok: z.boolean() });
/** Long enough for a backoff, a 1s sleep or a 1s poll interval; short of a lease. */
const POLL_GAP_MS = 2 * 60_000;

function workflowOf(id: string, stage: any): Workflow<any, any> {
  return new WorkflowBuilder(id, id, "", z.object({}), out).pipe(stage).build();
}

/** A stage that runs one durable step and rethrows what it threw. */
function directStage(body: () => Promise<unknown>, opts: StepRunOptions = {}) {
  return defineStage({
    id: "s",
    name: "s",
    schemas: { input: z.object({}), output: out, config: z.object({}) },
    async execute(ctx) {
      await ctx.step.run("call", body, opts);
      return { output: { ok: true } };
    },
  });
}

/**
 * A stage that catches its step's failure, suspends on a sleep and rethrows
 * the failure on the replay: the error the poll meets is the one the ledger
 * row gives back, not the one the body threw.
 */
function storedStage(body: () => Promise<unknown>, opts: StepRunOptions = {}) {
  return defineStage({
    id: "s",
    name: "s",
    schemas: { input: z.object({}), output: out, config: z.object({}) },
    async execute(ctx) {
      let caught: unknown;
      try {
        await ctx.step.run("call", body, opts);
      } catch (error) {
        caught = error;
      }
      await ctx.step.sleep("nap", 1000);
      if (caught) throw caught;
      return { output: { ok: true } };
    },
  });
}

async function start(env: Env, workflow: Workflow<any, any>) {
  const kernel = env.kernel(workflow);
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: crypto.randomUUID(),
    workflowId: workflow.id,
    input: {},
  });
  await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
  const execute = (attempt?: number) =>
    kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: workflow.id,
      stageId: "s",
      config: {},
      ...(attempt !== undefined ? { attempt, maxAttempts: 3 } : {}),
    });
  const poll = async () => {
    env.clock.advance(POLL_GAP_MS);
    return kernel.dispatch({ type: "stage.pollSuspended" });
  };
  const stage = async () =>
    (await env.persistence.getStage(workflowRunId, "s"))!;
  const retryEvents = async () =>
    (await env.persistence.getUnpublishedOutboxEvents(1000)).filter(
      (e) =>
        e.workflowRunId === workflowRunId && e.eventType === "stage:retrying",
    ).length;
  return { kernel, workflowRunId, execute, poll, stage, retryEvents };
}

/** Fails the first `n` calls with `make()`, then succeeds. */
function failing(n: number, make: () => unknown) {
  const body = async () => {
    body.calls++;
    if (body.calls <= n) throw make();
    return "done";
  };
  body.calls = 0;
  return body;
}

class QuotaError extends Error {
  constructor(message = "over quota") {
    super(message);
    this.name = "QuotaError";
  }
}

const zodParse = () => z.number().parse("x");
const zodV3Parse = () => zodV3.number().parse("x");
const zodMiniParse = () => zodMini.parse(zodMini.number(), "x");

/** [case, make error, step options, retryable, expected text]. */
const verdictCases: Array<
  [string, () => unknown, StepRunOptions, boolean, string | RegExp]
> = [
  [
    "an ordinary named error",
    () => new QuotaError(),
    {},
    true,
    "QuotaError: over quota",
  ],
  [
    "a NonRetryableError",
    () => new NonRetryableError("card revoked"),
    {},
    false,
    "NonRetryableError: card revoked",
  ],
  ["a Zod error", zodParse, {}, false, /^ZodError: /],
  ["a zod/v3 error", zodV3Parse, {}, false, /^ZodError: /],
  ["a zod/mini error", zodMiniParse, {}, false, /^\$ZodError: /],
  [
    "retryIf false",
    () => new QuotaError(),
    { retryIf: () => false },
    false,
    "NonRetryableError: over quota",
  ],
  [
    "a throwing retryIf",
    () => new QuotaError(),
    {
      retryIf: () => {
        throw new Error("bug");
      },
    },
    true,
    "QuotaError: over quota",
  ],
  [
    "retryIf 0",
    () => new QuotaError(),
    { retryIf: () => 0 as unknown as boolean },
    true,
    "QuotaError: over quota",
  ],
  [
    "retryIf undefined",
    () => new QuotaError(),
    { retryIf: () => undefined as unknown as boolean },
    true,
    "QuotaError: over quota",
  ],
];

function suite(name: string, makeEnv: () => Promise<Env>) {
  describe(name, () => {
    let env: Env;
    beforeEach(async () => {
      env = await makeEnv();
    });

    describe.each(verdictCases)("%s", (_case, make, opts, retryable, text) => {
      it("gets the same verdict and text from job.execute directly", async () => {
        const body = failing(1, make);
        const run = await start(
          env,
          workflowOf("direct", directStage(body, opts)),
        );
        const result = await run.execute(1);
        expect(result).toMatchObject({
          outcome: "failed",
          willRetry: retryable,
        });
        expect((result as { error: string }).error).toMatch(text);
        expect(await run.stage()).toMatchObject({
          status: retryable ? "PENDING" : "FAILED",
        });
        expect(body.calls).toBe(1);
      });

      it("gets the same verdict and text from a poll after a ledger round trip", async () => {
        const body = failing(1, make);
        const run = await start(
          env,
          workflowOf("stored", storedStage(body, opts)),
        );
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        const polled = await run.poll();
        const stage = await run.stage();
        expect(stage.status).toBe(retryable ? "SUSPENDED" : "FAILED");
        expect(stage.errorMessage).toMatch(text);
        expect(polled.failed).toBe(retryable ? 0 : 1);
        expect(await run.retryEvents()).toBe(retryable ? 1 : 0);
        expect(body.calls).toBe(1);
        if (!retryable) return;
        // The retry re-opens the step, and the next replay runs it again.
        await run.poll();
        expect(await run.stage()).toMatchObject({
          status: "COMPLETED",
          errorMessage: null,
        });
        expect(body.calls).toBe(2);
      });
    });

    describe.each([
      [
        "a timeout-looking message",
        'Durable wait step "call" exceeded its timeout',
      ],
      [
        "a verdict-looking prefix",
        "NonRetryableError: temporary upstream outage",
      ],
      ["an empty message", ""],
    ])("an ordinary error with %s", (_case, message) => {
      it("is retried by the job and the step runs again", async () => {
        const body = failing(1, () => new Error(message));
        const run = await start(env, workflowOf("job-text", directStage(body)));
        expect(await run.execute(1)).toMatchObject({ willRetry: true });
        expect(await run.execute(2)).toMatchObject({ outcome: "completed" });
        expect(body.calls).toBe(2);
      });

      it("stays ordinary through the ledger and recovers on the poll retry", async () => {
        const body = failing(1, () => new Error(message));
        const run = await start(
          env,
          workflowOf("poll-text", storedStage(body)),
        );
        await run.execute(1);
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "SUSPENDED" });
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "COMPLETED" });
        expect(body.calls).toBe(2);
      });
    });

    describe('a known thrown failure under onReclaim: "fail"', () => {
      const opts: StepRunOptions = { onReclaim: "fail" };

      it("is re-run by a job retry, not refused as a dead worker", async () => {
        const body = failing(1, () => new QuotaError());
        const run = await start(
          env,
          workflowOf("r8-job", directStage(body, opts)),
        );
        expect(await run.execute(1)).toMatchObject({ willRetry: true });
        expect(await run.execute(2)).toMatchObject({ outcome: "completed" });
        expect(body.calls).toBe(2);
      });

      it("is re-run by a poll retry, not refused as a dead worker", async () => {
        const body = failing(1, () => new QuotaError());
        const run = await start(
          env,
          workflowOf("r8-poll", storedStage(body, opts)),
        );
        await run.execute(1);
        await run.poll();
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "COMPLETED" });
        expect(body.calls).toBe(2);
      });
    });

    it("keeps refusing a dead worker's step after a stage restart re-opens it", async () => {
      const body = failing(0, () => undefined);
      let seeded = false;
      const stage = defineStage({
        id: "s",
        name: "s",
        schemas: { input: z.object({}), output: out, config: z.object({}) },
        async execute(ctx) {
          const stageRecordId = ctx.stageRecordId!;
          if (!seeded) {
            seeded = true;
            // What a worker that died inside the body leaves behind.
            await env.stepLedger.claim({
              stageRecordId,
              stepId: "call",
              seq: 1,
              kind: "run",
              status: "running",
              attempt: 1,
              leaseExpiresAt: new Date(env.clock.now().getTime() - 1000),
              deadlineAt: null,
              externalKey: deriveStepExternalKey(stageRecordId, "call"),
            });
          }
          await ctx.step.run("call", body, { onReclaim: "fail" });
          return { output: { ok: true } };
        },
      });
      const run = await start(env, workflowOf("t1", stage));
      const first = await run.execute(1);
      expect(first).toMatchObject({ outcome: "failed", willRetry: false });
      expect((first as { error: string }).error).toMatch(
        /^StepNotReplaySafeError: /,
      );
      // A fresh execution of the FAILED stage re-opens the row, which names
      // an external effect. Its outcome is still unknown, so it is refused.
      const second = await run.execute(1);
      expect(second).toMatchObject({ outcome: "failed", willRetry: false });
      expect((second as { error: string }).error).toMatch(
        /^StepNotReplaySafeError: /,
      );
      expect(body.calls).toBe(0);
    });

    describe("a step's own retries", () => {
      it("retry every error but NonRetryableError, a Zod error included", async () => {
        const body = failing(9, zodParse);
        const run = await start(
          env,
          workflowOf("zod-retries", directStage(body, { retries: 2 })),
        );
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        await run.poll();
        await run.poll();
        expect(body.calls).toBe(3);
        // Once the step gives up, the stage classifier has the last word.
        expect(await run.stage()).toMatchObject({ status: "FAILED" });
        expect((await run.stage()).errorMessage).toMatch(/^ZodError: /);
      });

      it("stop at a NonRetryableError", async () => {
        const body = failing(9, () => new NonRetryableError("revoked"));
        const run = await start(
          env,
          workflowOf("nre-retries", directStage(body, { retries: 3 })),
        );
        expect(await run.execute(1)).toMatchObject({ willRetry: false });
        expect(body.calls).toBe(1);
      });

      it("stop when retryIf says no, and retryIf sees the error and attempt", async () => {
        const seen: Array<[unknown, number]> = [];
        const body = failing(9, () => new QuotaError());
        const run = await start(
          env,
          workflowOf(
            "retryif-retries",
            directStage(body, {
              retries: 3,
              retryIf: (error, { attempt }) => {
                seen.push([error, attempt]);
                return attempt < 2;
              },
            }),
          ),
        );
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        await run.poll();
        expect(body.calls).toBe(2);
        expect(seen.map(([e, a]) => [(e as Error).name, a])).toEqual([
          ["QuotaError", 1],
          ["QuotaError", 2],
        ]);
        expect(await run.stage()).toMatchObject({
          status: "FAILED",
          errorMessage: "NonRetryableError: over quota",
        });
      });
    });

    describe("a throwing checkCompletion", () => {
      function pollingStage(
        check: () => Promise<unknown>,
        onResume?: () => unknown,
      ) {
        return defineAsyncBatchStage({
          id: "s",
          name: "s",
          mode: "async-batch",
          schemas: { input: z.object({}), output: out, config: z.object({}) },
          async execute(ctx) {
            if (ctx.resumeState && onResume) {
              return { output: onResume() as { ok: boolean } };
            }
            return {
              suspended: true,
              state: { batchId: "b" },
              pollConfig: {
                pollInterval: 1000,
                maxWaitTime: 24 * 3_600_000,
                nextPollAt: new Date(env.clock.now().getTime() + 1000),
              },
            };
          },
          async checkCompletion() {
            return (await check()) as never;
          },
        });
      }
      function script(
        ...steps: Array<"throw" | "wait" | "ready" | (() => unknown)>
      ) {
        const check = async () => {
          const step = steps[check.calls++] ?? steps[steps.length - 1]!;
          if (step === "throw") throw new QuotaError("provider 503");
          if (step === "wait") return { ready: false };
          if (step === "ready") return { ready: true, output: { ok: true } };
          throw step();
        };
        check.calls = 0;
        return check;
      }

      it("is retried within the attempt budget and completes", async () => {
        const run = await start(
          env,
          workflowOf("cc-ok", pollingStage(script("throw", "ready"))),
        );
        await run.execute(1);
        expect(await run.poll()).toMatchObject({ failed: 0, resumed: 0 });
        const retried = await run.stage();
        expect(retried).toMatchObject({
          status: "SUSPENDED",
          errorMessage: "QuotaError: provider 503",
        });
        expect(await run.retryEvents()).toBe(1);
        expect(await run.poll()).toMatchObject({ resumed: 1 });
        expect(await run.stage()).toMatchObject({
          status: "COMPLETED",
          errorMessage: null,
        });
      });

      it("fails the stage once the budget is spent", async () => {
        const check = script("throw");
        const run = await start(
          env,
          workflowOf("cc-spent", pollingStage(check)),
        );
        await run.execute(1);
        expect((await run.poll()).failed).toBe(0);
        expect((await run.poll()).failed).toBe(0);
        expect((await run.poll()).failed).toBe(1);
        expect(check.calls).toBe(3);
        expect(await run.stage()).toMatchObject({
          status: "FAILED",
          errorMessage: "QuotaError: provider 503",
        });
      });

      it.each([
        ["a NonRetryableError", () => new NonRetryableError("bad batch")],
        ["a Zod error from another copy of zod", zodV3Parse],
      ])("fails at once on %s", async (_case, make) => {
        const run = await start(
          env,
          workflowOf("cc-final", pollingStage(script(make))),
        );
        await run.execute(1);
        expect((await run.poll()).failed).toBe(1);
        expect(await run.stage()).toMatchObject({ status: "FAILED" });
        expect(await run.retryEvents()).toBe(0);
      });

      it("counts only consecutive throws: a clean answer ends the streak", async () => {
        const check = script(
          "throw",
          "throw",
          "wait",
          "throw",
          "throw",
          "ready",
        );
        const run = await start(
          env,
          workflowOf("cc-streak", pollingStage(check)),
        );
        await run.execute(1);
        await run.poll();
        await run.poll();
        await run.poll();
        expect(await run.stage()).toMatchObject({
          status: "SUSPENDED",
          errorMessage: null,
        });
        await run.poll();
        await run.poll();
        expect((await run.poll()).resumed).toBe(1);
        expect(await run.stage()).toMatchObject({ status: "COMPLETED" });
      });

      it("does not write its retry onto a stage a job completed meanwhile", async () => {
        let release!: () => void;
        let entered!: () => void;
        const inCheck = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const check = async () => {
          entered();
          await gate;
          throw new QuotaError("stale poll");
        };
        const run = await start(
          env,
          workflowOf(
            "cc-fence",
            pollingStage(check, () => ({ ok: true })),
          ),
        );
        await run.execute(1);
        const before = await run.stage();
        env.clock.advance(POLL_GAP_MS);
        const polling = run.kernel.dispatch({ type: "stage.pollSuspended" });
        await inCheck;
        // A redelivered job resumes and completes the stage.
        expect(await run.execute()).toMatchObject({ outcome: "completed" });
        release();
        expect(await polling).toMatchObject({ failed: 0, resumed: 0 });
        expect(await run.stage()).toMatchObject({
          status: "COMPLETED",
          attempt: before.attempt,
          errorMessage: null,
        });
        expect(await run.retryEvents()).toBe(0);
      });
    });
  });
}

suite("retry classification on memory", async () => {
  const clock = new FakeClock(new Date());
  const persistence = new InMemoryWorkflowPersistence();
  const jobTransport = new InMemoryJobQueue("w");
  const stepLedger = new InMemoryStepLedger();
  const blobStore = new InMemoryBlobStore();
  return {
    persistence,
    stepLedger,
    jobTransport,
    clock,
    kernel: (workflow) =>
      createKernel({
        persistence,
        jobTransport,
        stepLedger,
        blobStore,
        clock,
        eventSink: new CollectingEventSink(),
        registry: {
          getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
        },
      } satisfies KernelConfig),
  };
});

describe.skipIf(!realDatabase)(
  `retry classification on ${sqlite ? "SQLite" : "Postgres"}`,
  () => {
    let db: KernelDatabase;
    beforeAll(async () => {
      db = await kernelDatabase();
    }, 120_000);
    afterAll(async () => {
      await db?.close();
    });
    suite("Prisma", async () => {
      await db.reset();
      const clock = new FakeClock(new Date());
      return {
        persistence: db.persistence,
        stepLedger: db.stepLedger,
        jobTransport: db.jobTransport,
        clock,
        kernel: (workflow) =>
          db.makeKernel({
            clock,
            registry: {
              getWorkflow: (id) => (id === workflow.id ? workflow : undefined),
            },
          }),
      };
    });
  },
);
