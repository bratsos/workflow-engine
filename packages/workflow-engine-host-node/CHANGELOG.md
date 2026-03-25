# @bratsos/workflow-engine-host-node

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
