# Migrating from 0.13 to 1.0

## Summary

1.0 adds durable steps (`ctx.step.*`, backed by a new `WorkflowStep` table), injects AI services into every stage context (`ctx.ai`, `ctx.aiLogger`, `ctx.step.ai`), replaces the async-batch stage pattern with one primitive (`ctx.step.ai.map` with a realtime/batch policy), makes the workflow builder infer the context type from earlier stages, and removes everything deprecated for 1.0. It also moves to AI SDK 7. Two things bite at runtime rather than compile time, so do them first: the database needs one new table plus the columns listed below, and every stage context now carries `step`, `ai` and `aiLogger`.

The first real-world runs of the 1.0 alphas also found and fixed behaviour that 0.13 code may rely on: batch results are now validated and repaired, realtime map retries run in-process, and hosts flush the outbox on `stop()`. See "Behaviour changes".

## Does this affect you?

- **Every consumer** — apply the database checklist and update the peer dependencies. If you construct a `StageContext` by hand (custom host, unit tests calling `stage.execute(ctx)` directly) read "Hand-built contexts".
- **You use `defineAsyncBatchStage`** — it is no longer exported. Migrate to `defineStage` with `ctx.step.waitFor` (a poll) or `ctx.step.ai.map` (an AI batch); the section below has the before/after. `npx workflow-engine-codemod --from 0.13` flags every use, with `checkCompletion`, `requireStageOutput`, `experimental_output` and the removed model helpers.
- **You call any API in the removals table** — those are compile errors now; each has a one-line replacement.
- **You implement `AIAdapter`** — `generateObject` results are now read from `object` (an alpha bug read `output`), and the repair loop expects `NoObjectGeneratedError` with `text` set. See "Adapters".

## Database checklist

Verified against `git diff` of the package's `prisma/schema.prisma` between 0.13.0 and 1.0.0, plus every column the 1.0 Prisma adapters write. Apply in order; every statement is idempotent on Postgres (`IF NOT EXISTS`).

- [ ] **Add the `workflow_steps` table** (new in 1.0; used by `createPrismaStepLedger`).

  ```prisma
  model WorkflowStep {
    id             String    @id @default(cuid())
    stageRecordId  String
    stepId         String
    seq            Int
    kind           String
    status         String
    attempt        Int       @default(1)
    leaseExpiresAt DateTime?
    deadlineAt     DateTime?
    result         Json?
    error          String?
    waitState      Json?
    createdAt      DateTime  @default(now())
    updatedAt      DateTime  @updatedAt

    @@unique([stageRecordId, stepId])
    @@index([stageRecordId])
    @@map("workflow_steps")
  }
  ```

  ```sql
  CREATE TABLE IF NOT EXISTS "workflow_steps" (
    "id"             TEXT PRIMARY KEY,
    "stageRecordId"  TEXT NOT NULL,
    "stepId"         TEXT NOT NULL,
    "seq"            INTEGER NOT NULL,
    "kind"           TEXT NOT NULL,
    "status"         TEXT NOT NULL,
    "attempt"        INTEGER NOT NULL DEFAULT 1,
    "leaseExpiresAt" TIMESTAMP(3),
    "deadlineAt"     TIMESTAMP(3),
    "result"         JSONB,
    "error"          TEXT,
    "waitState"      JSONB,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "workflow_steps_stageRecordId_stepId_key"
    ON "workflow_steps"("stageRecordId", "stepId");
  CREATE INDEX IF NOT EXISTS "workflow_steps_stageRecordId_idx"
    ON "workflow_steps"("stageRecordId");
  ```

  `stageRecordId` is the `WorkflowStage.id` of the stage execution; there is deliberately no foreign key, so the ledger can be cleared and re-filled independently of the stage row. `result` holds the JSON the step returned (a `download` step that returns the whole document stores the whole document — return a key or a summary when the payload is large).

