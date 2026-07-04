# Migrating from 0.10 to 0.11

## Summary

0.11 is a correctness and hardening sweep across the kernel, persistence, AI layer, and hosts. There is no schema migration, but there **are** breaking API/behavioral changes: `AIBatchResult<T>` is now a discriminated union (failed results no longer carry a fake `result`), `zod` is a required peer dependency instead of a bundled dependency, `getSuspendedJobsReadyToPoll` was removed from `JobTransport`/`JobQueue`, and `getModelProvider` now throws on an unknown provider instead of silently routing to Google. On top of that, several behavioral fixes change what you'll observe in production (promptly-failing runs, enforced `maxWaitTime`, a higher default `staleLeaseThresholdMs`) — read the **Bug fixes** section even if none of the breaking changes apply to you.

## Required actions

- [ ] **Install `zod` explicitly.** `@bratsos/workflow-engine` and `@bratsos/workflow-engine-host-remote` moved `zod` from a regular dependency to a `peerDependency` (`^4.1.12`). If your project doesn't already depend on `zod` directly, add it:
  ```bash
  pnpm add zod
  # or: npm install zod / yarn add zod / bun add zod
  ```
  Without this, install will warn (or fail, under strict peer-dependency settings) and any import of `zod` re-exported transitively may resolve to nothing.

