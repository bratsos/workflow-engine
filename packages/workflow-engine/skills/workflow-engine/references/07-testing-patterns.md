# Testing Patterns

Complete guide for testing with the command kernel using in-memory adapters.

## In-Memory Adapters

The engine provides in-memory implementations for all ports:

```typescript
// Persistence and job queue
import {
  InMemoryWorkflowPersistence,
  InMemoryJobQueue,
  InMemoryAICallLogger,
} from "@bratsos/workflow-engine/testing";

// Kernel-specific test adapters
import {
  FakeClock,
  InMemoryBlobStore,
  CollectingEventSink,
} from "@bratsos/workflow-engine/kernel/testing";
```

## The test harness

`createTestHarness` wires every in-memory port behind a real kernel *and*
drives it: create a run, claim it, execute its jobs through the same
`executeJobWithHeartbeat` the hosts use, poll suspended stages so durable
stages replay, flush the outbox, and advance the fake clock to the next poll
deadline when nothing else can run.

```typescript
import { createTestHarness } from "@bratsos/workflow-engine/testing";
import { defineWorkflow } from "@bratsos/workflow-engine";
import { z } from "zod";

const In = z.object({ message: z.string() });

const workflow = defineWorkflow("echo-wf", { input: In })
  .stage("echo", {
    schemas: {
      input: In,
      output: z.object({ echoed: z.string() }),
      config: z.object({ prefix: z.string().default("") }),
    },
    async execute(ctx) {
      return { output: { echoed: `${ctx.config.prefix}${ctx.input.message}` } };
    },
  })
  .build();

const harness = createTestHarness({ workflows: [workflow] });
```

It returns the kernel and every port it built, plus the two driver methods:

| Field | What it is |
| --- | --- |
| `kernel` | the real `Kernel`, for dispatching commands directly |
| `persistence`, `jobQueue`, `blobStore`, `eventSink` | the in-memory ports |
| `stepLedger` | `InMemoryStepLedger` on the harness clock — durable steps work out of the box |
| `aiLogger`, `mockAi` | `InMemoryAICallLogger` and the mock AI factory wired into `services` |
| `clock` | the `FakeClock` the kernel and ledger share |
| `steps` | seed a durable step's outcome, and read back what was recorded |
| `run(workflowId, input, config?)` | create a run and drive ticks until it is terminal |
| `start(workflowId, input, config?)` | create a run without driving it |
| `tick()` | do exactly one round and return a `TickReport` |
| `tickUntil(predicate, { maxTicks? })` | tick until `predicate` holds, then return the reports |

Options: `workflows`, `services` (merged over the mock AI defaults), `clock`,
`stepLedger`, `aiLogger`, `mockAi`, `workerId`, `eventSink`, `plugins`,
`maxTicks` (default 100 — `run()` throws rather than hang) and
`idleAdvanceMs`.

## Mocking durable steps

A mocked step is not an interception layer: it is a pre-seeded step ledger
row. The engine already decides what to do with a step by reading its row —
`completed` short-circuits and returns the stored result, `failed` rethrows
the stored error, a wait whose `deadlineAt` has passed times out — so a mock
only writes the row the engine was about to write with a different outcome
in it. Everything `harness.steps` asserts on is therefore the real ledger,
and a mocked step is indistinguishable from one that produced that outcome
for real.

```typescript
const harness = createTestHarness({ workflows: [workflow] });

harness.steps.mockResult("fetch-document", { title: "Q3 report" });
harness.steps.mockError("charge-card", new Error("card declined"));
harness.steps.mockTimeout("await-approval");
harness.steps.skipSleeps();

const result = await harness.run("billing-wf", { customerId: "cus_1" });

expect(await harness.steps.status("fetch-document")).toBe("completed");
expect(await harness.steps.result("fetch-document")).toEqual({
  title: "Q3 report",
});
expect(await harness.steps.error("charge-card")).toBe("card declined");
```

| Seed | What it does |
| --- | --- |
| `mockResult(stepId, value)` | the step records `completed` with `value`; its body never runs. `step.run`, `step.waitFor`, `step.waitForSignal` |
| `mockError(stepId, error, { attempt? })` | the step records `failed`; the step throws the stored error instead of running its body |
| `mockTimeout(stepId)` | the step's deadline is already past, so it fails with `StepTimeoutError` through the engine's own timeout path. `step.waitFor` and `step.waitForSignal` only |
| `skipSleep(stepId)` / `skipSleeps()` | `step.sleep` returns immediately instead of suspending |
| `clearMocks()` | drop every seed; recorded rows are untouched |