- [ ] **Add `batchId` and `requestId` to `ai_calls`.** The 0.12→0.13 guide asked for these, but the package's own `prisma/schema.prisma` did not carry them until 1.0, so a consumer who copied the package schema is missing them. Both nullable; the unique index is what deduplicates batch cost rows.

  ```sql
  ALTER TABLE "ai_calls"
    ADD COLUMN IF NOT EXISTS "batchId"   TEXT,
    ADD COLUMN IF NOT EXISTS "requestId" TEXT;
  CREATE INDEX IF NOT EXISTS "ai_calls_batchId_idx" ON "ai_calls"("batchId");
  CREATE UNIQUE INDEX IF NOT EXISTS "ai_calls_batch_request_unique"
    ON "ai_calls"("batchId", "requestId");
  ```

- [ ] **Confirm the columns the adapters write on every dispatch.** These all exist in the 0.13 package schema, but consumers who forked the schema before 0.11 (or applied migrations selectively) have hit each of them as a runtime `Unknown argument` from Prisma on the first `dispatch`. Each write site is named so you can grep the adapter if you doubt it.

  | Table | Column | Written by | If missing |
  |---|---|---|---|
  | `workflow_runs` | `version INT NOT NULL DEFAULT 1` | every run update (optimistic concurrency) | `run.transition` throws |
  | `workflow_runs` | `config JSONB NOT NULL DEFAULT '{}'`, `priority INT DEFAULT 5`, `metadata JSONB` | `createRun` | `run.create` throws |
  | `workflow_runs` | `totalCost FLOAT DEFAULT 0`, `totalTokens INT DEFAULT 0` | run completion | `run.transition` throws |
  | `workflow_stages` | `attempt INT NOT NULL DEFAULT 0` | `createStage` / `upsertStage` | first `job.execute` throws `Unknown argument attempt` |
  | `workflow_stages` | `version INT NOT NULL DEFAULT 1` | `upsertStage` (`version: { increment: 1 }`) and every guarded update | same |
  | `workflow_stages` | `suspendedState`, `resumeData JSONB`, `nextPollAt TIMESTAMP`, `pollInterval INT`, `maxWaitUntil TIMESTAMP`, `metrics`, `embeddingInfo JSONB`, `errorMessage TEXT` | stage updates | suspension / failure paths throw |
  | `workflow_annotations` | whole table (0.8) incl. `attempt`, `scope`, `scopeId`, `actorKind`, `actorId`, `actorVersion`, `key`, `value`, `payload`, `idempotencyKey` | `appendAnnotations` | `ctx.annotate` throws |
  | `job_queue` | `attempt INT DEFAULT 0`, `maxAttempts INT DEFAULT 3`, `workerId`, `lockedAt`, `startedAt`, `completedAt`, `nextPollAt TIMESTAMP`, `payload JSONB`, `lastError TEXT` | enqueue / dequeue / complete / fail | job claim throws |
  | `outbox_events` | `sequence INT`, `causationId TEXT`, `occurredAt TIMESTAMP`, `publishedAt`, `retryCount INT DEFAULT 0`, `dlqAt TIMESTAMP` | `appendEvents` / `outbox.flush` | every command that emits an event throws |
  | `idempotency_keys` | `createdAt TIMESTAMP NOT NULL DEFAULT now()` | `acquireIdempotencyKey` writes it explicitly so an injected `Clock` is authoritative | **every** `dispatch` fails with `Unknown argument createdAt` |
  | `idempotency_keys` | `commandType TEXT`, `result JSONB` | same | same |

  ```sql
  -- The three that 1.0 consumers actually tripped on
  ALTER TABLE "workflow_stages"   ADD COLUMN IF NOT EXISTS "attempt"   INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "workflow_stages"   ADD COLUMN IF NOT EXISTS "version"   INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE "idempotency_keys"  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
  ```

  The reliable check is a diff: `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel node_modules/@bratsos/workflow-engine/prisma/schema.prisma --script` prints the SQL that separates your database from the package schema (ignore the differences on your own tables).

