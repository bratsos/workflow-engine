# @bratsos/workflow-engine

## 0.12.0

### Minor Changes

- 8bab603: Upgraded the AI SDK from v6 to v7 (`ai@7`, `@ai-sdk/provider@4`, `@ai-sdk/google@4`, `@openrouter/ai-sdk-provider@3`).

  **Breaking (TypeScript-only, no runtime behavior change):**

  - `ProviderResolver` and `registerEmbeddingProvider()` now type against `LanguageModelV4`/`EmbeddingModelV4` (from `@ai-sdk/provider`) instead of V3. Custom providers passed in must satisfy the v7 provider interface.
  - `TextOptions.experimental_output` renamed to `output` (matches the AI SDK's own hard rename - there is no deprecated alias).
  - `onStepFinish` renamed to `onStepEnd` on `TextOptions`, `ObjectOptions`, and `StreamOptions` (aligns with the AI SDK's v7 canonical name; `onStepFinish` still works on the underlying SDK call as a deprecated alias, but our option types now only expose the new name).
  - `StreamTextInput.system` renamed to `instructions` (aligns with `streamText`'s v7 canonical input field).

  The batch API (`ai.batch()`, `AIBatchRequest`, and the Google/Anthropic/OpenAI batch providers) is unaffected - its `system` field is unrelated to `streamText` and was left untouched. Cost/usage calculation behavior is unchanged.

## 0.11.0

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

## 0.10.0

### Minor Changes

- 50ada5c: Adds the `ActivityExecutor` kernel port with a default `LocalExecutor` (backward-compatible; default behavior unchanged).

  The `ActivityExecutor` port (`src/kernel/ports.ts`) lets the kernel's `job.execute` handler delegate stage execution to an injected implementation. The default `LocalExecutor` replicates today's in-process behavior byte-for-byte — no behavior change for existing consumers.

  Also exports `createLocalExecutor` and `createRoutingExecutor` from `@bratsos/workflow-engine/kernel` so that `@bratsos/workflow-engine-host-remote` can inject a `RemoteExecutor` (or a `RoutingExecutor` that routes specific stage IDs remotely and all others locally) without touching the kernel internals.

  The port is designed so that `@bratsos/workflow-engine-host-remote`'s `createRemoteExecutor` can implement it directly: submit work to a broker, block until the worker reports, and return an `ActivityRunResult`. This is the executor-port phase of the remote-activity-workers design.

## 0.9.0

### Minor Changes

- 853e636: Support reasoning models in the AI helper: per-call `providerOptions` passthrough and reasoning-channel access.

  Reasoning models (e.g. `anthropic/claude-opus-4.x`, OpenRouter reasoning models) emit on a separate reasoning channel. Previously they could not be used as writers through `generateText()` / `streamText()`: the text channel was empty, there was no per-call lever to control reasoning, and the engine surfaced only the text stream — so reasoning-only output looked like "no output generated" and failed the stage.

  **`providerOptions` passthrough (gap #1)**

  `generateText`, `generateObject`, and `streamText` now forward `options.providerOptions` to the AI SDK — matching `embed`, which already did. This is the standard per-call lever to control reasoning, e.g. `{ anthropic: { thinking: { type: "disabled" } } }` or `{ openrouter: { reasoning: { enabled: false } } }`. It complements the existing global `providerResolver` hook (which is fixed at provider-creation time and cannot vary per call). `TextOptions`, `ObjectOptions`, and `StreamOptions` all gained the field.

  **Reasoning-channel access (gap #2)**

  - `AITextResult.reasoning?: string` — `generateText`/`generateObject` surface the model's reasoning text when present.
  - `AIStreamResult.getText(): Promise<string>` — the full answer text, reconciled with the buffered result so a non-incrementally-streamed answer isn't lost. Empty for a reasoning-only response.
  - `AIStreamResult.getReasoning(): Promise<string | undefined>` — the reasoning text. The streamed `.stream` continues to carry only the answer channel; reasoning stays separate.
  - When the text channel streams nothing, the engine falls back to the buffered `result.text` before treating the stream as empty.

  All additions are backward-compatible (new optional option fields, new result fields, new methods). No schema change.

  > Note: reasoning tokens count against `maxTokens` (`maxOutputTokens`). If the budget is too small, a model can spend it all reasoning and emit no answer — raise `maxTokens` or disable reasoning via `providerOptions`. See `skills/workflow-engine/references/04-ai-integration.md` (“Reasoning Models & Provider Options”).

## 0.8.0

### Minor Changes

- d94cfc4: Add `WorkflowAnnotation` — a first-class, queryable provenance surface inspired by OpenTelemetry semantic conventions.

  **New API**

  - `ctx.annotate(key, value, opts?)` inside a stage's `execute()` or `checkCompletion()` — durable, buffered, flushed atomically with the stage outcome (not fire-and-forget). Supports a TypedKey form, a string-key form, and a batch form.
  - `annotations: [...]` on `RunCreateCommand` — capture trigger context atomically with run creation.
  - `kernel.annotations.attach(workflowRunId, input)` — single-transaction external attach for plugins, post-hoc reviews, or audit annotations.
  - `kernel.annotations.list(workflowRunId, filters?)` — queryable timeline with filters for `key`, `keyPrefix`, `scope`, `scopeId`, `actorId`, `actorKind`, `attempt`, `since`/`until`, `limit`.
  - New subpath `@bratsos/workflow-engine/conventions` — typed-key registry: `Trigger.*`, `Decision.*`, `Approval.*`, `Revision.*`. `typedKey<T>(name, meta?)` helper lets consumers define org-local conventions with the same value-type linkage.

  **Schema migration required**

  Add the `WorkflowAnnotation` model and the `annotations` back-relations on `WorkflowRun` and `WorkflowStage`. See `skills/workflow-engine/migrations/migrate-0.7-to-0.8.md` for the exact Prisma snippet and the documentation fix for the previously-undocumented `AICall.metadata` column.

  **Deprecations**

  - `RunCreateCommand.metadata` is `@deprecated` in 0.8 and removed in 1.0. Existing rows with populated `WorkflowRun.metadata` are automatically surfaced as virtual `legacy.metadata.*` annotations when `kernel.annotations.list(runId)` is called (lazy read-side shim, no dual-write).

  **Additional v0.8 features**

  - **`attempt` auto-increment on rerun.** `run.rerunFrom` assigns a fresh `attempt` to recreated stages so annotations from prior attempts (preserved via `onDelete: SetNull` on the WorkflowStage FK) are distinguishable from new ones. Filterable via `kernel.annotations.list(runId, { attempt })`.
  - **Opt-in outbox emission for annotations.** Pass `emitEvent: true` on any annotation write and the engine writes an `annotation:created` outbox event in the same transaction, routed through the existing event sink for plugin subscriptions.
  - **Cancellation tightened across stage Phase 3 transactions.** A `run.cancel` committing between the kernel's outer ghost check and a stage's Phase 3 transaction now triggers an in-transaction status guard that rolls back the stage update, annotations, and outbox events atomically. Same protection added to the suspended-stage poll path. Pre-existing race; annotations inherit the fix.

  **Notes**

  - `value` is `unknown`-typed; the scalar/array convention is documented but not runtime-enforced. Use the `payload` slot for blobs.

  See `docs/RFC-ANNOTATIONS.md` for the full design rationale.

## 0.7.0

### Minor Changes

- ce523b7: feat: CLI consumer improvements — runAndWait, metadata fix, providerResolver, skipInteractiveTransactions

  - **runAndWait()**: New convenience function in `@bratsos/workflow-engine-host-node` that dispatches a workflow run and polls until terminal state. Handles host lifecycle, abort signals, and stage change callbacks.
  - **Metadata stored as JSON**: `CreateRunInput.metadata` is now stored as a JSON column on WorkflowRun instead of being spread as flat Prisma fields. This fixes Prisma v7 compatibility where spread FK fields caused runtime errors. **Breaking:** consumers that relied on metadata spreading must update their callers to set relations explicitly after run creation.
  - **ProviderResolver**: `createAIHelper()` accepts an optional 4th argument `providerResolver: (modelConfig) => LanguageModelV1 | null` for custom per-model provider routing. Propagated to child helpers.
  - **skipInteractiveTransactions**: `createPrismaWorkflowPersistence()` accepts `{ skipInteractiveTransactions: true }` to bypass Prisma `$transaction()` wrappers in single-process environments where interactive transactions cause cross-connection deadlocks.

## 0.6.0

### Minor Changes

- c52282e: feat: audit-driven correctness and API improvements

  - **Typed stage IDs**: `defineStage` and `defineAsyncBatchStage` now infer literal `TId` generics from the `id` field, enabling type-safe `ctx.require()` and `ctx.optional()` calls
  - **Parallel output keying**: `.parallel()` merged outputs are now keyed by stage ID instead of numeric indices, matching the builder's type-level contract
  - **Final run output**: Completed workflows persist their final output in `WorkflowRun.output` and include it in the `workflow:completed` event
  - **Authoritative cancellation**: `run.cancel` cascades to all non-terminal stages and queued jobs via `cancelByRun()`. `stage.pollSuspended` skips cancelled runs. `job.execute` re-checks run status after execution with a typed `ghost: true` flag
  - **Retry semantics alignment**: In-memory job queue now matches Prisma's "increment on dequeue" pattern (initial attempt=0, first delivery returns attempt=1)
  - **BlobStore-only artifacts**: Removed legacy `StorageFactory`, `MemoryStorage`, and `PrismaStorage`. `run.rerunFrom` uses prefix-based blob cleanup
  - **Public API cleanup**: Removed deprecated SSE event types, status aliases (`WorkflowStatus`, `WorkflowStageStatus`, `JobStatus`), batch aliases (`BatchHandle`, `BatchProvider`, `BatchRequest`, `BatchResult`), and deprecated `ModelStatsTracker` methods. Added `createStageIds`, `defineStageIds`, `isValidStageId`, `assertValidStageId` exports
  - **Clean-checkout tooling**: Host packages now resolve `@bratsos/workflow-engine` source via TS path mappings and Vitest aliases, so `typecheck` and `test` work without a prebuild

## 0.5.1

### Patch Changes

- 51ede14: Move checkCompletion() calls outside Prisma interactive transaction in stage.pollSuspended to prevent P2028 timeout errors when batch provider APIs are slow to respond.

## 0.5.0

### Minor Changes

- fee7d83: Add `providerOptions` passthrough to `EmbedOptions` interface, allowing consumers to pass provider-specific options (e.g., Voyage's `outputDimension`, Cohere's `inputType`) directly to the AI SDK's `embed()` call. User-specified options are merged after auto-mapped provider defaults (like Google's `outputDimensionality`), so they can override when needed.

## 0.4.1

### Patch Changes

- fe65b06: Fix reliability issues: idempotent stage creation (prevents P2002 loops), ghost job detection with no-retry in hosts, per-run error isolation in claimPending, stuck run detection via run.reapStuck with race condition guard, and orchestration tick step isolation.

## 0.4.0

### Minor Changes

- 3b07f56: Add `registerEmbeddingProvider()` for custom embedding providers. Consumers can now register any AI SDK community provider (Voyage, Cohere, Jina, etc.) without library changes. The `ModelConfig.provider` field is now an open string instead of a closed enum.

## 0.3.0

### Minor Changes

- 579106e: Add custom provider support for embeddings in AI helper. The `embed()` method now routes to OpenRouter or Google based on the model's `provider` field, instead of being hardcoded to Google. This enables using OpenAI, Cohere, and other embedding models available through OpenRouter.

## 0.2.1

### Patch Changes

- 71b84a9: Split job.execute into multi-phase transactions so RUNNING status is visible immediately and long-running stage execution does not hold a database connection open

## 0.2.0

### Minor Changes

- e3b8cb4: Command kernel API migration: pure command dispatcher with typed handlers, transactional outbox, idempotency, optimistic concurrency, DLQ support, and host packages for Node.js and serverless environments.

## 0.1.0

### Minor Changes

- 1596189: Initial release of @bratsos/workflow-engine

  Features:

  - Type-safe workflow builder with pipe/parallel composition
  - Stage definitions (sync, async, batch) with Zod validation
  - AIHelper for generateText, generateObject, embed, streamText
  - Batch API support for Anthropic, Google, and OpenAI
  - Automatic cost tracking and token counting
  - WorkflowRuntime for job queue processing
  - Suspension/resume support for long-running operations
  - Prisma persistence with SQLite/PostgreSQL support
  - In-memory implementations for testing
  - Comprehensive trace logging (WORKFLOW_ENGINE_TRACE env var)
  - Agent skill documentation for Claude Code

### Patch Changes

- 9ccb745: Migrate from deprecated `generateObject()` to AI SDK v6 pattern using `generateText()` with `Output.object()`.

  Add `require_parameters: true` to OpenRouter provider config to ensure routing only to providers that actually support requested features like `json_schema` structured output. This prevents errors when a model is hosted by multiple providers with different capability support.

  Also fixes `workflow-engine-sync` CLI binary which was missing from the 0.0.11 release.
