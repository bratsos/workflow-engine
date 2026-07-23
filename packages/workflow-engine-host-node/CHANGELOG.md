# @bratsos/workflow-engine-host-node

## 0.4.1

### Patch Changes

- Updated dependencies [8bab603]
  - @bratsos/workflow-engine@0.12.0

## 0.4.0

### Minor Changes

- 1645428: Correctness and hardening sweep across the kernel, persistence, AI layer, and hosts.

  **Breaking (pre-1.0 minor):**

  - `AIBatchResult<T>` is now a discriminated union: `result: T` exists only on `status: "succeeded"` (validated against the request's Zod schema); failures carry `error` and no longer return `{} as T`.
  - `zod` is now a required peer dependency of `@bratsos/workflow-engine` and `@bratsos/workflow-engine-host-remote` (previously a regular dependency).
  - Removed dead `getSuspendedJobsReadyToPoll` from `JobTransport`/`JobQueue`.
  - `getModelProvider` throws on unknown providers instead of silently routing to Google.

  **Exports:**

  - Removed from the root (`@bratsos/workflow-engine`): `printAvailableModels` (use `listModels()` and format the result yourself), `SerializedBatch`, `BatchMetrics` (provider-internal, no documented public surface), `KernelCommandType` and `KernelWorkflowRegistry` (both still available, unaliased, from `@bratsos/workflow-engine/kernel` — the latter as `WorkflowRegistry`), `ValidateStageIds` (compile-time-only, no longer publicly reachable from any entry point). Deleted entirely: `getStageOutput`, `NoInput`, the `StageOutputType`/`StageInputType`/`StageConfigType` triad (use `InferStageOutput`/`InferStageInput`/`InferStageConfig`), `WorkflowBuilder.getStageCount`/`getExecutionGroupCount`.
  - Demoted to internal (no longer re-exported from root; still used by the batch provider implementations and `./utils/batch/types` internally): `RawBatchResult`, `BatchState`, `BaseBatchRequest`, `BatchLogger`, `BatchSubmitOptions`.
  - Added to root: `ProviderResolver` (type) and the inference helpers `InferStageOutput`/`InferStageInput`/`InferStageConfig`, `InferWorkflowContext`/`InferWorkflowInput`/`InferWorkflowOutput`, and `InferStageOutputById` (previously reachable only from their source modules). The config-schema presets (`withAIConfig`/`withConcurrency`/`withFeatureFlags`/`withStandardConfig`) were already exported in 0.10 and are unchanged.
  - New from `@bratsos/workflow-engine/kernel`: `executeJobWithHeartbeat`, `runMaintenanceTick`, `HOST_DEFAULTS` — the shared command-dispatch sequences the Node/Serverless hosts are themselves built from, for anyone wiring a third host — plus `toErrorMessage`, `normalizeAnnotateArgs`, and the `AnnotationCreatedEvent` type.
  - `@deprecated` (JSDoc only, not removed — removal planned for 1.0): `ModelStatsTracker`, `getDefaultModel`, `modelSupportsBatch`, `getRegisteredModel`, `listRegisteredModels`, `Workflow.getExecutionOrder`, `Workflow.estimateCost`.

  **Kernel/host correctness:**

  - Terminal job failures now dispatch `run.transition` immediately — runs fail promptly with the real stage error instead of lingering until reaped as "stuck".
  - A FAILED stage with a retry still queued/in-flight no longer fails the whole run (parallel-group retry race fixed).
  - Zod input/config validation errors are non-retryable; error name/stack preserved in results.
  - `maxWaitTime` on suspended stages is now enforced (timeout failure instead of polling forever).
  - Already-COMPLETED stages are not re-executed by duplicate/stale-lease jobs.
  - Job enqueue and `rerunFrom` blob deletion moved after transaction commit; `run.reapStuck` recovers RUNNING runs with PENDING stages missing jobs, is version-guarded against double-reaping, and reports `transitioned` truthfully.
  - `run.rerunFrom` supports idempotency keys; stuck `in_progress` idempotency keys are reclaimable after a configurable TTL (`idempotencyStaleInProgressMs`, default 10 min).
  - Outbox flush preserves per-run event ordering on failure; suspended job rows are completed on resume; `workflow:suspended` is now emitted.
  - Hosts heartbeat job leases while executing (`jobHeartbeatIntervalMs`, default 60s) and default `staleLeaseThresholdMs` raised 60s → 300s.
  - Missing previous-group output fails the stage loudly instead of silently substituting the workflow input.
  - `KernelConfig.scheduler` (and `KernelDeps.scheduler`) is now optional — the `Scheduler` port has zero call sites in the kernel (it was aspirational Phase-1 infrastructure); omit it and the kernel supplies its own internal no-op. `NoopScheduler` (from `@bratsos/workflow-engine/kernel/testing`) is `@deprecated` accordingly.

  **Persistence:**

  - Fixed `claimNextPendingRunPostgres` enum cast (`::"Status"`) — claiming failed on real Postgres.
  - In-memory and Prisma adapters reconciled: identical version-bump, suspended-readiness, retry-default, ordering, artifact and undefined-field semantics; version now increments on every update/claim.
  - `dequeue` rethrows DB errors instead of masking a dead database as an empty queue; claim/dequeue contention retries are bounded; outbox sequence assignment is safe outside transactions via unique-constraint retry.
  - Conformance suites exported from `@bratsos/workflow-engine/testing` for third-party adapters; the Postgres conformance job now runs the _same_ published suite (persistence + job queue + AI call logger, ~100 tests) against a real database instead of ~10 hand-rolled smoke tests, plus a kernel-level end-to-end smoke test (`createKernel` wired to the real Prisma adapters, driven the way a host drives it). Fixed two adapter inconsistencies this caught: `PrismaWorkflowPersistence.getFirstFailedStage` sorted `executionGroup` descending (returning the _last_ failed stage, not the first — opposite of `InMemoryWorkflowPersistence`); `getFirstSuspendedStageReadyToResume`/`getLastCompletedStage`/`getLastCompletedStageBefore` had no `stageNumber` tiebreak, so ordering among stages sharing an `executionGroup` was undefined on Postgres. Both are on methods with no kernel call site (see below) but are real behavior differences for direct callers. Each suite's `beforeEach` resets fixtures via an async `reset()` when the adapter provides one (e.g. a real database's `TRUNCATE`), falling back to synchronous `clear()` otherwise; `vitest` (`>=3.0.0`) is now an optional peer dependency of `@bratsos/workflow-engine` since the conformance suites use its `describe`/`it`/`expect`.
  - New `PersistenceCore` (the ~26 methods the kernel actually calls) and `ArtifactPersistence` (7 artifact/blob methods, unused by the kernel — artifact I/O goes through `BlobStore`) interfaces exported from `@bratsos/workflow-engine/persistence`; `WorkflowPersistence` now `extends PersistenceCore, ArtifactPersistence` (plus a handful of legacy query methods) — additive, existing implementers/consumers unaffected. The kernel's `Persistence` port (`@bratsos/workflow-engine/kernel`) now derives from `PersistenceCore` instead of hand-duplicating ~54 lines of signatures, which _loosens_ what `createKernel` requires (non-breaking) — 8 unused query methods are no longer part of the port's declared surface.
  - 15 methods with zero kernel call sites are now `@deprecated` (JSDoc only, not removed — removal planned for 1.0): the artifact family + `saveStageOutput` (use `BlobStore`), and 8 query methods (`getRunsByStatus`, `claimPendingRun`, `updateStageByRunAndStageId`, `getStageById`, `getFirstSuspendedStageReadyToResume`, `getFirstFailedStage`, `getLastCompletedStage`, `getLastCompletedStageBefore` — each JSDoc points at its `getRun`/`getStagesByRun`-based replacement). `JobQueue.enqueue`/`JobTransport.enqueue` are likewise deprecated in favor of `enqueueParallel`.
  - **Breaking for TypeScript consumers (parameter narrowing):** `PrismaWorkflowPersistence`, `PrismaJobQueue`, `PrismaAICallLogger`, and `createEnumHelper` no longer accept `prisma: any`. They now require a structural `EnginePrismaClient` shape (exported, along with `PrismaDelegate`, from `@bratsos/workflow-engine/persistence/prisma`) — any real generated Prisma client (6.x or 7.x) satisfies it automatically; only hand-written mocks/fakes missing delegates the adapter actually calls would now fail to typecheck. No runtime behavior change.
  - `InMemoryWorkflowPersistence`/`InMemoryJobQueue` (from `@bratsos/workflow-engine/testing`) accept an optional injected clock (`{ now?: () => Date }`) for deterministic timestamps in tests; constructors remain backward compatible (`new InMemoryJobQueue()` / `new InMemoryJobQueue("worker-id")` unchanged). `InMemoryJobQueue.dequeue` and `InMemoryWorkflowPersistence.listAnnotations` now break same-timestamp ties with an explicit insertion sequence instead of relying on `Array.prototype.sort` stability (job queue) or a random-UUID `id` compare that carried no chronological meaning (annotations, unlike Prisma's roughly-chronological CUIDs).
  - New conformance coverage (both adapters): `touchJob` (advances `lockedAt`; a heartbeated job survives `releaseStaleJobs` while an untouched stale one is reclaimed) and a full annotation-operations block (append/list, ordering, idempotency-key dedup, all `AnnotationFilters` fields) — previously untested by the shared suite.

  **AI layer:**

  - Batch structured output: JSON schema is sent to providers (native `responseJsonSchema` on Google) and results validated; Google batch uses `systemInstruction`/`generationConfig` instead of prompt text; OpenAI batch uses `max_completion_tokens`.
  - Tool-call executions no longer double-count tokens/cost in aggregated stats; streamed calls always persist a call log via `onFinish`.
  - `maxRetries`/`abortSignal` exposed on text/object/stream options; multi-text `embed()` uses `embedMany`.
  - `AIStreamResult.stream` no longer synthesizes a fallback chunk: previously, if a model streamed nothing on the text channel (e.g. a reasoning-only response) but the AI SDK's buffered `result.text` had content once the stream finished, `.stream` yielded one synthetic chunk containing that text. That's gone — `.stream` is now a pure pass-through of the AI SDK's own `textStream`, so it yields an empty async iterable in that case. `getText()` is unaffected: it still reconciles against the buffered result, so no text answer is lost. Positional `recordCall(modelKey, prompt, response, tokens, options)` is `@deprecated` in favor of the object-based `recordCall(params)`.

  **Remote host:**

  - Workers honor the broker's heartbeat cancel signal (skip doomed reports), surface loop errors via `onError` with exponential backoff, and the broker returns an error instead of minting unusable blob URLs when `publicBaseUrl` is missing.

  **DX:** `defineWorkflow()` is now the recommended way to build a workflow (the positional `WorkflowBuilder` constructor is `@deprecated` in its favor), `onProgress` auto-fills stage identity, async-batch `pollConfig` derived from state — and the underlying `SuspendedStateSchema` now requires only `batchId`, with `submittedAt`/`pollInterval`/`maxWaitTime` optional and back-filled onto `state` during a deprecation window — curried `defineStage<TContext>()({...})` is the new recommended form for stages that need a typed context (the 5-positional-generic overloads are `@deprecated`), `requireStageOutput()` no longer throws on falsy-but-present values (`0`/`""`/`false`, matching `ctx.require()`'s semantics) and is itself `@deprecated` in favor of `ctx.require()`, `parallel()` context types no longer collapse to unions, tests included in typecheck, corrected README Prisma schema (`@@map`), export drift fixed (`RunReapStuckCommand`, `ModelFilter`).

### Patch Changes

- Updated dependencies [1645428]
  - @bratsos/workflow-engine@0.11.0

## 0.3.3

### Patch Changes

- Updated dependencies [50ada5c]
  - @bratsos/workflow-engine@0.10.0

## 0.3.2

### Patch Changes

- Updated dependencies [853e636]
  - @bratsos/workflow-engine@0.9.0

## 0.3.1

### Patch Changes

- Updated dependencies [d94cfc4]
  - @bratsos/workflow-engine@0.8.0

## 0.3.0

### Minor Changes

- ce523b7: feat: CLI consumer improvements — runAndWait, metadata fix, providerResolver, skipInteractiveTransactions

  - **runAndWait()**: New convenience function in `@bratsos/workflow-engine-host-node` that dispatches a workflow run and polls until terminal state. Handles host lifecycle, abort signals, and stage change callbacks.
  - **Metadata stored as JSON**: `CreateRunInput.metadata` is now stored as a JSON column on WorkflowRun instead of being spread as flat Prisma fields. This fixes Prisma v7 compatibility where spread FK fields caused runtime errors. **Breaking:** consumers that relied on metadata spreading must update their callers to set relations explicitly after run creation.
  - **ProviderResolver**: `createAIHelper()` accepts an optional 4th argument `providerResolver: (modelConfig) => LanguageModelV1 | null` for custom per-model provider routing. Propagated to child helpers.
  - **skipInteractiveTransactions**: `createPrismaWorkflowPersistence()` accepts `{ skipInteractiveTransactions: true }` to bypass Prisma `$transaction()` wrappers in single-process environments where interactive transactions cause cross-connection deadlocks.

### Patch Changes

- Updated dependencies [ce523b7]
  - @bratsos/workflow-engine@0.7.0

## 0.2.10

### Patch Changes

- c52282e: feat: audit-driven correctness and API improvements

  - **Typed stage IDs**: `defineStage` and `defineAsyncBatchStage` now infer literal `TId` generics from the `id` field, enabling type-safe `ctx.require()` and `ctx.optional()` calls
  - **Parallel output keying**: `.parallel()` merged outputs are now keyed by stage ID instead of numeric indices, matching the builder's type-level contract
  - **Final run output**: Completed workflows persist their final output in `WorkflowRun.output` and include it in the `workflow:completed` event
  - **Authoritative cancellation**: `run.cancel` cascades to all non-terminal stages and queued jobs via `cancelByRun()`. `stage.pollSuspended` skips cancelled runs. `job.execute` re-checks run status after execution with a typed `ghost: true` flag
  - **Retry semantics alignment**: In-memory job queue now matches Prisma's "increment on dequeue" pattern (initial attempt=0, first delivery returns attempt=1)
  - **BlobStore-only artifacts**: Removed legacy `StorageFactory`, `MemoryStorage`, and `PrismaStorage`. `run.rerunFrom` uses prefix-based blob cleanup
  - **Public API cleanup**: Removed deprecated SSE event types, status aliases (`WorkflowStatus`, `WorkflowStageStatus`, `JobStatus`), batch aliases (`BatchHandle`, `BatchProvider`, `BatchRequest`, `BatchResult`), and deprecated `ModelStatsTracker` methods. Added `createStageIds`, `defineStageIds`, `isValidStageId`, `assertValidStageId` exports
  - **Clean-checkout tooling**: Host packages now resolve `@bratsos/workflow-engine` source via TS path mappings and Vitest aliases, so `typecheck` and `test` work without a prebuild

- Updated dependencies [c52282e]
  - @bratsos/workflow-engine@0.6.0

## 0.2.9

### Patch Changes

- Updated dependencies [51ede14]
  - @bratsos/workflow-engine@0.5.1

## 0.2.8

### Patch Changes

- Updated dependencies [fee7d83]
  - @bratsos/workflow-engine@0.5.0

## 0.2.7

### Patch Changes

- fe65b06: Fix reliability issues: idempotent stage creation (prevents P2002 loops), ghost job detection with no-retry in hosts, per-run error isolation in claimPending, stuck run detection via run.reapStuck with race condition guard, and orchestration tick step isolation.
- Updated dependencies [fe65b06]
  - @bratsos/workflow-engine@0.4.1

## 0.2.6

### Patch Changes

- b83ecb1: Republish host packages with resolved workspace dependencies and repository.url for provenance

## 0.2.5

### Patch Changes

- f456a5f: Fix release script to use pnpm -r publish so workspace:\* dependencies are resolved to actual versions at publish time

## 0.2.4

### Patch Changes

- Updated dependencies [3b07f56]
  - @bratsos/workflow-engine@0.4.0

## 0.2.3

### Patch Changes

- Updated dependencies [579106e]
  - @bratsos/workflow-engine@0.3.0

## 0.2.2

### Patch Changes

- d824b47: Fix publishing for host packages to npm registry

## 0.2.1

### Patch Changes

- Updated dependencies [71b84a9]
  - @bratsos/workflow-engine@0.2.1

## 0.2.0

### Minor Changes

- e3b8cb4: Command kernel API migration: pure command dispatcher with typed handlers, transactional outbox, idempotency, optimistic concurrency, DLQ support, and host packages for Node.js and serverless environments.

### Patch Changes

- Updated dependencies [e3b8cb4]
  - @bratsos/workflow-engine@0.2.0
