---
sidebar_position: 1
title: Testing Workflows
---

# Testing Workflows

Because the workflow kernel is environment-agnostic and relies on injected ports, you can write fast, deterministic unit and integration tests using in-memory adapters, without spinning up PostgreSQL, running queue engines, or making network requests to LLM providers.

`@bratsos/workflow-engine/testing` imports nothing from vitest, so everything below also runs from a plain `tsx` script.

---

## The test harness

`createTestHarness` wires every in-memory port behind a real kernel and drives the host loop for you — claim → dequeue and execute through the real `executeJobWithHeartbeat` → poll suspended stages → flush the outbox → advance the fake clock to the next poll deadline when nothing else can run — until the run is terminal. It is the way to test a workflow; the by-hand kernel loop further down is what it does inside.

```typescript
import { describe, it, expect } from "vitest";
import { createTestHarness } from "@bratsos/workflow-engine/testing";
import { billingWorkflow } from "./workflow";

describe("billing", () => {
  it("runs to completion", async () => {
    const harness = createTestHarness({ workflows: [billingWorkflow] });
    harness.mockAi.setTextResponse("summarize", { text: "the summary" });

    const result = await harness.run("billing-wf", { customerId: "cus_1" });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ summary: "the summary" });
    expect(result.ticks).toBeLessThan(10);
  });
});
```

`run(workflowId, input, config?)` returns `{ workflowRunId, status, output?, error?, ticks, reports, run }`; `reports` is one `TickReport` per round (`claimed`, `executed`, `outcomes[]`, `suspendedChecked`, `resumed`, `eventsFlushed`, `advancedMs`, `idle`), so a test can assert that a stage suspended and resumed rather than only looking at the end state.

### Options

| Option | Default | Purpose |
| :--- | :--- | :--- |
| `workflows` | `[]` | Workflows registered with the kernel (through `createWorkflowRegistry`). |
| `services` | mock AI + in-memory logger | Kernel services; anything you pass wins. |
| `clock` | fresh `FakeClock` | The clock every port reads. |
| `stepLedger` | `InMemoryStepLedger` on the harness clock | Durable step storage. |
| `blobStore`, `eventSink`, `aiLogger`, `mockAi` | in-memory | Port overrides. |
| `plugins` | — | Plugins wired through a plugin runner (ignored when `eventSink` is set). |
| `maxTicks` | `100` | Guard for `run()`. |
| `spillThresholdBytes` | 64 KiB | Forwarded to `createKernel`. |
| `jobHeartbeatIntervalMs` | `10` | Real-time interval of the job lease heartbeat `tick()` runs under; see *Cancellation*. |
| `idleAdvanceMs` | `1000` | How far to advance the clock when nothing is runnable and no stage declares a `nextPollAt`. |

The harness exposes what it built — `kernel`, `persistence`, `jobQueue`, `blobStore`, `eventSink`, `clock`, `stepLedger`, `aiLogger`, `mockAi`, `steps` — plus `run`, `start`, `tick`, `tickUntil` and `cancel`.

### Asserting part-way through a run

`start()` creates a run without driving it; `tick()` runs one round and returns its `TickReport`; `tickUntil(predicate, { maxTicks? })` ticks until a condition holds:

```typescript
const { workflowRunId } = await harness.start("review-wf", { docId: "doc-1" });

await harness.tickUntil(
  async () => (await harness.steps.status("draft")) === "completed",
);
expect(await harness.steps.status("publish")).toBeUndefined();

const stages = await harness.persistence.getStagesByRun(workflowRunId);
expect(stages.find((s) => s.stageId === "review")?.status).toBe("SUSPENDED");
```

---

## Mocking Durable Steps

`harness.steps` decides what a durable step does before the run, and reads back what the ledger recorded:

