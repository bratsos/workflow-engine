---
"@bratsos/workflow-engine": minor
---

Initial release of @bratsos/workflow-engine

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
