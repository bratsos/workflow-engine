/**
 * Retry classification through the real entry points: `kernel.dispatch` of
 * `job.execute` and `stage.pollSuspended`, on the in-memory ports and, when
 * `SQLITE8_KERNEL_SQLITE=1` or `DATABASE_URL` is set, on the Prisma adapters
 * (the failure verdict travels in a step row's JSON `result`).
 *
 * One rule: the same throw gets the same verdict, and the stage sees the
 * same name and brand, whether `job.execute` meets it directly or a poll
 * meets it after a round trip through the step ledger.
 */
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { z as zodMini } from "zod/mini";
import { z as zodV3 } from "zod/v3";
import { $ZodError } from "zod/v4/core";
import { defineAsyncBatchStage, defineStage } from "../core/stage-factory.js";
import { deriveStepExternalKey } from "../core/step-external-key.js";
import {
  isNonRetryableError,
  NonRetryableError,
  type StepRunOptions,
  StepTimeoutError,
} from "../core/steps.js";
import { type Workflow, WorkflowBuilder } from "../core/workflow.js";
import { executeJobWithHeartbeat } from "../kernel/helpers/host-support.js";
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
  const execute = (attempt?: number, maxAttempts = 3) =>
    kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: workflow.id,
      stageId: "s",
      config: {},
      ...(attempt !== undefined ? { attempt, maxAttempts } : {}),
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

/** A one-shot latch for ordering a schedule. */
function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

class QuotaError extends Error {
  constructor(message = "over quota") {
    super(message);
    this.name = "QuotaError";
  }
}

/**
 * What another copy of the engine throws: its own class, with the same
 * `Symbol.for` brand, which `instanceof` against this copy does not see.
 */
function fromAnotherEngineCopy(name: string) {
  const error = new Error("from another copy");
  error.name = name;
  Object.defineProperty(
    error,
    Symbol.for("@bratsos/workflow-engine/terminal-step-failure"),
    { value: true },
  );
  return error;
}

/** `target` with `key` turned into a getter that throws. */
function withThrowingGetter<T extends object>(target: T, key: PropertyKey): T {
  Object.defineProperty(target, key, {
    get() {
      throw new Error(`${String(key)} getter`);
    },
    configurable: true,
  });
  return target;
}