| Assertion | What it returns |
| --- | --- |
| `record(stepId)` | the `StepRecord`, or `null` when the step never ran |
| `records()` | every row this ledger holds |
| `status(stepId)` | `"completed" \| "failed" \| "pending" \| "running"`, or `undefined` |
| `result(stepId)` / `error(stepId)` | the recorded result or error message |
| `wasMocked(stepId)` | whether a seed decided this step's outcome |

All five assertions are async — they read the ledger.

### Caveats

- **Seeds match by step id across every stage.** A step id is unique within
  a stage, so this only matters when two stages deliberately reuse one; then
  the seed applies to whichever stage claims it first, and `record(stepId)`
  returns the most recently updated row.
- **A seed answers for the whole run, not just the first stage attempt.**
  When the engine retries a failed stage it reopens the stage's `run` step
  rows rather than deleting the ones that named an external effect; the seed
  is re-asserted on that fresh claim, so a mocked step never falls back to
  its real body mid-run. Call `clearMocks()` to hand it back.
- **A mocked error is terminal by default.** `step.run` rethrows a stored
  failure only once the row's `attempt` has passed the step's own `retries`
  budget, so `mockError` records `MOCKED_FAILURE_ATTEMPT`
  (`Number.MAX_SAFE_INTEGER`) to sit above any budget. Pass
  `mockError(id, err, { attempt: 1 })` when the retry path is what you are
  testing, and do not assert on `attempt` for a mocked failure.
- **`mockTimeout` needs a deadline.** Only `waitFor` and `waitForSignal`
  have one. Seeding it for a `run` or `sleep` step throws a message saying
  so rather than silently doing nothing.

### Testing a stage that suspends

This is the case that used to need a real clock. A durable sleep suspends
the stage; the harness advances its `FakeClock` to `nextPollAt`, so the run
still completes, but it takes several ticks:

```typescript
const baseline = await harness.run("cooldown-wf", { id: "1" });
expect(baseline.reports[0]?.outcomes[0]?.outcome).toBe("suspended");
expect(baseline.ticks).toBeGreaterThan(1);
```

`skipSleeps()` removes the suspension entirely, so the stage runs straight
through:

```typescript
const harness = createTestHarness({ workflows: [workflow] });
harness.steps.skipSleeps();

const result = await harness.run("cooldown-wf", { id: "1" });
expect(result.status).toBe("COMPLETED");
expect(result.ticks).toBe(1);
```

### Asserting part-way through a run

`start()` creates a run without driving it and `tickUntil()` drives until a
condition holds, which is how a test waits for one named step's result:

```typescript
const harness = createTestHarness({ workflows: [workflow] });
await harness.start("review-wf", { docId: "doc-1" });

await harness.tickUntil(
  async () => (await harness.steps.status("draft")) === "completed",
);

expect(await harness.steps.result("draft")).toEqual({ words: 400 });
// The stage is parked on its sleep; the next stage has not been reached.
expect(await harness.steps.status("publish")).toBeUndefined();
```

`tickUntil` throws when `maxTicks` rounds pass without the condition
holding — a condition that never arrives is a test failure, not a silent
pass.

### Using it with your own StepLedger

The harness wraps whatever `stepLedger` it was given, so seeding works
against a consumer's own ledger implementation too. The wrapper mirrors the
port exactly, including whether the wrapped ledger implements the optional
`clearExcept`: a wrapper that always claimed it could clear selectively
would make a ledger that cannot lie to the kernel.
`createMockStepLedger(inner, clock)` is exported if you want the wrapper
without the harness.

## Full workflow lifecycle test

```typescript
import { describe, expect, it } from "vitest";

describe("echo workflow", () => {
  it("completes a single-stage workflow", async () => {
    const harness = createTestHarness({ workflows: [workflow] });

    const result = await harness.run("echo-wf", { message: "hello" });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ echoed: "hello" });
  });

  it("passes per-stage config", async () => {
    const harness = createTestHarness({ workflows: [workflow] });

    // Per-stage config travels in the job's payload as `job.payload.config`,
    // keyed by stage id — `run.create`'s `config` is what puts it there.
    const result = await harness.run(
      "echo-wf",
      { message: "hello" },
      { echo: { prefix: "> " } },
    );

    expect(result.output).toEqual({ echoed: "> hello" });
  });
});
```

