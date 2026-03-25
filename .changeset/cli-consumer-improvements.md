---
"@bratsos/workflow-engine": minor
"@bratsos/workflow-engine-host-node": minor
---

feat: CLI consumer improvements — runAndWait, metadata fix, providerResolver, skipInteractiveTransactions

- **runAndWait()**: New convenience function in `@bratsos/workflow-engine-host-node` that dispatches a workflow run and polls until terminal state. Handles host lifecycle, abort signals, and stage change callbacks.
- **Metadata stored as JSON**: `CreateRunInput.metadata` is now stored as a JSON column on WorkflowRun instead of being spread as flat Prisma fields. This fixes Prisma v7 compatibility where spread FK fields caused runtime errors. **Breaking:** consumers that relied on metadata spreading must update their callers to set relations explicitly after run creation.
- **ProviderResolver**: `createAIHelper()` accepts an optional 4th argument `providerResolver: (modelConfig) => LanguageModelV1 | null` for custom per-model provider routing. Propagated to child helpers.
- **skipInteractiveTransactions**: `createPrismaWorkflowPersistence()` accepts `{ skipInteractiveTransactions: true }` to bypass Prisma `$transaction()` wrappers in single-process environments where interactive transactions cause cross-connection deadlocks.
