# @bratsos/workflow-engine

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