`run()` returns `{ workflowRunId, status, output, error?, ticks, reports, run }`.
`reports` is one `TickReport` per round — `{ claimed, executed, outcomes,
suspendedChecked, resumed, eventsFlushed, advancedMs, idle }` — which is how a
test asserts that a stage *suspended* before it completed:

```typescript
const result = await harness.run("durable-wf", { docId: "doc-1" });
expect(result.reports[0]?.outcomes[0]?.outcome).toBe("suspended");
```

### Seeding AI responses

`harness.mockAi` is the mock AI factory the kernel hands to every stage:

```typescript
harness.mockAi.setTextResponse("summarize", { text: "the summary" });
harness.mockAi.mockObjectResponseForSchema(FactsSchema, { facts: [] });
// The next matching call throws once; later calls succeed.
harness.mockAi.failOnce("summarize", new Error("transient upstream 503"));

expect(harness.mockAi.helper.getAllCallsRecursive()).toHaveLength(2);
```

## Driving the kernel by hand

The harness is the host loop in miniature; when a test needs one specific
step, dispatch it directly. The two host helpers are exported, so a test can
run the same loop a host runs:

```typescript
import {
  executeJobWithHeartbeat,
  runMaintenanceTick,
} from "@bratsos/workflow-engine/kernel";

// One bounded maintenance pass: claim pending runs, poll suspended stages,
// reap stale leases, flush the outbox, reap stuck runs. Every option falls
// back to HOST_DEFAULTS.
const counts = await runMaintenanceTick(kernel, { workerId: "w-1" });

// Execute one dequeued job under a lease heartbeat and route its outcome.
const job = await jobQueue.dequeue();
if (job) {
  await executeJobWithHeartbeat(kernel, { jobTransport: jobQueue, job });
}
```

`stage.pollSuspended` is what resumes a suspended stage: for a durable stage
it replays `execute()` with completed steps answered from the ledger; for an
async-batch stage it calls `checkCompletion`. A stage is only picked up once
its `nextPollAt` has passed, so a test with a `FakeClock` advances the clock
first. The poll claims the stage by moving `nextPollAt` forward (a lease,
version-guarded) before running anything, exactly as against Prisma, so two
polls dispatched concurrently run the body once; every outcome then writes
`nextPollAt` again (`null` on completion, the step's next poll time on a
re-suspend):

```typescript
harness.clock.advance(60_000);
const polled = await harness.kernel.dispatch({ type: "stage.pollSuspended" });
expect(polled.checked).toBe(1);
```

## Lower-level: createTestKernel

`createTestKernel(workflows, opts?)` builds the same ports and kernel without
the driver loop, for tests that dispatch commands one at a time:

```typescript
import { createTestKernel } from "@bratsos/workflow-engine/testing";

const { kernel, persistence, jobTransport, clock, flush } = createTestKernel([
  workflow,
]);
```

## FakeClock

Injectable time source for deterministic testing:

```typescript
const clock = new FakeClock();
clock.now(); // Returns frozen time

// Advance time for testing stale leases, poll intervals, etc.
clock.advance(60_000); // Advance 60 seconds
```

## CollectingEventSink

Captures events for assertions:

```typescript
const eventSink = new CollectingEventSink();

// ... run workflow ...

// Flush outbox to publish events
await kernel.dispatch({ type: "outbox.flush" });

// Assert on collected events
expect(eventSink.events).toContainEqual(
  expect.objectContaining({ type: "workflow:completed" })
);
```

## Testing Idempotency

```typescript
it("deduplicates run.create with same key", async () => {
  const cmd = {
    type: "run.create" as const,
    idempotencyKey: "same-key",
    workflowId: "echo-wf",
    input: { message: "hello" },
  };

  const first = await kernel.dispatch(cmd);
  const second = await kernel.dispatch(cmd);

  expect(first.workflowRunId).toBe(second.workflowRunId);
});
```

## Testing Cancellation

```typescript
it("cancels a running workflow", async () => {
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: "cancel-test",
    workflowId: "echo-wf",
    input: { message: "hello" },
  });

  await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

  const { cancelled } = await kernel.dispatch({
    type: "run.cancel",
    workflowRunId,
    reason: "User cancelled",
  });
  expect(cancelled).toBe(true);
});
```

## Reset Between Tests

