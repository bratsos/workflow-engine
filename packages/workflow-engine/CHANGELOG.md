# @bratsos/workflow-engine

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
