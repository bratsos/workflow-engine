# @bratsos/workflow-engine-host-remote

## 0.2.1

### Patch Changes

- Updated dependencies [8bab603]
  - @bratsos/workflow-engine@0.12.0

## 0.2.0

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

## 0.1.0

### Minor Changes

- 50ada5c: Initial release: credential-free remote activity workers.

  Run a workflow stage's `execute()` on a separate, disposable worker machine that holds no database connection and no root object-store credentials, while a trusted orchestrator owns all state and persistence.

  - **Proxy stage** (`defineRemoteStage`) + an in-process **broker** (lease / fencing token / deadline / presign) that drives the worker through the engine's existing suspend/resume — no kernel changes required for this path.
  - **HTTP transport** (`createBrokerHttpServer` + `createHttpWorkerTransport`) with bearer-token auth, so workers connect over the network from a separate process/machine.
  - **Direct-to-bucket artifacts** (`createS3Presigner` / `createS3BlobStore`; S3/R2/MinIO via SigV4): workers PUT large binary artifacts directly to object storage via presigned URLs; the broker token is never sent to the object store.
  - **Restart durability with no new DB table**: the engine's `SUSPENDED` `WorkflowStage` + a claim-checked payload are the durable anchor; the in-memory broker rehydrates on poll, with the absolute deadline preserved across restarts.
  - **Lease renewal** (heartbeat) and **durable reports** so a completed activity survives an orchestrator restart without re-running expensive work.
  - **Deploy safety** via per-task version pinning, a **prefix-validated** artifact-key boundary (confused-deputy prevention), **per-stage routing** (`createRoutingExecutor`), and a blocking `createRemoteExecutor` for the in-core `ActivityExecutor` port.

  See the package README for the full quickstart and API reference.

### Patch Changes

- Updated dependencies [50ada5c]
  - @bratsos/workflow-engine@0.10.0