```typescript
beforeEach(() => {
  persistence.clear();
  jobQueue.clear();
  eventSink.events = [];
});
```

## Conformance Suites for Custom Adapters (v0.11+)

If you implement `WorkflowPersistence`, `JobQueue`, `AICallLogger`, or `StepLedger` yourself (a non-Prisma database, a queue product, etc.), validate it against the same behavior the built-in Prisma and in-memory adapters are tested with, instead of hand-rolling parity tests:

```typescript
import {
  persistenceConformanceSuite,
  jobQueueConformanceSuite,
  aiCallLoggerConformanceSuite,
  stepLedgerConformanceSuite,
} from "@bratsos/workflow-engine/testing";
```

Each suite is a vitest side-effect registrar: calling it registers `describe`/`it` blocks, so it must be invoked at module scope inside a `*.test.ts` file, passing a factory that returns a fresh adapter instance per test:

```typescript
// my-adapter.conformance.test.ts
import { persistenceConformanceSuite, jobQueueConformanceSuite } from "@bratsos/workflow-engine/testing";
import { MyCustomPersistence } from "./my-custom-persistence";
import { MyCustomJobQueue } from "./my-custom-job-queue";

persistenceConformanceSuite("MyCustomPersistence", () => new MyCustomPersistence());
jobQueueConformanceSuite("MyCustomJobQueue", () => new MyCustomJobQueue());
```

The factory type signatures -- note the `reset`/`clear` seam:

```typescript
interface ResettableFixture {
  clear?: () => void;        // synchronous reset (in-memory fakes)
  reset?: () => Promise<void>;  // async reset (e.g. a real database's TRUNCATE)
}

type PersistenceFactory = () => WorkflowPersistence & ResettableFixture;
type JobQueueFactory = () => JobQueue & ResettableFixture;
type AILoggerFactory = () => AICallLogger & ResettableFixture;

// `StepLedger` has a `clear(stageRecordId)` of its own, so its fixture
// carries only the async seam rather than intersecting `ResettableFixture`.
type StepLedgerFixture = StepLedger & { reset?: () => Promise<void> };
type StepLedgerFactory = () => StepLedgerFixture;
```

Each suite's `beforeEach` prefers the async `reset()` when the fixture provides one, falling back to synchronous `clear()` otherwise. For a real-database adapter, attach `reset` instead of `clear`:

```typescript
persistenceConformanceSuite("MyCustomPersistence (real database)", () => {
  const adapter = new MyCustomPersistence(pool);
  return Object.assign(adapter, {
    reset: async () => {
      await pool.query(`TRUNCATE TABLE workflow_runs, workflow_stages CASCADE`);
    },
  });
});
```

**FK-safe seeding convention:** before creating any stage, log, artifact, or annotation row, the suite seeds a parent `WorkflowRun` row first if one doesn't already exist for the referenced run id. Real schemas (e.g. Postgres) enforce a mandatory foreign key from those child tables to their parent run, even though an in-memory fake might not care -- your adapter needs to actually support that FK relationship (accept the parent row the suite seeds) for the suite to pass cleanly.

**`StepLedger` patch semantics.** `stepLedgerConformanceSuite` pins the one rule every field of a `StepRecordPatch` follows: a key that is absent -- or present holding `undefined`, which is what a spread of an optional property produces -- leaves that column alone, and any other value, **`null` included**, is written. `{ result: null }` is how a step records "completed, with no value", so it has to overwrite whatever the row held; an adapter that skips the write leaves the previous attempt's result in place, and because a re-run can preserve a step row rather than delete it, every later replay reads that stale value back. The suite also covers insert-if-absent `claim` (a second claim returns the stored row, not the one passed in), `compareAndSet` with and without a pinned attempt (an omitted `expected.attempt` matches any attempt), seq-ordered `list`, and the optional `clearExcept`, which is skipped rather than failed when your implementation does not provide it.

Run it like any other test file (`vitest run my-adapter.conformance.test.ts`). A failing case points at a specific behavior your adapter diverges on -- e.g. version-bump semantics, suspended-readiness ordering, or retry defaults -- the same semantics the built-in Prisma/in-memory adapters are held to. This isn't just a convenience for third-party adapter authors: `PrismaWorkflowPersistence`/`PrismaJobQueue`/`PrismaAICallLogger`/`PrismaStepLedger` are validated with the exact same suites against a real Postgres database in this repo's own CI (each factory attaching `reset` the same way as the example above), not just against the in-memory fakes.
