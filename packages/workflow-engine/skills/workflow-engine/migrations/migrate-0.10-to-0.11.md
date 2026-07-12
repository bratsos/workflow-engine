# Migrating from 0.10 to 0.11

## Summary

0.11 is a correctness and hardening sweep across the kernel, persistence, AI layer, and hosts. There is no schema migration, but there **are** breaking API/behavioral changes: `AIBatchResult<T>` is now a discriminated union (failed results no longer carry a fake `result`), `zod` is a required peer dependency instead of a bundled dependency, `getSuspendedJobsReadyToPoll` was removed from `JobTransport`/`JobQueue`, and `getModelProvider` now throws on an unknown provider instead of silently routing to Google. On top of that, several behavioral fixes change what you'll observe in production (promptly-failing runs, enforced `maxWaitTime`, a higher default `staleLeaseThresholdMs`) — read the **Bug fixes** section even if none of the breaking changes apply to you.

A second wave folded into this same 0.11 release removes/relocates a handful of root exports, adds a large batch of `@deprecated` markers (all still work today, all scheduled for removal at 1.0), tightens the Prisma adapters' client typing, and makes a few APIs more permissive (`KernelConfig.scheduler` is now optional, `SuspendedStateSchema` requires only `batchId`). See **Required actions**, **Deprecations**, and **Bug fixes** below for the full list.

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