```typescript
const harness = createTestHarness({ workflows: [billingWorkflow] });

harness.steps.mockResult("fetch-document", { title: "Q3 report" });
harness.steps.mockError("charge-card", new Error("card declined"));
harness.steps.mockTimeout("await-approval"); // waitFor / waitForSignal only
harness.steps.skipSleeps();                  // no clock advance needed

const result = await harness.run("billing-wf", { customerId: "cus_1" });

expect(await harness.steps.status("fetch-document")).toBe("completed");
expect(await harness.steps.result("fetch-document")).toEqual({ title: "Q3 report" });
expect(await harness.steps.error("charge-card")).toBe("card declined");
expect(harness.steps.wasMocked("charge-card")).toBe(true);
```

The full surface: `mockResult(stepId, result)`, `mockError(stepId, error, { attempt? })`, `mockTimeout(stepId)`, `skipSleep(stepId)`, `skipSleeps()`, `clearMocks()`, and `record`, `records`, `status`, `result`, `error`, `wasMocked` to assert on.

A mocked step is a pre-seeded step ledger row, not an interception layer: the engine already short-circuits a `completed` row, rethrows a `failed` one, and times out a wait whose deadline has passed, so a seed only writes the row the engine was about to write. It is applied as a patch on the record the engine passed to `claim()`, so `stageRecordId`, `stepId`, `seq`, `kind` and `externalKey` stay the engine's own values.

Caveats worth knowing before you rely on this:

- Seeds match by step id across every stage, so a step id two stages deliberately share is answered for whichever claims it first.
- A seed answers for the whole run: when the engine retries a failed stage it reopens that stage's step rows, and the seed is re-asserted rather than falling back to the real body. `clearMocks()` hands the step back.
- `mockError` records the failure above any `retries` budget the step declares, so it is terminal. Pass `{ attempt: 1 }` to test the retry path, and do not assert on a mocked failure's `attempt`.
- `mockTimeout` throws for a step that has no deadline (`step.run`, `step.sleep`) rather than silently doing nothing.

`createMockStepLedger(inner, clock)` is exported for use without the harness; it mirrors the `StepLedger` port exactly.

---

## Mocking AI Calls

The harness's `mockAi` is a scriptable `AIHelper` factory (`createMockAIHelperFactory()`), and the same instance is what the kernel injects as `ctx.ai` and behind `ctx.step.ai`:

```typescript
harness.mockAi.setTextResponse("summarize", { text: "the summary" });
harness.mockAi.setObjectResponse("classify", { object: { label: "spam" } });
// Dispatch object responses on Zod schema identity when several calls share a prompt shape.
harness.mockAi.mockObjectResponseForSchema(FactsSchema, { facts: [] });
// The next matching call throws exactly once; later calls succeed — how a
// replay-safety test makes one map item fail one time.
harness.mockAi.failOnce("item-2", new Error("subscription limit reached"));
```

`setTextResponse(pattern, response)` matches the prompt by substring or RegExp; `MockTextResponse.output` seeds structured output for `generateText` + `Output.object(...)` (when omitted, the scripted `text` is parsed through the output spec exactly as the AI SDK does). `failOnce` takes a substring, a RegExp, or a predicate over `{ modelKey, prompt, kind }`.

Cost and token accounting is real: the harness's `InMemoryAICallLogger` records every mocked call, so a test can assert on spend:

```typescript
const stats = await harness.aiLogger.getStats(`workflow.${result.workflowRunId}`);
expect(stats.totalCalls).toBe(3);
expect(result.run.totalCost).toBe(stats.totalCost);
```

---

## Cancellation

`harness.cancel(workflowRunId, reason?)` dispatches `run.cancel`. Jobs run under the real job lease heartbeat on a short wall-clock interval (`jobHeartbeatIntervalMs`, default 10 ms), so a stage body can cancel its own run and `await` `step.abortSignal` to exercise the cancellation path:

```typescript
const { workflowRunId } = await harness.start("long-wf", {});
const first = harness.tick();            // starts executing the stage body
await harness.cancel(workflowRunId, "operator");
const report = await first;
expect(report.outcomes[0]?.outcome).toBe("failed");
expect((await harness.persistence.getRun(workflowRunId))?.status).toBe("CANCELLED");
```

---

## Advancing Time with `FakeClock`

Every port reads the harness clock, so timeouts are tested by moving it. `run()` and `tickUntil()` advance it for you to the next poll deadline; drive it by hand when you need a specific moment:

```typescript
import { FakeClock } from "@bratsos/workflow-engine/kernel/testing";

const harness = createTestHarness({
  workflows: [pollingWorkflow],
  clock: new FakeClock(new Date("2026-07-04T12:00:00.000Z")),
});

// ... a stage is suspended on ctx.step.waitFor(..., { timeout: "1h" })
harness.clock.advance(60 * 60 * 1000 + 1);
const report = await harness.tick();      // the wait is past its deadline: StepTimeoutError
```

The same applies to lease reaping: advance past `staleLeaseThresholdMs` and dispatch `lease.reapStale` to assert `{ released, expired }`.

---

## Under the hood: driving the kernel by hand

Everything the harness does is a kernel command you can dispatch yourself. `createTestKernel` (also exported from `@bratsos/workflow-engine/testing`) wires the in-memory ports; the loop below is one stage from create to completion:

```typescript
import { createTestKernel } from "@bratsos/workflow-engine/testing";

const { kernel, persistence, jobTransport: jobQueue, eventSink } = createTestKernel([testWorkflow]);

// 1. Create a workflow run
const { workflowRunId } = await kernel.dispatch({
  type: "run.create",
  idempotencyKey: "test-run-key-1",
  workflowId: "uppercase-workflow",
  input: { value: "hello world" },
});

// 2. Claim pending runs (the first-stage job is enqueued after the claim commits)
await kernel.dispatch({ type: "run.claimPending", workerId: "test-worker" });

// 3. Dequeue and execute the enqueued job
const job = await jobQueue.dequeue();
await kernel.dispatch({
  type: "job.execute",
  workflowRunId: job!.workflowRunId,
  workflowId: job!.workflowId,
  stageId: job!.stageId,
  attempt: job!.attempt,
  maxAttempts: job!.maxAttempts,
  config: {},
});
await jobQueue.complete(job!.jobId, { startedAt: job!.startedAt, attempt: job!.attempt });

// 4. Transition the workflow to evaluate outputs
const transition = await kernel.dispatch({ type: "run.transition", workflowRunId });
expect(transition.action).toBe("completed");

// 5. Verify records and events
expect((await persistence.getRun(workflowRunId))?.status).toBe("COMPLETED");
await kernel.dispatch({ type: "outbox.flush" });
expect(eventSink.events).toContainEqual(expect.objectContaining({ type: "workflow:completed" }));
```

The in-memory ports are individually exported for tests that need only one of them:

```typescript
import {
  InMemoryWorkflowPersistence,
  InMemoryJobQueue,
  InMemoryStepLedger,
  InMemoryAICallLogger,
} from "@bratsos/workflow-engine/testing";
import { FakeClock, InMemoryBlobStore, CollectingEventSink } from "@bratsos/workflow-engine/kernel/testing";
```

A context built by hand (calling `stage.execute(ctx)` directly) must provide `step`, `ai`, `aiLogger` and `abortSignal`: `createStepApi()` from `@bratsos/workflow-engine/kernel` builds a ledger-less step API that throws `StepLedgerNotConfiguredError` on use, and `new AbortController().signal` is a signal that never fires.

---

## Checking a custom adapter

`persistenceConformanceSuite`, `jobQueueConformanceSuite`, `aiCallLoggerConformanceSuite` and `stepLedgerConformanceSuite` hold a custom port implementation to the same contract as the built-in ones. See [Custom Adapters](../persistence/custom-adapters.md#conformance-testing).