const brokenGetterCases: Array<[string, () => unknown]> = [
  ...["name", "message", "cause", "constructor", "issues", "stack"].map(
    (key): [string, () => unknown] => [
      key,
      () => withThrowingGetter(new Error("boom"), key),
    ],
  ),
  [
    "name (plain object)",
    () => withThrowingGetter({ message: "boom" }, "name"),
  ],
  [
    "issues (plain object)",
    () => withThrowingGetter({ name: "ZodError", message: "boom" }, "issues"),
  ],
];

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
    { retryIf: (): boolean => false },
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
    "an async retryIf resolving false (no verdict: it must be synchronous)",
    () => new QuotaError(),
    { retryIf: (async () => false) as unknown as () => boolean },
    true,
    "QuotaError: over quota",
  ],
  [
    "a retryIf that throws a value with no string form",
    () => new QuotaError(),
    {
      retryIf: () => {
        throw Object.create(null);
      },
    },
    true,
    "QuotaError: over quota",
  ],
  [
    "a retryIf property whose getter throws",
    () => new QuotaError(),
    Object.defineProperty({}, "retryIf", {
      get() {
        throw new Error("getter");
      },
    }) as StepRunOptions,
    true,
    "QuotaError: over quota",
  ],
  [
    "a rejecting async retryIf",
    () => new QuotaError(),
    {
      retryIf: (async () => {
        throw new Error("predicate rejected");
      }) as unknown as () => boolean,
    },
    true,
    "QuotaError: over quota",
  ],
  [
    "a Zod error decoded from JSON",
    () =>
      JSON.parse(
        JSON.stringify({
          name: "ZodError",
          message: "bad input",
          issues: [{ code: "custom", path: [], message: "bad input" }],
        }),
      ),
    {},
    false,
    "ZodError: bad input",
  ],
  [
    "a zod core $ZodError, which is not an Error",
    () =>
      new $ZodError([
        { code: "custom", path: [], message: "bad input", input: 1 },
      ] as never),
    {},
    false,
    /^\$ZodError: \[/,
  ],
  [
    "a StepTimeoutError from another engine copy",
    () => fromAnotherEngineCopy("StepTimeoutError"),
    {},
    false,
    "StepTimeoutError: from another copy",
  ],
  [
    "a StepNotReplaySafeError from another engine copy",
    () => fromAnotherEngineCopy("StepNotReplaySafeError"),
    {},
    false,
    "StepNotReplaySafeError: from another copy",
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

      it("is classified as on main after a ledger round trip: retried", async () => {
        const body = failing(1, make);
        const run = await start(
          env,
          workflowOf("stored", storedStage(body, opts)),
        );
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        const polled = await run.poll();
        const stage = await run.stage();
        // The replay rebuilds a plain Error from the row's text.
        expect(stage.status).toBe("SUSPENDED");
        // The poll records the step row's text, as it always has.
        const rows = await env.stepLedger.list(stage.id);
        expect(stage.errorMessage).toBe(
          rows.find((row) => row.stepId === "call")!.error,
        );
        expect(polled.failed).toBe(0);
        expect(await run.retryEvents()).toBe(1);
        expect(body.calls).toBe(1);
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

      it("replays through the ledger as on main", async () => {
        const body = failing(1, () => new Error(message));
        const run = await start(
          env,
          workflowOf("poll-text", storedStage(body)),
        );
        await run.execute(1);
        await run.poll();
        if (message === new StepTimeoutError("call").message) {
          // Main rebuilds this step's timeout text as StepTimeoutError.
          expect(await run.stage()).toMatchObject({ status: "FAILED" });
          expect(body.calls).toBe(1);
          return;
        }
        expect(await run.stage()).toMatchObject({ status: "SUSPENDED" });
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "COMPLETED" });
        expect(body.calls).toBe(2);
      });
    });

    /**
     * Who may run a protected step again is main's decision, unchanged by
     * any verdict: each schedule below runs the body exactly as often as
     * main does (round-2 gate, astra-rnarrow-2 P1s).
     */
    describe('reruns of an onReclaim: "fail" step stay as before', () => {
      const opts: StepRunOptions = { onReclaim: "fail" };

      it("refuses a step that threw once a job retry re-opens it", async () => {
        const body = failing(1, () => new QuotaError());
        const run = await start(
          env,
          workflowOf("r8-job", directStage(body, opts)),
        );
        expect(await run.execute(1)).toMatchObject({ willRetry: true });
        const retried = await run.execute(2);
        expect((retried as { error: string }).error).toMatch(
          /^StepNotReplaySafeError: /,
        );
        expect(body.calls).toBe(1);
      });

      it("refuses a step that threw once a poll retry re-opens it", async () => {
        const body = failing(1, () => new QuotaError());
        const run = await start(
          env,
          workflowOf("r8-poll", storedStage(body, opts)),
        );
        await run.execute(1);
        await run.poll();
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "FAILED" });
        expect(body.calls).toBe(1);
      });

      it("keeps a newer refusal when a delayed retry's reopen lands on it", async () => {
        let bodies = 0;
        const stage = defineStage({
          id: "s",
          name: "s",
          schemas: { input: z.object({}), output: out, config: z.object({}) },
          async execute(ctx) {
            try {
              await ctx.step.run(
                "work",
                async () => {
                  if (++bodies === 1) throw new Error("first failure");
                  return "second body";
                },
                opts,
              );
              return { output: { ok: true } };
            } catch (error) {
              if ((error as Error).name !== "StepNotReplaySafeError") {
                await ctx.step.sleep("settle", 1);
              }
              throw error;
            }
          },
        });
        const run = await start(env, workflowOf("stale-cas", stage));
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        const ledger = env.stepLedger;
        const cas = ledger.compareAndSet.bind(ledger);
        const atCas = signal();
        const resume = signal();
        let held = false;
        ledger.compareAndSet = async (...args) => {
          const [, stepId, expected, patch] = args;
          if (
            !held &&
            stepId === "work" &&
            expected.status === "failed" &&
            patch.status === "running"
          ) {
            held = true;
            atCas.open();
            await resume.promise;
          }
          return cas(...args);
        };
        try {
          // The poll retry pauses just before re-opening the step.
          const retry = run.poll();
          await atCas.promise;
          // The last delivery fails the stage; delivering it again ends with
          // the stored error, as main ends it, and re-opens nothing.
          expect(await run.execute(2, 2)).toMatchObject({ outcome: "failed" });
          const again = await run.execute(2, 2);
          expect(again).toMatchObject({ outcome: "failed", willRetry: false });
          expect((again as { error: string }).error).not.toMatch(
            /^StepNotReplaySafeError: /,
          );
          resume.open();
          await retry;
          const last = await run.execute(2, 2);
          expect(last).toMatchObject({ outcome: "failed" });
          expect(bodies).toBe(1);
        } finally {
          resume.open();
          ledger.compareAndSet = cas;
        }
      });

      it("keeps a delayed retry from granting a later delivery's step a rerun", async () => {
        let bodies = 0;
        let executions = 0;
        let armed = false;
        const stage = defineStage({
          id: "s",
          name: "s",
          schemas: { input: z.object({}), output: out, config: z.object({}) },
          async execute(ctx) {
            await ctx.step.sleep("start", 1);
            if (++executions === 1) {
              armed = true;
              throw new Error("service A unavailable");
            }
            try {
              await ctx.step.run(
                "request",
                async () => {
                  if (++bodies === 1) throw new Error("service B unavailable");
                  return "second call";
                },
                opts,
              );
            } catch (error) {
              if ((error as Error).name === "StepNotReplaySafeError")
                throw error;
            }
            await ctx.step.sleep("later", 1);
            return { output: { ok: true } };
          },
        });
        const run = await start(env, workflowOf("late-reopen", stage));
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        const ledger = env.stepLedger;
        const list = ledger.list.bind(ledger);
        const listed = signal();
        const resume = signal();
        let blocked = false;
        ledger.list = async (...args) => {
          if (armed && !blocked) {
            blocked = true;
            listed.open();
            await resume.promise;
          }
          return list(...args);
        };
        try {
          // The poll retry pauses before listing the rows to re-open.
          const retry = run.poll();
          await listed.promise;
          // A new delivery calls the step, which fails, and suspends again.
          expect(await run.execute(2)).toMatchObject({ outcome: "suspended" });
          resume.open();
          await retry;
          await run.poll();
          expect(bodies).toBe(1);
          expect(await run.stage()).toMatchObject({ status: "FAILED" });
        } finally {
          resume.open();
          ledger.list = list;
        }
      });

      it("runs the step once when the poll retries before the queue acknowledges the suspension", async () => {
        let bodies = 0;
        const stage = defineStage({
          id: "s",
          name: "s",
          schemas: { input: z.object({}), output: out, config: z.object({}) },
          async execute(ctx) {
            await ctx.step.sleep("start", 1);
            await ctx.step.run(
              "request",
              async () => {
                if (++bodies === 1) throw new Error("retryable response");
                return "second call";
              },
              opts,
            );
            return { output: { ok: true } };
          },
        });
        const run = await start(env, workflowOf("budget-gap", stage));
        const job = (await env.jobTransport.dequeue())!;
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        // The queue row is still RUNNING when the poll replays and retries.
        await run.poll();
        await env.jobTransport.suspend(job.jobId, env.clock.now());
        await run.poll();
        expect(bodies).toBe(1);
        expect(await run.stage()).toMatchObject({ status: "FAILED" });
      });

      it("gives an async retryIf no verdict, so nothing waits on it past the lease", async () => {
        let calls = 0;
        let predicates = 0;
        const never = new Promise<boolean>(() => {});
        const run = await start(
          env,
          workflowOf(
            "async-lease",
            directStage(
              async () => {
                if (++calls === 1) throw new QuotaError();
                return "ok";
              },
              {
                lease: 10,
                retryIf: (() => {
                  predicates++;
                  return never;
                }) as unknown as () => boolean,
              },
            ),
          ),
        );
        expect(await run.execute(1)).toMatchObject({ willRetry: true });
        expect(await run.execute(2)).toMatchObject({ outcome: "completed" });
        expect(calls).toBe(2);
        expect(predicates).toBe(1);
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
          errorMessage: "over quota",
        });
      });

      it("are left to run after an engine refusal, as before", async () => {
        const started = signal();
        const release = signal();
        const body = async () => {
          body.calls++;
          if (body.calls === 1) {
            started.open();
            await release.promise;
          }
          return "done";
        };
        body.calls = 0;
        const run = await start(
          env,
          workflowOf(
            "refusal-retries",
            storedStage(body, { onReclaim: "fail", retries: 2, lease: 1000 }),
          ),
        );
        const first = run.execute(1);
        try {
          await started.promise;
          env.clock.advance(5000);
          // The next delivery refuses to take over the expired lease.
          expect(await run.execute(2)).toMatchObject({ outcome: "suspended" });
          // The failed row still has retries, and the replay runs the body.
          await run.poll();
          expect(await run.stage()).toMatchObject({ status: "COMPLETED" });
          expect(body.calls).toBe(2);
        } finally {
          release.open();
          await first.catch(() => {});
        }
      });
    });

    describe("a failure row written before this release", () => {
      it("replays timeout-shaped text as StepTimeoutError and fails the stage, as before", async () => {
        const text = new StepTimeoutError("call").message;
        const body = failing(1, () => new Error(text));
        const run = await start(
          env,
          workflowOf("legacy-timeout", storedStage(body)),
        );
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        // What an earlier release wrote: the message, and no failure record.
        const stripped = await env.stepLedger.compareAndSet(
          (await run.stage()).id,
          "call",
          { status: "failed", attempt: 1 },
          { result: null },
        );
        expect(stripped.applied).toBe(true);
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "FAILED" });
        await run.poll();
        expect(body.calls).toBe(1);
      });

      it("keeps the job retry main grants a redelivery that replays it", async () => {
        const text = new StepTimeoutError("call").message;
        const body = failing(1, () => new Error(text));
        const run = await start(
          env,
          workflowOf("legacy-redeliver", storedStage(body)),
        );
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        await env.stepLedger.compareAndSet(
          (await run.stage()).id,
          "call",
          { status: "failed", attempt: 1 },
          { result: null },
        );
        env.clock.advance(POLL_GAP_MS);
        // The acknowledgement was lost; attempt 2 of 3 replays the row.
        expect(await run.execute(2)).toMatchObject({
          outcome: "failed",
          willRetry: true,
        });
        expect(body.calls).toBe(1);
      });
    });

    /**
     * A terminal verdict ends the job exactly as main ends an exhausted
     * final attempt: every later delivery of the job meets the same FAILED
     * stage and does what main does there. Each case runs the verdict and
     * main's exhausted case (an ordinary error, `maxAttempts` equal to the
     * attempt the verdict fired on) through the same deliveries.
     */
    describe("a job delivered again after a terminal verdict", () => {
      const verdicts: Array<[string, () => never | void]> = [
        ["a zod/v3 error", () => void zodV3Parse()],
        [
          "a NonRetryableError",
          () => {
            throw new NonRetryableError("declined");
          },
        ],
      ];

      /** A stage that completes a receipt step, then fails. */
      async function receiptRun(id: string, fail: () => void) {
        const counts = { receipts: 0 };
        const stage = defineStage({
          id: "s",
          name: "s",
          schemas: { input: z.object({}), output: out, config: z.object({}) },
          async execute(ctx) {
            await ctx.step.run("receipt", async () => ++counts.receipts);
            fail();
            return { output: { ok: true } };
          },
        });
        return { ...(await start(env, workflowOf(id, stage))), counts };
      }

      const exhausted = () => {
        throw new QuotaError();
      };

      it.each(
        verdicts,
      )("matches main's exhausted case past the budget after %s (lease lost twice)", async (_case, fail) => {
        const verdict = await receiptRun("past-budget-v", fail);
        const main = await receiptRun("past-budget-m", exhausted);
        // Delivery 1, then the queue's attempt 3 after two lost leases.
        const first = [await verdict.execute(1, 2), await main.execute(1, 1)];
        expect(first[0]).toMatchObject({ outcome: "failed", willRetry: false });
        expect(first[1]).toMatchObject({ outcome: "failed", willRetry: false });
        const again = [await verdict.execute(3, 2), await main.execute(3, 1)];
        expect(again[0]).toMatchObject({ outcome: "failed", willRetry: false });
        expect(again[1]).toMatchObject({ outcome: "failed", willRetry: false });
        expect((await verdict.stage()).status).toBe(
          (await main.stage()).status,
        );
        // Main ends the redelivery with the stored error: no step runs again.
        expect(verdict.counts.receipts).toBe(main.counts.receipts);
        expect(main.counts.receipts).toBe(1);
      });

      it.each(
        verdicts,
      )("matches main's exhausted case within the budget after %s (lost acknowledgement, any host)", async (_case, fail) => {
        const verdict = await receiptRun("in-budget-v", fail);
        const main = await receiptRun("in-budget-m", exhausted);
        await verdict.execute(1, 3);
        await main.execute(1, 1);
        // A main host takes the same FAILED stage the same way.
        const again = [await verdict.execute(2, 3), await main.execute(2, 1)];
        expect(again[0]).toMatchObject({ outcome: "failed", willRetry: false });
        expect(again[1]).toMatchObject({ outcome: "failed", willRetry: false });
        expect(verdict.counts.receipts).toBe(main.counts.receipts);
        expect(main.counts.receipts).toBe(1);
      });

      it("settles through the host as an exhausted attempt, and a redelivery runs as main's", async () => {
        const verdict = await receiptRun("host-ack", () => void zodV3Parse());
        const job = (await env.jobTransport.dequeue())!;
        const message = {
          jobId: job.jobId,
          workflowRunId: job.workflowRunId,
          workflowId: job.workflowId,
          stageId: job.stageId,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
          payload: job.payload,
        };
        const transport = env.jobTransport;
        const fail = transport.fail.bind(transport);
        transport.fail = async () => {
          throw new Error("acknowledgement lost");
        };
        try {
          await expect(
            executeJobWithHeartbeat(verdict.kernel, {
              jobTransport: transport,
              job: message,
            }),
          ).rejects.toThrow("acknowledgement lost");
        } finally {
          transport.fail = fail;
        }
        expect(await verdict.stage()).toMatchObject({ status: "FAILED" });
        await transport.releaseStaleJobs(-60_000);
        const redelivered = (await transport.dequeue())!;
        expect(redelivered.attempt).toBe(2);
        await executeJobWithHeartbeat(verdict.kernel, {
          jobTransport: transport,
          job: { ...message, attempt: redelivered.attempt },
        });
        // Main's exhausted case: the redelivery ends as a dead job (see above).
        expect(verdict.counts.receipts).toBe(1);
      });

      it("schedules no extra delivery when the failure acknowledgement is lost (astra round 7 P1)", async () => {
        /**
         * Delivery 1 completes a receipt and fails; its queue failure is
         * lost. Delivery 2 would reach a provider that is briefly down, and
         * a third delivery would succeed. `budget` is the queue budget the
         * host passes to the kernel.
         */
        async function schedule(id: string, fail: () => void, budget: number) {
          const counts = { entries: 0, receipts: 0, provider: 0 };
          const stage = defineStage({
            id: "s",
            name: "s",
            schemas: { input: z.object({}), output: out, config: z.object({}) },
            async execute(ctx) {
              counts.entries++;
              await ctx.step.run("receipt", async () => ++counts.receipts);
              if (counts.entries === 1) fail();
              await ctx.step.run("provider", async () => {
                counts.provider++;
                if (counts.provider === 1)
                  throw new QuotaError("provider down");
                return "accepted";
              });
              return { output: { ok: true } };
            },
          });
          const run = await start(env, workflowOf(id, stage));
          const transport = env.jobTransport;
          const serve = async (
            job: NonNullable<Awaited<ReturnType<typeof transport.dequeue>>>,
          ) =>
            executeJobWithHeartbeat(run.kernel, {
              jobTransport: transport,
              job: {
                jobId: job.jobId,
                workflowRunId: job.workflowRunId,
                workflowId: job.workflowId,
                stageId: job.stageId,
                attempt: job.attempt,
                maxAttempts: budget,
                payload: job.payload,
              },
            });
          const first = (await transport.dequeue())!;
          const ack = transport.fail.bind(transport);
          transport.fail = async () => {
            throw new Error("acknowledgement lost");
          };
          try {
            await expect(serve(first)).rejects.toThrow("acknowledgement lost");
          } finally {
            transport.fail = ack;
          }
          expect(await run.stage()).toMatchObject({ status: "FAILED" });
          await transport.releaseStaleJobs(-60_000);
          for (let delivery = 0; delivery < 3; delivery++) {
            const next = await transport.dequeue();
            if (!next || next.workflowRunId !== run.workflowRunId) break;
            await serve(next);
          }
          const runRow = await env.persistence.getRun(run.workflowRunId);
          return {
            ...counts,
            stage: (await run.stage()).status,
            run: runRow?.status,
          };
        }

        const verdict = await schedule(
          "p1-verdict",
          () => void zodV3Parse(),
          3,
        );
        const main = await schedule(
          "p1-exhausted",
          () => {
            throw new QuotaError();
          },
          1,
        );
        expect(verdict).toEqual(main);
        expect(main).toEqual({
          entries: 1,
          receipts: 1,
          provider: 0,
          stage: "FAILED",
          run: "FAILED",
        });
      });
    });

    it("ends a redelivery after an ordinary exhausted attempt without consuming a signal, as main does", async () => {
      let failing = true;
      let receipts = 0;
      const stage = defineStage({
        id: "s",
        name: "s",
        schemas: {
          input: z.object({}),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const value = await ctx.step.waitForSignal("approval", {
            timeout: "10m",
          });
          await ctx.step.run("receipt", async () => ++receipts);
          if (failing) throw new QuotaError();
          return { output: { value: String(value) } };
        },
      });
      const run = await start(
        env,
        new WorkflowBuilder(
          "signal-reset",
          "signal-reset",
          "",
          z.object({}),
          z.object({ value: z.string() }),
        )
          .pipe(stage)
          .build(),
      );
      const signal = (payload: unknown) =>
        run.kernel.dispatch({
          type: "step.signal",
          workflowRunId: run.workflowRunId,
          stageId: "s",
          stepId: "approval",
          payload,
        });
      await signal("first");
      expect(await run.execute(1, 1)).toMatchObject({ willRetry: false });
      failing = false;
      expect(await run.execute(2, 2)).toMatchObject({
        outcome: "failed",
        willRetry: false,
      });
      expect(await run.stage()).toMatchObject({ status: "FAILED" });
      expect(receipts).toBe(1);
    });

    describe("the text a failed step row stores", () => {
      it("is main's for a decoded object, so a timeout-like message stays retryable", async () => {
        const text = new StepTimeoutError("call").message;
        const body = failing(1, () => ({ message: text }));
        const run = await start(env, workflowOf("row-text", storedStage(body)));
        await run.execute(1);
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "SUSPENDED" });
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "COMPLETED" });
        expect(body.calls).toBe(2);
      });

      it("is main's for an object whose toString reads as the timeout", async () => {
        const text = new StepTimeoutError("call").message;
        const body = failing(1, () => ({
          message: "provider said no",
          toString: () => text,
        }));
        const run = await start(
          env,
          workflowOf("row-tostring", storedStage(body)),
        );
        await run.execute(1);
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "FAILED" });
        expect(body.calls).toBe(1);
      });
    });

    it("reads a diagnostic once, so a getter that changes cannot break the job result", async () => {
      let reads = 0;
      const body = failing(1, () => {
        const decoded = {};
        Object.defineProperty(decoded, "message", {
          get: () => (++reads === 1 ? "busy" : undefined),
        });
        return decoded;
      });
      const run = await start(env, workflowOf("read-once", directStage(body)));
      const result = await run.execute(1);
      expect(result).toMatchObject({ outcome: "failed", willRetry: true });
      expect(typeof (result as { error: unknown }).error).toBe("string");
      expect(await run.execute(2)).toMatchObject({ outcome: "completed" });
    });

    describe("a branded failure with an unreadable diagnostic", () => {
      it.each([
        [
          "a NonRetryableError with a throwing issues getter",
          () => withThrowingGetter(new NonRetryableError("revoked"), "issues"),
        ],
        [
          "a zod/v3 error with a throwing _zod getter",
          () => {
            try {
              zodV3Parse();
            } catch (error) {
              return withThrowingGetter(error as Error, "_zod");
            }
            throw new Error("unreachable");
          },
        ],
        [
          "another copy's terminal failure with a throwing issues getter",
          () =>
            withThrowingGetter(
              fromAnotherEngineCopy("StepTimeoutError"),
              "issues",
            ),
        ],
      ])("stays terminal: %s", async (_case, make) => {
        const body = failing(9, make);
        const run = await start(
          env,
          workflowOf("brand-getter", directStage(body)),
        );
        expect(await run.execute(1)).toMatchObject({
          outcome: "failed",
          willRetry: false,
        });
        expect(body.calls).toBe(1);
      });

      it("stays terminal: a duplicate step key with a throwing issues getter", async () => {
        const stage = defineStage({
          id: "s",
          name: "s",
          schemas: { input: z.object({}), output: out, config: z.object({}) },
          async execute(ctx) {
            await ctx.step.run("call", async () => 1);
            try {
              await ctx.step.run("call", async () => 2);
            } catch (error) {
              throw withThrowingGetter(error as Error, "issues");
            }
            return { output: { ok: true } };
          },
        });
        const run = await start(env, workflowOf("dup-getter", stage));
        expect(await run.execute(1)).toMatchObject({
          outcome: "failed",
          willRetry: false,
        });
      });
    });

    describe("a retryIf that misbehaves", () => {
      it("throwing an error whose message is a Symbol leaves the failure recorded and retried", async () => {
        const body = failing(1, () => new QuotaError());
        const run = await start(
          env,
          workflowOf(
            "symbol-predicate",
            directStage(body, {
              retries: 1,
              retryIf: () => {
                const odd = new Error("x");
                Object.defineProperty(odd, "message", { value: Symbol("odd") });
                throw odd;
              },
            }),
          ),
        );
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        const [row] = await env.stepLedger.list((await run.stage()).id);
        expect(row).toMatchObject({ status: "failed", error: "over quota" });
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "COMPLETED" });
        expect(body.calls).toBe(2);
      });

      it.each([
        [
          "a rejected native Promise from another realm",
          () => runInNewContext("Promise.reject(new Error('no'))"),
        ],
        [
          "a rejected native Promise with its own Symbol.toStringTag",
          () =>
            Object.defineProperty(
              Promise.reject(new Error("no")),
              Symbol.toStringTag,
              { value: "Task" },
            ),
        ],
        [
          "a rejected native Promise from another realm with its own Symbol.toStringTag",
          () =>
            Object.defineProperty(
              runInNewContext("Promise.reject(new Error('no'))"),
              Symbol.toStringTag,
              { value: "Task" },
            ),
        ],
        [
          "a rejected Promise whose then getter throws",
          () => {
            const p = Promise.reject(new Error("no"));
            Object.defineProperty(p, "then", {
              get() {
                throw new Error("then getter");
              },
            });
            return p;
          },
        ],
      ])("returning %s leaves no unhandled rejection", async (_case, result) => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        try {
          const body = failing(1, () => new QuotaError());
          const run = await start(
            env,
            workflowOf(
              "promise-predicate",
              directStage(body, {
                retries: 1,
                retryIf: result as unknown as () => boolean,
              }),
            ),
          );
          expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(unhandled).toEqual([]);
          await run.poll();
          expect(body.calls).toBe(2);
        } finally {
          process.off("unhandledRejection", onUnhandled);
        }
      });

      it("reads no property of a returned object that is not a Promise", async () => {
        let reads = 0;
        const returned = new Proxy(
          {},
          {
            get() {
              reads++;
              return undefined;
            },
          },
        );
        const body = failing(1, () => new QuotaError());
        const run = await start(
          env,
          workflowOf(
            "object-predicate",
            directStage(body, {
              retries: 1,
              retryIf: (() => returned) as unknown as () => boolean,
            }),
          ),
        );
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        expect(reads).toBe(0);
      });

      it("leaves the objects it returns unchanged", async () => {
        class Receipt {}
        class SdkPromise<T> extends Promise<T> {}
        const receipt = new Receipt();
        const pending = SdkPromise.resolve(true);
        const results: object[] = [receipt, pending];
        const body = failing(2, () => new QuotaError());
        const run = await start(
          env,
          workflowOf(
            "untouched-results",
            directStage(body, {
              retries: 2,
              retryIf: (() => results.shift()) as unknown as () => boolean,
            }),
          ),
        );
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        await run.poll();
        await run.poll();
        expect(body.calls).toBe(3);
        expect(Object.hasOwn(receipt, "constructor")).toBe(false);
        expect(Object.hasOwn(pending, "constructor")).toBe(false);
        expect(pending.then(() => 1)).toBeInstanceOf(SdkPromise);
      });
    });

    // Main reads an Error's message in the step, and its name and stack in
    // the executor: a getter there throws as it does on main (see below).
    describe.each(
      brokenGetterCases.filter(([key]) => key !== "message"),
    )("a body error with a throwing %s getter", (_case, make) => {
      it("is recorded, and the step's own retry runs", async () => {
        const body = failing(1, make);
        const run = await start(
          env,
          workflowOf("getter-step", directStage(body, { retries: 1 })),
        );
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        const [row] = await env.stepLedger.list((await run.stage()).id);
        expect(row).toMatchObject({ status: "failed", leaseExpiresAt: null });
        expect(typeof row!.error).toBe("string");
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "COMPLETED" });
        expect(body.calls).toBe(2);
      });
    });

    describe.each(
      brokenGetterCases.filter(
        ([key]) => !["message", "name", "stack"].includes(key),
      ),
    )("a body error with a throwing %s getter", (_case, make) => {
      it("fails the job retryably, and the retry runs the step again", async () => {
        const body = failing(1, make);
        const run = await start(
          env,
          workflowOf("getter-job", directStage(body)),
        );
        expect(await run.execute(1)).toMatchObject({
          outcome: "failed",
          willRetry: true,
        });
        expect(await run.execute(2)).toMatchObject({ outcome: "completed" });
        expect(body.calls).toBe(2);
      });
    });

    describe("a body error main cannot format", () => {
      it.each([
        ["name", () => withThrowingGetter(new Error("boom"), "name")],
        ["stack", () => withThrowingGetter(new Error("boom"), "stack")],
        [
          "NonRetryableError name",
          () => withThrowingGetter(new NonRetryableError("revoked"), "name"),
        ],
      ])("propagates a throwing %s getter from job.execute, as main does", async (_case, make) => {
        const body = failing(1, make);
        const run = await start(
          env,
          workflowOf("getter-main", directStage(body)),
        );
        await expect(run.execute(1)).rejects.toThrow(/ getter$/);
        expect(await run.stage()).toMatchObject({ status: "RUNNING" });
        expect(body.calls).toBe(1);
      });

      it("leaves the step unrecorded when its message getter throws, as main does", async () => {
        const body = failing(1, () =>
          withThrowingGetter(new Error("boom"), "message"),
        );
        const run = await start(
          env,
          workflowOf("getter-message", directStage(body, { retries: 1 })),
        );
        expect(await run.execute(1)).toMatchObject({
          outcome: "failed",
          willRetry: true,
          error: "message getter",
        });
        const [row] = await env.stepLedger.list((await run.stage()).id);
        expect(row).toMatchObject({ status: "running" });
        expect(body.calls).toBe(1);
      });

      it("fails with the control-flow getter's error, as main does", async () => {
        const body = failing(1, () =>
          withThrowingGetter(
            new NonRetryableError("revoked"),
            Symbol.for("@bratsos/workflow-engine/step-control-flow"),
          ),
        );
        const run = await start(
          env,
          workflowOf("getter-control-flow", directStage(body)),
        );
        expect(await run.execute(1)).toMatchObject({
          outcome: "failed",
          willRetry: true,
          error: expect.stringMatching(/step-control-flow\) getter$/),
        });
      });
    });

    it("fails a stage whose checkCompletion throws on the first throw, as before", async () => {
      let calls = 0;
      const stage = defineAsyncBatchStage({
        id: "s",
        name: "s",
        mode: "async-batch",
        schemas: { input: z.object({}), output: out, config: z.object({}) },
        async execute() {
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
          calls++;
          throw new QuotaError("provider 503");
        },
      });
      const run = await start(env, workflowOf("cc-main", stage));
      expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
      expect((await run.poll()).failed).toBe(1);
      expect(await run.stage()).toMatchObject({ status: "FAILED" });
      expect(await run.retryEvents()).toBe(0);
      expect(calls).toBe(1);
    });

    describe("a redelivered job of a stage that failed terminally", () => {
      it.each([
        ["a Zod error", zodParse, 1],
        ["a NonRetryableError", () => new NonRetryableError("declined"), 1],
        ["an ordinary error on the last attempt", () => new QuotaError(), 3],
      ])('does not repeat an onReclaim: "fail" step after %s', async (_case, make, attempt) => {
        let effects = 0;
        const body = async () => {
          effects++; // the effect happens, then the body throws
          throw make();
        };
        const run = await start(
          env,
          workflowOf("redeliver", directStage(body, { onReclaim: "fail" })),
        );
        const first = await run.execute(attempt);
        expect(first).toMatchObject({ outcome: "failed", willRetry: false });
        // The acknowledgement was lost: the same delivery arrives again,
        // then the next one. Each ends with the stored error, as on main.
        for (const again of [attempt, attempt + 1]) {
          const result = await run.execute(again);
          expect(result).toMatchObject({ outcome: "failed", willRetry: false });
          expect((result as { error: string }).error).toBe(
            (first as { error: string }).error,
          );
        }
        expect(effects).toBe(1);
      });
    });

    describe("the error a stage catches from a step", () => {
      /** The text of a cause, whatever it is. */
      const causeText = (cause: unknown) =>
        typeof cause === "string"
          ? cause
          : (cause as { message?: string } | undefined)?.message;

      /** Records what the stage caught, directly and on the replay. */
      function observingStage(
        body: () => Promise<unknown>,
        opts: StepRunOptions,
        seen: unknown[],
      ) {
        return defineStage({
          id: "s",
          name: "s",
          schemas: { input: z.object({}), output: out, config: z.object({}) },
          async execute(ctx) {
            try {
              await ctx.step.run("call", body, opts);
            } catch (error) {
              const e = error as Error;
              seen.push({
                name: e.name,
                branded: isNonRetryableError(e),
                cause: (e.cause as Error | undefined)?.name,
                causeText: causeText(e.cause),
              });
            }
            await ctx.step.sleep("nap", 1000);
            return { output: { ok: true } };
          },
        });
      }

      it.each([
        [
          "a Zod error declined by retryIf",
          zodParse,
          { retryIf: (): boolean => false },
          { name: "NonRetryableError", branded: true, cause: "ZodError" },
        ],
        [
          "an ordinary error declined by retryIf",
          () => new QuotaError(),
          { retryIf: (): boolean => false },
          {
            name: "NonRetryableError",
            branded: true,
            cause: "QuotaError",
            causeText: "over quota",
          },
        ],
        [
          "a thrown string declined by retryIf",
          () => "bad answer",
          { retryIf: (): boolean => false },
          {
            name: "NonRetryableError",
            branded: true,
            causeText: "bad answer",
          },
        ],
        [
          "an unnamed object declined by retryIf",
          () => ({ message: "bad answer" }),
          { retryIf: (): boolean => false },
          {
            name: "NonRetryableError",
            branded: true,
            causeText: "bad answer",
          },
        ],
        [
          "a Zod error",
          zodParse,
          {},
          {
            name: "ZodError",
            branded: false,
            cause: undefined,
            causeText: undefined,
          },
        ],
        [
          "a NonRetryableError",
          () => new NonRetryableError("revoked"),
          {},
          {
            name: "NonRetryableError",
            branded: true,
            cause: undefined,
            causeText: undefined,
          },
        ],
      ])("is %s directly, and a plain Error after a replay", async (_case, make, opts, expected) => {
        const seen: Array<Record<string, unknown>> = [];
        const run = await start(
          env,
          workflowOf(
            "observe",
            observingStage(failing(9, make), opts as StepRunOptions, seen),
          ),
        );
        expect(await run.execute(1)).toMatchObject({ outcome: "suspended" });
        await run.poll();
        expect(await run.stage()).toMatchObject({ status: "COMPLETED" });
        expect(seen).toHaveLength(2);
        expect(seen[0]).toMatchObject(expected);
        // A replayed step failure is classified as on main: rebuilt from text.
        expect(seen[1]).toMatchObject({ name: "Error", branded: false });
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