- [ ] **Optional: add `workflow_blobs` if you want Prisma as the blob store.** Stage outputs and every replay's `ctx.input` are read from the `BlobStore` by *every* process that executes or polls a run (workers, cron ticks, a web process that kicks orchestration), so the store must be shared — an `InMemoryBlobStore` in one of them fails the next process with `Blob "<key>" ... is not in the blob store`. `createPrismaBlobStore(prisma)` keeps blobs in this table so no object storage is needed; it requires only the `workflowBlob` delegate, so consumers on S3/R2 do not add it.

  ```prisma
  model WorkflowBlob {
    key       String   @id
    data      Json
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt

    @@map("workflow_blobs")
  }
  ```

  ```sql
  CREATE TABLE IF NOT EXISTS "workflow_blobs" (
    "key"       TEXT PRIMARY KEY,
    "data"      JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
  );
  ```

- [ ] **Running the kernel inside one Prisma transaction per tick?** The 1.0 adapters no longer rely on a caught unique violation for any insert-if-absent on Postgres (`PrismaStepLedger.claim`, `acquireIdempotencyKey` use `createMany({ skipDuplicates: true })` + read-back), so a replay that re-claims completed steps no longer aborts the enclosing transaction with `25P02`. Pass `createPrismaStepLedger(prisma, { databaseType: "sqlite" })` on SQLite, which has no `skipDuplicates`. Raw statements bind a JS `Date` (UTC) instead of `NOW()`; pass `now: () => clock.now()` to the persistence and job queue to make them follow your clock.

- [ ] **If your Prisma `Status` enum has another name**, pass it: `createPrismaWorkflowPersistence(prisma, { statusEnumName: "WorkflowStatus" })`. The raw-SQL claim paths cast with `::"Status"` (since 0.11) and fail with `42704 type "Status" does not exist` otherwise. See `05-persistence-setup.md`.

- [ ] **Check the delegates on your `PrismaClient`.** `EnginePrismaClient` requires `workflowRun`, `workflowStage`, `workflowStep`, `workflowLog`, `workflowArtifact`, `workflowAnnotation`, `aICall`, `jobQueue`, `outboxEvent`, `idempotencyKey`, plus `$transaction`, `$queryRaw` and `$executeRaw`. A wall of `PrismaClient is not assignable to EnginePrismaClient` errors means one of them is missing from your schema (in 1.0 almost always `workflowStep`) — add the model and regenerate the client.

## Required code changes

- [ ] **Remove the APIs that were deprecated for 1.0.**

  | Removed | Use instead |
  |---|---|
  | `ModelStatsTracker`, `ModelWithRecorder` | `AICallLogger` rows (`createPrismaAICallLogger`) |
  | `getModelById`, `getRegisteredModel`, `listRegisteredModels`, `getDefaultModel`, `printAvailableModels` | `getModel(key)`, `registerModels()` and your own registry listing |
  | `modelSupportsBatch(key)` | `getModel(key).supportsAsyncBatch` |
  | `recordCall(modelKey, prompt, response, tokens, options)` (positional) | the object form `recordCall({ ... })` |
  | `requireStageOutput` | `ctx.require("stageId")` |
  | `SuspendedStateSchema.apiKey` | `BatchOptions.apiKey` |
  | `defineWorkflow({ output })` | nothing — the workflow output is always the last stage's output schema (or the merged object of the last parallel group) |
  | `AnthropicBatchProvider` & co. (already gone in 0.13) | `ai.batch()` / `ctx.step.ai.map` |
  | `defineAsyncBatchStage` (root and `/client` exports) | `defineStage` with `ctx.step.waitFor` / `ctx.step.ai.map`; the async-batch mode itself (`defineStage({ mode: "async-batch", checkCompletion })`) still runs for hosts that keep it |
  | `KernelConfig.scheduler`, `NoopScheduler` | nothing — the kernel never scheduled anything; drop the option |
  | `RunCreateCommand.metadata` | `annotations` on `run.create` |
  | `ArtifactPersistence` (`saveArtifact`, `loadArtifact`, `hasArtifact`, `deleteArtifact`, `listArtifacts`, `getStageIdForArtifact`, `saveStageOutput`, `loadStageOutput`) on the `WorkflowPersistence` port | the `BlobStore` port (`createPrismaBlobStore`); the built-in adapters keep the methods as plain class methods |
  | `getRunsByStatus`, `claimPendingRun`, `updateStageByRunAndStageId`, `getStageById`, `getFirstSuspendedStageReadyToResume`, `getFirstFailedStage`, `getLastCompletedStage`, `getLastCompletedStageBefore` on the port | `getStagesByRun(runId, { status, orderBy })`, `getStage(runId, stageId)`, `updateStage(stage.id, ...)`; the built-in adapters keep the methods |
  | `JobQueue.enqueue` / `JobTransport.enqueue` on the ports | `enqueueParallel([job])`; the built-in queues keep `enqueue` |
  | Conformance suites `persistenceConformanceSuite(name, factory)` | take a third argument `{ describe, it, expect, beforeEach }` (the `testing` entry no longer imports vitest) |

