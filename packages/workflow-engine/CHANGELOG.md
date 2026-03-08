# @bratsos/workflow-engine

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
