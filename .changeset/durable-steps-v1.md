---
"@bratsos/workflow-engine": major
---

Durable steps, injected AI services, one AI primitive with a realtime/batch policy, a builder-first typed workflow API, and the 1.0 removals.

**Breaking (major):**

- Removed the APIs deprecated for 1.0: `ModelStatsTracker`, `getModelById`, `ModelWithRecorder`, `printAvailableModels`, `getRegisteredModel`, `listRegisteredModels`, `getDefaultModel`, `modelSupportsBatch`, the positional `recordCall(modelKey, prompt, response, tokens, options)` overload (the object form stays), `requireStageOutput`, and `apiKey` on the suspended state schema. Check batch capability with `getModel(key).supportsAsyncBatch`; configure models with `registerModels()`.
- `defineWorkflow` no longer takes an `output` option. The workflow output schema is always the last stage's output schema (or the merged object of the last parallel group).
- `StageContext` and `CheckCompletionContext` gained `step`, `ai` and `aiLogger`. Hand-built contexts (custom hosts, tests that construct a context by hand) must provide them; `createStepApi()` from `@bratsos/workflow-engine/kernel` builds a ledger-less step API that throws `StepLedgerNotConfiguredError`.
- `ctx.log` and `ctx.onLog` are typed as returning `void`. Code that awaited them still compiles; the type no longer suggests it.
- `AIStreamResult.rawResult` is `undefined` when the stream came from an adapter.
- `ModelKey` is an open string type. Code that relied on a type error for an unregistered key now fails at `getModel()` instead.
- The Prisma schema gains a `WorkflowStep` model (`attempt`, `leaseExpiresAt`, `deadlineAt` included) used by `PrismaStepLedger`; consumers using durable steps need a migration.

**New features:**

- **Durable steps.** `ctx.step.run(id, fn, { leaseMs, retries, retryDelayMs })`, `ctx.step.waitFor(id, { poll, ready, every, timeout, pollBackoffMs })`, `ctx.step.waitForSignal(id, { timeout })` and `ctx.step.sleep(id, duration)` record side effects in a `StepLedger` (`InMemoryStepLedger`, `PrismaStepLedger`); a suspended stage resumes by replaying `execute()` with completed steps answered from the ledger. A `step.signal` kernel command completes a signal wait and is idempotent. Leases re-claim steps left `running` by a dead worker, `retries` re-run a thrown step, wait deadlines are stored once and never slide (`StepTimeoutError` on expiry), a throwing `poll` backs off instead of failing the stage, replay saves artifacts, and re-running a stage from scratch clears its ledger rows. Control-flow errors are branded (`isStepControlFlowError`) and a stage body that swallows one still suspends.
- **`ctx.step.ai`.** `generateText` and `generateObject` are memoized through the ledger. `map(id, items, spec)` runs one prompt per item under `policy: "auto" | "realtime" | "batch"` with the same schema validation and repair on both paths, an in-process concurrency limit, a call budget (`AiMapBudgetExceededError`), a stored batch deadline, and `onExpiry: "fail" | "partial"` (`AiMapBatchFailedError`). All batch bookkeeping lives in step results.
- **`ctx.ai` and `ctx.aiLogger`.** `createKernel({ services: { aiLogger, ai? } })` provides a lazily built `AIHelper` on every stage and `checkCompletion` context under the topic `workflow.<runId>.stage.<stageId>`, with call logs in the run's log table. `createMockAIHelperFactory()` in `@bratsos/workflow-engine/testing` provides the mock for tests. Accessing `ctx.ai` without services throws `AIServicesNotConfiguredError`.
- **Adapter seam.** `AIHelperOptions.adapter: AIAdapter` swaps the transport for any subset of `generateText`, `generateObject`, `embed` and `streamText` below logging and cost; child helpers inherit it.
- **Timeouts.** `AIHelperOptions.timeout.perCallMs` and per-call `timeoutMs` on text, object, embed and stream options; expiry throws `AICallTimeoutError` and still logs the failure row.
- **Builder-first workflows.** `defineWorkflow(id, { input }).stage(id, definition)` infers the context from earlier stages so `ctx.require()` is typed and `dependencies` only accepts earlier ids; `.stage(prebuilt)`, `.pipe()`, `.parallel([...])` and `.parallel((group) => ...)` carry the same inference; `InferWorkflowContext`, `InferWorkflowInput`, `InferWorkflowOutput`, `InferWorkflowStageIds` and `InferStageOutputById` expose the inferred types.
- Reference `skills/workflow-engine/references/12-durable-steps.md` documents all of the above and the migration from `defineAsyncBatchStage` to steps.