- [ ] **Provide `step`, `ai` and `aiLogger` on hand-built stage contexts.** `StageContext.step` is required (it was optional), and `CheckCompletionContext` gained `step`, `ai` and `aiLogger` too. Code that builds a context by hand must supply them; a stage that never touches them still runs (the wrapper only probes `ctx.step` when present).

  ```typescript
  // Before (0.13)
  const ctx = { input, config, require, log, storage, ... };
  await stage.execute(ctx);

  // After (1.0) — ledger-less step API + mock AI for tests
  import { createStepApi } from "@bratsos/workflow-engine/kernel";
  import { createMockAIHelperFactory, InMemoryAICallLogger } from "@bratsos/workflow-engine/testing";

  const aiLogger = new InMemoryAICallLogger();
  const ctx = {
    input, config, require, log, storage, ...,
    step: createStepApi({ clock: { now: () => new Date() } }), // throws StepLedgerNotConfiguredError if used
    ai: createMockAIHelperFactory()("test", aiLogger),
    aiLogger,
  };
  ```

  Prefer `createTestHarness()` from `@bratsos/workflow-engine/testing`, which builds all of it.

- [ ] **Wire the kernel services.** `createKernel` takes `stepLedger` (for `ctx.step`) and `services` (for `ctx.ai`). Without `services.aiLogger`, `ctx.ai` throws `AIServicesNotConfiguredError`; without `stepLedger`, `ctx.step` throws `StepLedgerNotConfiguredError`.

  ```typescript
  // Before (0.13)
  const kernel = createKernel({ persistence, jobTransport, blobStore, eventSink, clock, registry });

  // After (1.0)
  import { createPrismaAICallLogger, createPrismaStepLedger } from "@bratsos/workflow-engine";

  const kernel = createKernel({
    persistence, jobTransport, blobStore, eventSink, clock, registry,
    stepLedger: createPrismaStepLedger(prisma),
    services: {
      aiLogger: createPrismaAICallLogger(prisma),
      // ai: (topic, logger, logContext, providerResolver, options) =>
      //   createAIHelper(topic, logger, logContext, providerResolver, { ...options, adapter }),
    },
  });
  ```

  `services.ai` is optional; the default builds `createAIHelper` per stage. Pass your own factory to install an `AIAdapter` (local CLI, proxy, recorded fixtures) — it is the *only* way an adapter reaches `ctx.step.ai`.

- [ ] **Update the AI SDK peer range.** 1.0 targets AI SDK 7: `ai@^7`, `@ai-sdk/google@^4`, and, if you batch against them, `@ai-sdk/anthropic@>=4.0.46` / `@ai-sdk/openai@>=4.0.53`. `zod@^4.1.12` and `@prisma/client@>=6` are unchanged. `@openrouter/ai-sdk-provider` moves with `ai@7`.

  ```bash
  npm install ai@^7 @ai-sdk/google@^4 zod@^4
  # optional, only what you batch against
  npm install @ai-sdk/anthropic @ai-sdk/openai
  ```