- [ ] **Update imports for root exports that were removed or relocated.** Grep your codebase for each of these; none had a documented public use beyond what's noted:

  | Removed from `@bratsos/workflow-engine` root | Replacement |
  |---|---|
  | `printAvailableModels` | `listModels()` — format/print the result yourself |
  | `SerializedBatch`, `BatchMetrics` | none — provider-internal types with no documented public surface |
  | `KernelCommandType` | still exported, from `@bratsos/workflow-engine/kernel` instead of the root |
  | `KernelWorkflowRegistry` | `WorkflowRegistry`, from `@bratsos/workflow-engine/kernel` (same type, no longer aliased) |
  | `ValidateStageIds` | none — compile-time-only helper, no longer part of the public surface; `createStageIds(workflow)` derives IDs directly from a workflow instead of validating a hand-written object against one |
  | `getStageOutput` (standalone function) | `ctx.require()` inside a stage's `execute()`, or `requireStageOutput()` (deprecated, see below) outside one |
  | `NoInput` (type) | `NoInputSchema` (value), or the string literal `"none"` in `schemas.input` |
  | `StageOutputType` / `StageInputType` / `StageConfigType` | `InferStageOutput<T>` / `InferStageInput<T>` / `InferStageConfig<T>` |
  | `WorkflowBuilder.getStageCount()` / `getExecutionGroupCount()` | no direct pre-build equivalent; call `.build()` first, then `workflow.getAllStages().length` / `workflow.getExecutionPlan().length` on the resulting `Workflow` |

  Newly exported at root, no action needed: `ProviderResolver` (type), and the config-schema presets `withAIConfig`/`withConcurrency`/`withFeatureFlags`/`withStandardConfig` (see [08-common-patterns.md](../references/08-common-patterns.md#config-presets)).

- [ ] **Update hand-written/mocked Prisma clients, if any.** `PrismaWorkflowPersistence`, `PrismaJobQueue`, `PrismaAICallLogger`, and `createEnumHelper` no longer accept `prisma: any`. They now require a structural shape (`EnginePrismaClient`, exported along with `PrismaDelegate` from `@bratsos/workflow-engine/persistence/prisma`) that any real generated Prisma client (6.x or 7.x) satisfies automatically. Only a hand-written mock/fake missing a delegate the adapter actually calls (e.g. `workflowRun`, `$transaction`) would newly fail to typecheck, where it previously compiled silently under `any`. No runtime behavior change — this is compile-time only.

## New features

### `defineWorkflow({...})` options-object API

An alternative to the 5-argument `new WorkflowBuilder(id, name, description, input, output)` constructor — purely additive, you still chain `.pipe()` / `.parallel()` / `.build()` on the result. **Later in this same 0.11 release**, the positional constructor was also marked `@deprecated` in favor of this options-object form — see **Deprecations** below. `defineWorkflow` is now the recommended way to build a workflow, not merely an alternative.

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

The underlying `SuspendedStateSchema` (the Zod schema behind `ctx.resumeState` / `checkCompletion`'s `suspendedState` parameter) was relaxed to match: only `batchId` is a required field now. `submittedAt`, `pollInterval`, and `maxWaitTime` are optional on the schema itself — `defineStage()` still back-fills its resolved values onto `state` in addition to `pollConfig` (some `checkCompletion` implementations read them directly off `suspendedState`), but reading timing from `pollConfig` is preferred going forward. See **Deprecations** below.

### Curried `defineStage<TContext>()({...})`

A new call form for fixing a stage's `TContext` explicitly without spelling out all five generics positionally. Supply only `TContext`; TypeScript infers the stage's `id` (as a string literal), input, output, and config from the definition object passed to the returned function:

```typescript
type MyContext = { "previous-stage": { value: string } };

export const myStage = defineStage<MyContext>()({
  id: "my-stage",              // inferred as the literal "my-stage"
  name: "My Stage",
  schemas: { input: InputSchema, output: OutputSchema, config: ConfigSchema },
  async execute(ctx) {
    const prev = ctx.require("previous-stage"); // typed via MyContext
    return { output: { /* ... */ } };
  },
});
```

Calling `defineStage({...})` directly with no generics (the common case, letting everything infer) is unaffected — only the 5-positional-generic overloads (`defineStage<TId, TInput, TOutput, TConfig, TContext>({...})`) are superseded, and only when you need `TContext` fixed explicitly. See **Deprecations** below.

### `KernelConfig.scheduler` is now optional

The `Scheduler` port has zero call sites in the kernel (it was aspirational Phase-1 infrastructure). `scheduler` is now optional on both `KernelConfig` and `KernelDeps` — omit it and the kernel supplies its own internal no-op automatically. If you were constructing a `NoopScheduler()` (or any other `Scheduler` implementation) purely to satisfy `createKernel`, you can delete that code. See **Deprecations** below.

### New `/kernel` host-building-block and annotation exports

`@bratsos/workflow-engine/kernel` now also exports `executeJobWithHeartbeat`, `runMaintenanceTick`, and `HOST_DEFAULTS` — the shared command-dispatch sequences the Node and Serverless hosts are themselves built from (useful if you're wiring a third host onto a different queue/runtime; see [03-runtime-setup.md](../references/03-runtime-setup.md#building-a-custom-host)) — plus `toErrorMessage` (normalizes a caught `unknown` into a display string), `normalizeAnnotateArgs` (the argument-normalization `ctx.annotate(...)` uses internally), and the `AnnotationCreatedEvent` type (the outbox event shape for an annotation written with `emitEvent: true`). All purely additive.

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

Everything below still works in this version — nothing throws or breaks — but each is marked `@deprecated` in its JSDoc and scheduled for **removal at 1.0**. Grep your codebase for these symbols and migrate at your own pace; none of them require immediate action the way **Required actions** above does.

**Stage/workflow authoring:**
- `defineStage<TId, TInput, TOutput, TConfig, TContext>({...})` (the 5-positional-generic overloads) → the curried form, `defineStage<TContext>()({...})`.
- `new WorkflowBuilder(id, name, description, input, output)` (5-positional-argument constructor) → `defineWorkflow({...})`.
- `DefineWorkflowOptions.output` → omit it; decorative for any workflow with at least one piped stage.
- `Workflow.getExecutionOrder()` → `getExecutionPlan()` or `getAllStages()` for programmatic use (still fine for its original purpose, ad-hoc console logging).
- `Workflow.estimateCost()` → no direct replacement; it was always a rough, pre-execution-only estimate that can't account for real inter-stage data flow.
- `requireStageOutput()` (the standalone function exported from the package root) → `ctx.require()` inside a stage's `execute()`. `requireStageOutput` remains for code that reads `workflowContext` outside of `execute()` (e.g. shared utility functions).
- `SuspendedStateSchema`'s `submittedAt` / `pollInterval` / `maxWaitTime` fields → read the equivalent values from `pollConfig` instead; kept optional on `state` only for this deprecation window.

**Kernel:**
- `KernelConfig.scheduler` / `KernelDeps.scheduler` → omit it; the kernel supplies its own no-op.
- `NoopScheduler` (from `@bratsos/workflow-engine/kernel/testing`) → stop constructing it; just omit `scheduler` from your test kernel config.
- `JobQueue.enqueue` / `JobTransport.enqueue` → `enqueueParallel` (what the kernel actually calls, even for single-job enqueues).

**Persistence:** 15 methods across `ArtifactPersistence` (7 methods — use the `BlobStore` port instead) and 8 more legacy query methods declared directly on `WorkflowPersistence` (each with a `getRun`/`getStagesByRun`-based replacement in its JSDoc) — see [05-persistence-setup.md](../references/05-persistence-setup.md#workflowpersistence-interface) for the full interface breakdown with every replacement spelled out.

**AI helper:**
- `AIHelper.recordCall(modelKey, prompt, response, tokens, options)` (positional overload) → the object-based `recordCall({ modelKey, callType, prompt, response, inputTokens, outputTokens, metadata })`.
- `getDefaultModel`, `getRegisteredModel`, `listRegisteredModels`, `modelSupportsBatch`, `ModelStatsTracker` — tests-only helpers; prefer `registerModels()` and checking `getModel(key)`'s config directly.

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
- **`AIStreamResult.stream` no longer synthesizes a chunk.** Previously, if a model streamed nothing on the text channel (e.g. a reasoning-only response) but the AI SDK's buffered `result.text` had content once the stream finished, `.stream` would yield one synthetic chunk containing that buffered text. That fallback is gone: `.stream` is now a pure pass-through of the AI SDK's own `textStream`, so it yields an **empty** async iterable in that scenario. **If you iterate `.stream` directly** (rather than calling `getText()`) and depended on it always yielding at least one chunk, switch to `getText()` — it still reconciles against the buffered result the same way it always did, so no text answer is lost, only the synthetic mid-stream chunk.
- **`requireStageOutput()` no longer throws on legitimate falsy values.** It previously used a truthy check, so a stage output (or field) of `0`, `""`, or `false` was treated as "missing" and threw. It now checks `=== undefined` specifically, matching `ctx.require()`'s semantics. If a stage genuinely relied on the old throw-on-falsy behavior (unlikely, but possible as a workaround), that code path no longer throws.

## Custom persistence adapter authors

If you implement `JobQueue`/`WorkflowPersistence`/`AICallLogger` yourself:

- **Consider targeting `PersistenceCore` instead of `WorkflowPersistence`.** `WorkflowPersistence` (41 methods) is now `PersistenceCore` (~26 methods, everything the kernel actually calls) `& ArtifactPersistence` (7 deprecated artifact methods, unused by the kernel — use `BlobStore` instead) plus 8 more deprecated legacy query methods declared directly on `WorkflowPersistence`. This is purely additive — existing `WorkflowPersistence` implementers are unaffected — but new adapters only need to implement `PersistenceCore`. See [05-persistence-setup.md](../references/05-persistence-setup.md#workflowpersistence-interface).
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

### `defineStage` — positional generics to the curried form

```typescript
// Before: all five generics spelled out by hand
export const myStage = defineStage<
  "my-stage",
  typeof InputSchema,
  typeof OutputSchema,
  typeof ConfigSchema,
  MyContext
>({
  id: "my-stage",
  name: "My Stage",
  schemas: { input: InputSchema, output: OutputSchema, config: ConfigSchema },
  async execute(ctx) {
    const prev = ctx.require("previous-stage");
    return { output: { /* ... */ } };
  },
});

// After: only TContext is spelled out; the rest infer from the definition object
export const myStage = defineStage<MyContext>()({
  id: "my-stage",
  name: "My Stage",
  schemas: { input: InputSchema, output: OutputSchema, config: ConfigSchema },
  async execute(ctx) {
    const prev = ctx.require("previous-stage");
    return { output: { /* ... */ } };
  },
});
```

### `WorkflowBuilder` — positional constructor to `defineWorkflow`

```typescript
// Before
const workflow = new WorkflowBuilder(
  "my-workflow", "My Workflow", "Does something useful",
  InputSchema, OutputSchema,
)
  .pipe(stage1)
  .build();

// After — output omitted; it's replaced by the last piped stage's schema anyway
const workflow = defineWorkflow({
  id: "my-workflow",
  name: "My Workflow",
  description: "Does something useful",
  input: InputSchema,
})
  .pipe(stage1)
  .build();
```