- [ ] **Update batch-result consumers for the new discriminated union.** `AIBatchResult<T>` no longer has `result` on failed items — see [Code examples](#code-examples) below. Grep for `.getResults(` and `batch.getResults` call sites and check every place that reads `.result` without first checking `status`.

- [ ] **Drop `getSuspendedJobsReadyToPoll` from custom adapters.** If you implement `JobTransport`/`JobQueue` yourself (not using the built-in Prisma or in-memory adapters), remove this method — it was dead code and is no longer part of the interface. No replacement is needed; nothing in the kernel called it.

- [ ] **Handle `getModelProvider` throwing on unknown providers.** If you register custom models with a `provider` value other than `"openrouter"` or `"google"` and don't supply a `providerResolver`, calls now throw `Unsupported provider "..." for model "..."` instead of silently using Google's client (which would previously have produced confusing wrong-provider errors downstream, or worse, silently used the wrong billing/behavior). Either register a `providerResolver`, or make sure `provider` matches a built-in value or a provider registered via `registerEmbeddingProvider`.

## New features

### `defineWorkflow({...})` options-object API

An alternative to the 5-argument `new WorkflowBuilder(id, name, description, input, output)` constructor. Purely additive — you still chain `.pipe()` / `.parallel()` / `.build()` on the result.

```typescript
import { defineWorkflow } from "@bratsos/workflow-engine";

const workflow = defineWorkflow({
  id: "my-workflow",
  name: "My Workflow",
  description: "Does something useful",
  input: InputSchema,
  // `output` is optional — it's only the builder's *initial* output type
  // before any stages are piped, and gets replaced by the last piped
  // stage's output schema at `.build()`, same as the positional API.
})
  .pipe(stage1)
  .pipe(stage2)
  .build();
```

### `onProgress` auto-fills `stageId` / `stageName`

`ctx.onProgress(...)` inside `execute()` no longer requires `stageId`/`stageName` — the engine fills them in from the current stage automatically. You can still pass them to override.

```typescript
// Before: had to repeat stageId/stageName on every call
ctx.onProgress({
  stageId: ctx.stageId,
  stageName: "My Stage",
  progress: 50,
  message: "Halfway done",
});

// Now: both are optional
ctx.onProgress({ progress: 50, message: "Halfway done" });
```

### `defineAsyncBatchStage` — `pollConfig` derived from `state`

`SimpleSuspendedResult.pollConfig` is now fully optional, and only `state.batchId` is required. `submittedAt`, `pollInterval`, `maxWaitTime`, and the entire `pollConfig` block (including `nextPollAt`) are derived when omitted (defaults: 30s poll interval, 24h max wait).

```typescript
// Before: had to compute pollConfig by hand
return {
  suspended: true,
  state: { batchId, submittedAt: new Date().toISOString(), pollInterval: 60000, maxWaitTime: 3600000 },
  pollConfig: { pollInterval: 60000, maxWaitTime: 3600000, nextPollAt: new Date(Date.now() + 60000) },
};

// Now: minimal form — batchId is the only required field
return { suspended: true, state: { batchId } };

// Or override just what you need — pollConfig is derived from state
return {
  suspended: true,
  state: { batchId, pollInterval: 60000, maxWaitTime: 3600000 },
};
```

### AI helper: `maxRetries` / `abortSignal`, `embedMany`-backed multi-text embed

`TextOptions`, `ObjectOptions`, and `StreamOptions` all gained `maxRetries?: number` and `abortSignal?: AbortSignal`, forwarded straight to the AI SDK call:

```typescript
const controller = new AbortController();
const { text } = await ai.generateText("gemini-2.5-flash", prompt, {
  maxRetries: 2,
  abortSignal: controller.signal,
});
```

Multi-text `ai.embed(model, ["a", "b", "c"])` now calls the AI SDK's `embedMany()` instead of looping `embed()` per text — same public result shape (`{ embedding, embeddings, dimensions, inputTokens, cost }`), just one round-trip instead of N.

### Batch schema validation + cross-process `getResults(batchId, { schemas })`

Requests submitted with a `schema` now have their JSON output validated against it — a response that fails validation shows up as `status: "failed"` rather than an unvalidated blob. Because a `z.ZodTypeAny` isn't serializable, the schema only survives for the lifetime of the `AIBatch` instance that called `submit()`. If you check results in a different process/invocation (e.g. after a workflow suspend/resume), re-supply the schemas:

```typescript
// submit() in process A, with schemas
const handle = await batch.submit([
  { id: "req-1", prompt: "...", schema: ItemSchema },
]);

// getResults() in process B (e.g. checkCompletion after resume) —
// re-supply the same schemas keyed by request id/customId
const results = await batch.getResults(handle.id, {
  schemas: { "req-1": ItemSchema },
});
```

### `KernelConfig.idempotencyStaleInProgressMs`

Guards against a dispatcher crashing between committing its transaction and calling `completeIdempotencyKey`, which would otherwise leave an idempotency key stuck `in_progress` forever (every future dispatch with that key throws `IdempotencyInProgressError`). Defaults to 10 minutes; set to `Infinity` to disable reclaiming.

```typescript
const kernel = createKernel({
  ...,
  idempotencyStaleInProgressMs: 10 * 60 * 1000, // default; tune per your workload
});
```

### Host tuning: `jobHeartbeatIntervalMs`, new `staleLeaseThresholdMs` default

Both `createNodeHost` and `createServerlessHost` gained `jobHeartbeatIntervalMs` (default `60_000`) — hosts now heartbeat a job's lease while it's executing, so a long-running stage no longer looks stale to `lease.reapStale`. `staleLeaseThresholdMs`'s default changed from `60_000` to `300_000` to give the heartbeat room. If you were relying on the old 60s default, pass it explicitly:

```typescript
const host = createNodeHost({
  kernel,
  jobTransport,
  workerId: "worker-1",
  jobHeartbeatIntervalMs: 60_000, // new; default shown
  staleLeaseThresholdMs: 60_000,  // pass explicitly to keep the old 0.10 default
});
```

### `@bratsos/workflow-engine-host-remote`: `onError` / `maxBackoffMs`

`createActivityWorker` gained `onError` (called whenever `processOne()` throws; defaults to `console.error`, so failures are never silently swallowed) and `maxBackoffMs` (caps the exponential backoff the worker applies between consecutive failures; default `30_000`):

```typescript
const worker = createActivityWorker({
  registry, transport, workerId: "worker-1", stageIds: ["heavy"], stageCodeVersion: "v1",
  onError: (error, { consecutiveFailures }) => {
    logger.error("activity worker error", { error, consecutiveFailures });
  },
  maxBackoffMs: 30_000,
});
```

Workers also now honor the broker's heartbeat cancel signal: if a task's lease is fenced or reaped mid-run, the worker skips the presign/report round-trip once the activity finishes, instead of attempting a doomed report against a lease that's gone.

### Exported conformance suites for custom adapters

`@bratsos/workflow-engine/testing` now exports vitest-based conformance suites so third-party persistence/job-queue/AI-logger adapters can be validated against the same behavior as the built-in Prisma and in-memory implementations. See the "Custom persistence adapter authors" section below.

### `run.rerunFrom` idempotency key

```typescript
await kernel.dispatch({
  type: "run.rerunFrom",
  workflowRunId: "run-123",
  fromStageId: "summarize",
  idempotencyKey: "rerun-run-123-summarize-1", // optional — replay returns the cached result
});
```

### `RunReapStuckCommand`, `RunReapStuckResult`, `ModelFilter` now exported

Export-drift fix: these types are dispatched/used already (`run.reapStuck`, `listModels({ filter })`) but weren't reachable from the package root. Now `import { RunReapStuckCommand, RunReapStuckResult, ModelFilter } from "@bratsos/workflow-engine"` works.

## Deprecations

None.

## Bug fixes

These are behavioral changes, not API changes — nothing to edit in your code, but they change what you'll observe:

- **Terminal failures fail runs promptly.** A stage failure now dispatches `run.transition` immediately, so the run fails with the real stage error right away instead of sitting `RUNNING` until `run.reapStuck` eventually reaps it as `STUCK_RUN_REAPED`.
- **A `FAILED` stage with a retry still queued/in-flight no longer fails the whole run** (a parallel-group retry race is fixed).
- **Zod input/config validation errors are non-retryable.** Previously a validation error could be retried like a transient failure; now it fails the stage immediately (error name/stack preserved).
- **`maxWaitTime` on suspended stages is now enforced.** Before 0.11 it was silently ignored — a suspended stage would poll forever. **If any of your async-batch stages relied on unbounded polling (an implicit "poll forever"), they will now time out and fail once `maxWaitTime` elapses.** Audit your `maxWaitTime` values and raise them if they were set to something short "because it didn't matter."
- **Already-`COMPLETED` stages are not re-executed** by duplicate/stale-lease jobs.
- **`staleLeaseThresholdMs` default raised from 60s to 300s** (see "New features" above for the accompanying heartbeat).
- **`version` now increments on every update**, whether or not the caller passes `expectedVersion`. If you have custom code that does version arithmetic (e.g. assuming `version` only bumps on a specific field change), re-read the persisted value instead of computing it locally.
- **`JobQueue.fail` defaults `shouldRetry` to `false` everywhere.** If you call `jobTransport.fail(jobId, error)` directly (custom hosts/tooling) and expect a retry, pass `shouldRetry: true` explicitly.
- **`dequeue` rethrows DB errors** instead of masking a dead database as an empty queue. Custom hosts that call a `JobQueue`/`JobTransport` implementation's `dequeue()` directly must handle the rejection (built-in Node/Serverless hosts already treat it as a non-fatal, back-off-and-retry path).
- Missing previous-group output now fails the stage loudly instead of silently substituting the workflow input.
- `run.rerunFrom` blob-artifact deletion and job enqueue now happen after transaction commit (was previously interleaved).

## Custom persistence adapter authors

If you implement `JobQueue`/`WorkflowPersistence`/`AICallLogger` yourself:

- **Drop `getSuspendedJobsReadyToPoll`** — removed from the interface, nothing calls it.
- **Implement two new additive `JobQueue` methods:**
  ```typescript
  interface JobQueue {
    // ...existing methods...
    getJobsByWorkflowRun(workflowRunId: string): Promise<JobRecord[]>;
    touchJob(jobId: string): Promise<void>; // refreshes a job's lease timestamp (heartbeat)
  }
  ```
- **`acquireIdempotencyKey` gained optional reclaim options:**
  ```typescript
  acquireIdempotencyKey(
    key: string,
    commandType: string,
    options?: { now?: Date; staleInProgressAfterMs?: number },
  ): Promise<
    | { status: "acquired" }
    | { status: "replay"; result: unknown }
    | { status: "in_progress" }
  >;
  ```
  When `staleInProgressAfterMs` is supplied, a key stuck `in_progress` for at least that long (measured against `options.now`) may be reclaimed atomically instead of throwing `IdempotencyInProgressError` forever. The kernel passes this automatically via `KernelConfig.idempotencyStaleInProgressMs`.
- **Validate your adapter against the new conformance suites** instead of hand-rolling parity tests:
  ```typescript
  import {
    persistenceConformanceSuite,
    jobQueueConformanceSuite,
    aiCallLoggerConformanceSuite,
  } from "@bratsos/workflow-engine/testing";

  // Call from inside a vitest test file — each registers describe/it blocks as a side effect
  persistenceConformanceSuite("MyCustomPersistence", () => new MyCustomPersistence());
  jobQueueConformanceSuite("MyCustomJobQueue", () => new MyCustomJobQueue());
  aiCallLoggerConformanceSuite("MyCustomAICallLogger", () => new MyCustomAICallLogger());
  ```

## Code examples

### `AIBatchResult<T>` discriminated union

```typescript
// Before (0.10 and earlier): result always present, even on failure (as `{} as T`)
const results = await batch.getResults(batchId);
for (const r of results) {
  console.log(r.result); // garbage/empty object on a failed request
  if (r.status === "failed") console.log(r.error);
}

// After (0.11): result only exists on a succeeded item; check status first
const results = await batch.getResults(batchId);
for (const r of results) {
  if (r.status === "succeeded") {
    console.log(r.result); // validated T
  } else {
    console.log(r.error); // string — r.result doesn't exist on this branch
  }
}

// Filtering pattern
const succeeded = results.filter(
  (r): r is Extract<typeof r, { status: "succeeded" }> => r.status === "succeeded",
);
const failed = results.filter((r) => r.status === "failed");
```

### `zod` peer dependency

```jsonc
// package.json — add zod as a direct dependency if you don't already have it
{
  "dependencies": {
    "@bratsos/workflow-engine": "^0.11.0",
    "zod": "^4.1.12"
  }
}
```

### Custom `JobTransport` — drop the removed method, add the new ones

```typescript
// Before
class MyJobQueue implements JobQueue {
  // ...
  async getSuspendedJobsReadyToPoll(before: Date) { /* dead code, remove */ }
}

// After
class MyJobQueue implements JobQueue {
  // ...
  async getJobsByWorkflowRun(workflowRunId: string) { /* ... */ }
  async touchJob(jobId: string) { /* refresh lease timestamp */ }
}
```