- [ ] **Use the builder's inference instead of hand-typed contexts.** `defineWorkflow(id, { input }).stage(id, definition)` infers the context from earlier stages so `ctx.require()` is typed and `dependencies` only accepts earlier ids. `.stage(prebuilt)` / `.pipe(prebuilt)` now check a prebuilt stage's declared context against the accumulated one; a stage that requires a key no earlier stage produces no longer compiles (the parameter resolves to `{ __error: "stage requires context keys not produced by earlier stages: ..." }`). The object form `defineWorkflow({ id, name, description, input })` still works.

  ```typescript
  // Before (0.13) — context typed by hand on every stage
  const summarize = defineStage<typeof In, typeof Out, typeof Cfg, { extract: ExtractOut }>({ ... });
  export const wf = defineWorkflow({ id: "docs", input: In, output: Out }).pipe(extract).pipe(summarize).build();

  // After (1.0) — inferred; `output` is gone (it is the last stage's output)
  export const wf = defineWorkflow("docs", { input: In })
    .stage("extract", { schemas: { input: In, output: ExtractOut, config: Cfg }, async execute(ctx) { ... } })
    .stage("summarize", {
      dependencies: ["extract"],
      schemas: { input: "none", output: Out, config: Cfg },
      async execute(ctx) {
        const { text } = ctx.require("extract"); // typed
        ...
      },
    })
    .build();
  type Ctx = InferWorkflowContext<typeof wf>;
  ```

- [ ] **`ModelKey` is open.** The zod schema is `z.string().min(1)`; a `schemas.config` field typed with it no longer rejects an unregistered key at `run.create`. Validation happens at `getModel()` — register every model you reference.

- [ ] **`ctx.log` / `ctx.onLog` return `void`.** Awaiting them still compiles; drop the `await` when you touch the code.

- [ ] **`AIStreamResult.rawResult` is `undefined`** when the stream came from an adapter. Guard before reading it.

## `defineAsyncBatchStage` → `ctx.step.ai.map`

`defineAsyncBatchStage` is not exported any more. The replacement is one linear stage body; the full before/after is in `12-durable-steps.md` ("Migrating an async-batch stage to steps").

```typescript
// Before (0.13)
const extract = defineAsyncBatchStage({
  id: "extract", name: "Extract", schemas: { input: In, output: Out, config: Cfg },
  async execute(ctx) {
    const batch = ctx.ai.batch("gemini-2.5-flash");
    const handle = await batch.submit(buildRequests(ctx.input.docs));
    return { suspended: true, state: { batchId: handle.id, metadata: { batchRefs: handle.refs, requestIds } } };
  },
  async checkCompletion(state, ctx) {
    const batch = ctx.ai.batch("gemini-2.5-flash");
    const status = await batch.getStatus(state.batchId, state.metadata);
    if (status.status !== "completed") return { ready: false };
    const results = await batch.getResults(state.batchId, { ...state.metadata, schemas });
    return { ready: true, output: toOutput(results) };
  },
});

// After (1.0)
const extract = defineStage({
  id: "extract", name: "Extract", schemas: { input: In, output: Out, config: Cfg },
  async execute(ctx) {
    const results = await ctx.step.ai.map("extract", ctx.input.docs, {
      model: "gemini-2.5-flash",
      schema: SectionSchema,
      prompt: (doc) => `Extract sections from:\n${doc.text}`,
      itemId: (doc) => doc.id,
      policy: "auto",                                  // batch at >= 20 items, realtime below
      batch: { pollEvery: "60s", timeout: "24h", onExpiry: "fail" },
      realtime: { concurrency: 8, retries: 2, retryDelayMs: "10s" },
      repair: { attempts: 1 },
    });
    return { output: toOutput(results) };
  },
});
```

What changes: submit happens exactly once (`${id}:submit` step), polling is a stored-deadline wait (`${id}:poll`), results are validated against `schema` and repaired realtime when they do not validate, a crash between submit and collect resumes from the ledger, and small inputs run realtime through the same code. Every `ctx.step.*` id must be stable and unique within the stage; derive `itemId` from data.

## Adapters

- `AdapterObjectResponse.object` is the structured result (the 1.0.0-alpha.0 engine read `output`; fixed in alpha.1). Do not return both.
- For `ctx.step.ai.map` repair to quote a bad answer back to the model, throw `NoObjectGeneratedError` (re-exported from `@bratsos/workflow-engine`) with `text` set to the raw output and `cause` set to the parse/validation error. Any error carrying `text` (or `cause.text`), a `ZodError`, or a JSON `SyntaxError` is also treated as repairable. Any other thrown error consumes a `realtime.retries` attempt.
- `AdapterTextResponse.object` is what `generateText` with `output` returns as `result.output`.

