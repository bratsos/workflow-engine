# @bratsos/workflow-engine

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