## Behaviour changes

- **Batch results are validated and repaired.** In 0.13 batch results were never validated after a resume. In 1.0 every `map` item is validated against `schema`; items that fail go through the realtime repair pass (`repair.attempts`, default 1), which costs a realtime call per failed item. A WARN naming the batch id, the failure class (provider error or schema validation) and the first error is logged when more than half of a batch fails, and the poll logs a WARN when the provider reports failed requests. The Google batch path sends the engine's own union-preserving conversion of the JSON Schema as `responseSchema` (Gemini's batch endpoint does not honour `responseJsonSchema`, and the provider's conversion drops discriminated unions).
- **Failed steps are re-executed on the next job attempt.** A retryable failure keeps the stage's ledger rows; on the retry, completed steps are replayed from the ledger while every `run` step and every `map` item that ended `failed` is re-opened and executed again (so a `${id}:submit` that hit a 503, or an item whose repair budget ran out, gets a fresh call). A replay of the same attempt (a poll) still answers failures from the ledger. The map's `:submit` step has no retry of its own — the job's attempt budget is its retry. `WorkflowStage.attempt` counts job retries as well as `run.rerunFrom` reruns (0 on the first execution).
- **`stage:retrying`.** A retried attempt emits `stage:retrying` (`attempt`, `maxAttempts`, `error`) instead of `stage:failed`; `stage:failed` now means the stage row is `FAILED`. Event consumers that alerted on every `stage:failed` see one alert per terminal failure.
- **Host job results carry the retry contract.** `executeJobWithHeartbeat` (and the serverless host's `handleJob`) return `willRetry`, `attempt`, `maxAttempts` and `retryDelayMs`; a push transport whose `fail()` cannot re-enqueue must retry the message after `retryDelayMs` when `willRetry` is true and acknowledge it otherwise. Malformed job messages (no `payload`, no `workflowId`) are failed and acknowledged as dead jobs instead of throwing.
- **Realtime map retries are in-process.** `realtime.retries` re-calls the model inside the same `execute()` after `retryDelayMs`, bumping the ledger row's `attempt`; the stage no longer suspends and replays per failed item. `ctx.step.run` retries still suspend.
- **Hosts flush the outbox on `stop()`.** `NodeHost.stop()` and the serverless host's shutdown run a final bounded `outbox.flush`, so `workflow:completed` for a run finished by that process is published before it exits instead of by whichever process ticks next.
- **A failed stage transitions the run immediately** on every host. With retries remaining the job is re-enqueued with backoff and the stage row is not `FAILED`; with none remaining `run.transition` runs at once with the stage error on the run.
- **Batch accounting rows** store the item prompt, the model's reply (its raw text when it failed validation) and `metadata.batchDurationMs` (the batch wall time). There is no per-row `durationMs` on batch rows: providers report no per-item latency.
- **Run totals on failed runs.** `WorkflowRun.totalCost` / `totalTokens` are rolled up on `FAILED` runs too, and a failed `generateObject` call logs the tokens (and cost) its `NoObjectGeneratedError` carried instead of 0/0.
- **Step order warnings.** Each `ctx.step.*` id consumes a sequence number on every replay, including items answered from the ledger. Keep the item list of a `map` identical across replays (filter through an outside cache *inside* a step, or not at all) or every step after the map logs `non-deterministic step order`.

## New features

See the 1.0 changeset and `12-durable-steps.md`: `ctx.step.run/waitFor/waitForSignal/sleep`, `ctx.step.ai.generateText/generateObject/streamText/map`, `createTestHarness`, the builder inference types (`InferWorkflowContext`, `InferWorkflowInput`, `InferWorkflowOutput`, `InferWorkflowStageIds`, `InferStageOutputById`), `AIHelperOptions.adapter`, per-call timeouts (`AICallTimeoutError`), `createKernel({ services })`, the `step.signal` command, and `createPrismaStepLedger`.
