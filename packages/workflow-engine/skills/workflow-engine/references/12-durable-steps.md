# Durable Steps

Durable steps let a stage's `execute()` be a replayable script: side effects run inside named steps whose results are stored in a step ledger, and a suspended stage resumes by re-running `execute()` from the top with completed steps answered from the ledger. This reference covers the step API, the determinism rules, `ctx.step.ai.*`, `ctx.ai` injection, the AI adapter seam and timeouts, the builder-first workflow API, and how to move an async-batch stage onto steps.

## Setup

The kernel needs a `StepLedger` for durable steps and, for `ctx.ai`, AI services:

```typescript
import {
  createKernel,
  createPrismaAICallLogger,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
} from "@bratsos/workflow-engine";

const persistence = createPrismaWorkflowPersistence(prisma);

const kernel = createKernel({
  persistence,
  jobTransport: createPrismaJobQueue(prisma),
  blobStore,                       // your BlobStore implementation
  eventSink: { emit: async (event) => { await bus.publish(event); } },
  clock: { now: () => new Date() },
  registry: { getWorkflow: (id) => workflows.get(id) },
  stepLedger: createPrismaStepLedger(prisma),
  services: { aiLogger: createPrismaAICallLogger(prisma) },
});
```

`eventSink` and `clock` are not optional: the kernel publishes every outbox
event through the sink and reads *all* time from the clock, which is what
makes a run reproducible under a `FakeClock` in tests.

`blobStore` must be **shared by every process that executes or polls a
run**: a replay resolves `ctx.input` and `ctx.require(...)` from the blob
store on every poll, so a worker, a cron tick and a web process that kicks
orchestration must all read the same store. `createPrismaBlobStore(prisma)`
(optional `WorkflowBlob` table) makes the database that store; an
`InMemoryBlobStore` is only for a single-process test. A missing blob fails
the replay with the blob key and this requirement.

In tests, use `createTestHarness()` from `@bratsos/workflow-engine/testing` —
it builds the whole thing (in-memory persistence, job queue, blob store,
event sink, `FakeClock`, `InMemoryStepLedger`, `InMemoryAICallLogger` and the
mock AI factory) and drives the run loop for you. See
`07-testing-patterns.md`. A stage that never touches `ctx.step` or `ctx.ai`
runs without either; touching them unconfigured throws
`StepLedgerNotConfiguredError` or `AIServicesNotConfiguredError`.

```typescript
import { createTestHarness } from "@bratsos/workflow-engine/testing";

const harness = createTestHarness({ workflows: [myWorkflow] });
harness.mockAi.setTextResponse("summarize", { text: "the summary" });

const result = await harness.run("my-workflow", { docId: "doc-1" });
expect(result.status).toBe("COMPLETED");
```

The Prisma ledger uses the `WorkflowStep` model from the package's `prisma/schema.prisma` (shipped in `node_modules/@bratsos/workflow-engine/prisma/`); consumers add it, with its `attempt`, `leaseExpiresAt` and `deadlineAt` columns, through a migration. The Prisma adapters also require every model *and column* the package schema defines — `migrations/migrate-0.13-to-1.0.md` has the column-level checklist (the `workflow_steps` table, `ai_calls.batchId`/`requestId`, and the columns such as `workflow_stages.attempt`/`version` and `idempotency_keys.createdAt` that every dispatch writes) with SQL, so a consumer that skipped releases can apply them in one migration. The adapters never import `@prisma/client` themselves; they work with any generator output, including Prisma 7's `prisma-client` generator with a custom `output`.

## The step API

```typescript
interface StepApi {
  run<T>(id: string, fn: () => Promise<T>, options?: StepRunOptions): Promise<T>;
  waitFor<T>(id: string, opts: StepWaitOptions<T>): Promise<T>;
  waitForSignal<T = unknown>(id: string, opts: { timeout: number | string }): Promise<T>;
  sleep(id: string, duration: number | string): Promise<void>;
  /** generateText / generateObject / streamText / map — see below. */
  readonly ai: StepAiApi;
}

interface StepRunOptions {
  leaseMs?: number;       // lease held while fn runs; default 5 minutes
  retries?: number;       // retries after the first failed attempt; default 0
  retryDelayMs?: number | string; // delay before a retry ("30s"); default 0
}

interface StepWaitOptions<T> {
  poll: () => Promise<T>;
  ready: (value: T) => boolean;
  every: number | string;    // "30s", "5m", or milliseconds
  timeout: number | string;  // non-sliding deadline from the first wait
  pollBackoffMs?: number;    // backoff after poll() throws; default = every
}
```

```typescript
const submit = defineStage({
  id: "render",
  name: "Render",
  schemas: { input: In, output: Out, config: z.object({}) },
  async execute(ctx) {
    const job = await ctx.step.run("submit", () => renderApi.submit(ctx.input));

    const status = await ctx.step.waitFor("poll", {
      poll: () => renderApi.status(job.id),
      ready: (s) => s.state === "done",
      every: "30s",
      timeout: "6h",
    });

    await ctx.step.sleep("settle", "10s");

    const approval = await ctx.step.waitForSignal<{ approved: boolean }>("approve", {
      timeout: "7d",
    });

    return { output: { url: status.url, approved: approval.approved } };
  },
});
```

`run` executes `fn` once and stores its result. `waitFor` calls `poll` and, when `ready` is false, suspends the stage; the kernel polls again after `every`. `waitForSignal` suspends until `kernel.execute({ type: "step.signal", workflowRunId, stageId, stepId, payload })` completes the step. `sleep` suspends for the duration.

Suspension is a thrown control-flow error (`StepSuspend`, or `StepInFlight` when another worker holds a lease). The stage factory turns it into a suspended stage record marked as durable, and the kernel's poll handler replays `execute()` instead of calling `checkCompletion`. A stage may define both: the marker decides.

### Leases, retries and deadlines

- A `run` step holds a lease while `fn` runs. If the worker dies, the next replay re-claims the step once the lease expires, increments `attempt`, and runs `fn` again. A live lease suspends the replay as `StepInFlight` instead of running `fn` twice.
- `retries` makes a thrown `fn` retryable: the failure is recorded, the stage suspends for `retryDelayMs`, and the next replay re-runs `fn`. When retries are exhausted the stored error is thrown and the stage fails.
- A stage that is still waiting on the same step re-suspends silently on every poll: `stage:suspended` / `workflow:suspended` are emitted when the wait starts and again only when the stage moves on to a different step, not once per poll. The step id is the identity of the wait — a `waitFor`, a `run` retry and the in-flight polls against a dead worker's live lease on the same step all count as one wait.
- `waitFor`'s `ready` may be a type guard (`(v): v is Done => ...`); the awaited value then narrows to the guarded type. The boolean form is unchanged.
- `waitFor`'s `timeout` is computed once, when the wait is first recorded, and stored on the step. Every replay compares against that stored deadline, so it never slides. Past the deadline the step is marked failed and the stage fails with `StepTimeoutError`.
- A `poll` that throws does not fail the stage: the stage suspends for `pollBackoffMs`. The first three consecutive failures are logged at DEBUG — a batch provider is eventually consistent right after a submit (OpenRouter answers 404 to the first status check) — and the streak escalates to WARN from the fourth on; the count lives on the row (`waitState.pollFailures`) so it survives a replay in another process, and a poll that returns resets it.
- Signalling a step twice is a no-op; the result carries `alreadyCompleted: true`. Signalling a timed-out step is rejected.
- If `fn` succeeded but the ledger write failed, `run` throws `StepLedgerWriteError` and does not record a failure, because the side effect already happened; the lease expiry path re-claims on the next replay.

### Concurrency

Steps may run concurrently under `Promise.all`; a suspension lets in-flight
steps finish and record before the stage suspends.

```typescript
const [profile, , invoices] = await Promise.all([
  ctx.step.run("profile", () => api.profile(id)),
  ctx.step.waitFor("export", { poll, ready, every: "30s", timeout: "1h" }),
  ctx.step.run("invoices", () => api.invoices(id)),
]);
```

When `export` suspends, `profile` and `invoices` are still in flight. The
stage factory waits for every in-flight `run` to settle — success or failure,
each recorded in its own ledger row — before the suspension is persisted,
bounded by the longest remaining lease. Without that the replay would meet
their live leases as `StepInFlight` and spin until the leases expired.

Ids must still be unique within the invocation, and the *order* the steps are
requested in is not guaranteed under `Promise.all`; the engine logs an order
warning rather than failing, but keep the array literal stable so replays
line up.

### Determinism rules

- **Side effects only inside steps.** Everything outside `ctx.step.*` runs again on every replay. Reading `ctx.input`, `ctx.require(...)` and building prompts is fine; calling an API outside a step is not.
- **Stable ids.** A step is keyed by `(stageRecordId, stepId)`. Ids must be the same string on every replay and unique within the stage. Derive ids from data (`item-${doc.id}`), never from `Math.random()` or the current time.
- **Never swallow step errors.** A `try/catch` around `ctx.step.*` must rethrow, or check `isStepControlFlowError(error)` and rethrow those. If a catch swallows one anyway, the step API records the pending suspension and the stage factory discards the returned value and suspends, logging one warning.
- **Results are JSON.** `run` results round-trip through JSON: Dates become strings, `undefined` fields disappear, Maps and Sets lose their runtime types. A result that cannot be serialized throws `StepResultNotSerializable`.
- **Results are small.** A step result is stored in the ledger row (`workflow_steps.result`) and read back on every replay of the stage; it should be a small JSON value — an id, a handle, a count, a few fields. Large payloads (downloaded documents, extracted text, model output in bulk) go to the blob store or the stage's `artifacts`, and the step returns the key: `const key = await ctx.step.run("download", async () => { const text = await fetch(url); await ctx.storage.put(blobKey, text); return blobKey; })`. Storing 30 KB of source text per step makes every poll of the stage re-read it and bloats the ledger table.
- **Order warnings.** Each step gets a sequence number when first created. A replay that reaches a known step at a different position logs a warning that the stage body is no longer deterministic; fix the body rather than the warning. `ctx.step.ai.map` consumes one sequence number per item on every replay, including items answered from the ledger, and assigns them in item order — so the item *list* must be the same on every replay: a stage that filters items through an outside-the-ledger cache before mapping them changes the step positions between replays and trips this warning for every step after the map.
- **Job retries replay the ledger, and re-open what failed.** A stage body that throws after some steps completed is retried by the job queue (up to the transport's `maxAttempts`); the kernel records the failed attempt as `PENDING` with the error on `errorMessage` and emits `stage:retrying` (not `stage:failed`, which is reserved for the attempt that makes the row `FAILED`), keeps the stage's ledger rows, and the retry replays them — a map of N items followed by a throw costs no extra model calls on the retry. A **new job attempt** also re-opens every `run` step and every map item that ended `failed` (the row goes back to `running` with no lease, so the replay re-claims it), so a `${id}:submit` that got a 503 or an item whose repair budget ran out is executed again rather than replayed as a stored failure; completed steps are never re-run. The row's `attempt` is never reset: it counts every execution of that step across job attempts (a row that read `failed attempt 3` re-runs as attempt 4), so the ledger row is the per-step history — read it together with the `job_queue` row's `attempt` (deliveries) and the `stage:retrying` events (one per retried job attempt). A reopened `run` step gets one fresh execution per job attempt; its own `retries` budget was consumed before the stage failed. A **replay of the same attempt** (a poll of a suspended stage) answers failures from the ledger. Timed-out waits and signals are terminal either way. `WorkflowStage.attempt` counts every attempt of the record: `run.rerunFrom` reruns and job retries alike (0 on the first execution, 1 on the first retry; the `job_queue` row's `attempt` counts deliveries); a completed retry clears `errorMessage`.
- **Re-running a stage from scratch** (`run.rerunFrom`, or a stage whose attempts are exhausted and that is executed again) clears that stage's ledger rows so stale results do not replay.

## `ctx.step.ai`

Durable AI calls are `ctx.ai.*` wrapped in `step.run`: on replay a completed call returns its stored result without contacting the model. Stored results carry `text` or `object`, tokens, cost and reasoning, but not the raw SDK object.

```typescript
const summary = await ctx.step.ai.generateText("summary", "gemini-2.5-flash", prompt);
const facts = await ctx.step.ai.generateObject("facts", "gemini-2.5-flash", prompt, FactsSchema);
```

### Retries on a single call

Both take a trailing `stepOptions?: StepRunOptions`, forwarded to the
underlying `step.run`, so one model call gets the same durable retry, delay
and lease as any other step:

```typescript
const summary = await ctx.step.ai.generateText(
  "summary",
  "gemini-2.5-flash",
  prompt,
  { maxTokens: 2000 },          // TextOptions — tools, stopWhen, onStepEnd too
  { retries: 2, retryDelayMs: "30s", leaseMs: 120_000 },
);
```

A thrown model call with `retries: 1` records the failure, suspends the stage
for `retryDelayMs`, and re-runs on the next replay — exactly like
`ctx.step.run`. When the retries are exhausted the stored error is rethrown
and the stage fails.

`TextOptions` is passed through untouched, so `tools`, `stopWhen` and
`onStepEnd` work on a durable call. Only the *final* result is stored: tool
calls are re-executed if the step itself re-runs, so keep tool bodies
idempotent.

### `ctx.step.ai.streamText`

```typescript
const draft = await ctx.step.ai.streamText(
  "draft",
  "gemini-2.5-flash",
  prompt,
  { onChunk: (chunk) => sink.write(chunk) },
  { retries: 1 },
);
// StepStreamResult: { text, inputTokens, outputTokens, cost, reasoning? }
```

The first execution streams through `ctx.ai.streamText`, forwarding
`onChunk`, waits for completion, and stores the final text, tokens, cost and
reasoning as one `run` step. A replay returns the stored result without
contacting the model and calls `onChunk` once with the whole text, so a
consumer that renders incrementally still receives the content. There is no
`rawResult` and no live stream in the stored result — neither survives a
replay. Hosts with an idle-connection timeout (Cloudflare Workers) need this
where a single non-streaming call would trip the timeout.

### `ctx.step.ai.map`

One prompt per item under an execution policy, with schema validation and repair applied identically on the realtime and batch paths. Results come back in input order.

```typescript
const results = await ctx.step.ai.map("extract", documents, {
  model: "gemini-2.5-flash",
  schema: ExtractionSchema,
  prompt: (doc) => `Extract sections from:\n${doc.text}`,
  itemId: (doc) => doc.id,
  repair: { attempts: 1 },
  policy: "auto",
  auto: { batchAbove: 20 },
  batch: { pollEvery: "60s", timeout: "24h", onExpiry: "fail" },
  realtime: { concurrency: 10, budget: 500, minDelayMs: "1s" },
});

for (const r of results) {
  if (r.status === "succeeded") use(r.result, r.validated, r.cost);
  else if (r.errorName === "SubscriptionLimitError") stopEarly(r.id);
  else ctx.log("WARN", `item ${r.id} failed after ${r.attempts} attempts: ${r.error}`);
}
```

- **Policy.** `auto` (default) uses batch when there are at least `auto.batchAbove` items (default 20), the model's registry entry has `supportsAsyncBatch`, a batch provider resolves, and every prompt is a string; otherwise realtime. The provider resolves in this order: `batch.provider` on the call, the model's `batchProvider` registry field, the native vendor — the entry's `provider` when it is `"google"`, `"anthropic"` or `"openai"`, else the vendor named by the slug (`google/...`, `anthropic/...`, `openai/...`) — then OpenRouter. A native entry may carry either the bare model id or the catalog slug (`google/gemini-2.5-flash-lite`); the batch and realtime paths both strip the vendor prefix, so one entry serves `map` batches and their realtime repair. Once a batch is submitted, its polls and collect go through the transport recorded in the stored refs, whatever the registry resolves later. Register `batchProvider: "openrouter"` on a model you call through OpenRouter to batch it there too; when a vendor SDK is not installed and OpenRouter can batch the model, the helper falls back to OpenRouter with a WARN — also for a catalog entry generated before `batchModelId` existed, in which case the `<id>:batch` row is assumed (as the sync CLI derives it) and the WARN says to regenerate the catalog; a row that is not live fails the submit with "does not have a :batch endpoint". `realtime` and `batch` force a path; forcing batch on a model that cannot batch throws. Policy resolution consults `getModel(spec.model)` on *every* path, `policy: "realtime"` included — an unregistered key is tolerated there (it only rules batch out), but the model call itself still resolves the key, so register the model.
- **Realtime.** Each item is a durable step `${id}:${itemId}` (default `itemId` is the index) run under an in-process semaphore of `concurrency` (default 10). A thrown model call (transport, quota, timeout — anything that is not repairable output, see *Repair*) is retried **in-process**: the item waits `realtime.retryDelayMs` (number or duration string), bumps its ledger row's `attempt`, and calls the model again inside the same `execute()`, up to `realtime.retries` times (default 1). The stage never suspends for a map item — unlike `ctx.step.run`, whose retries suspend the stage. `budget` caps model calls including repairs per stage invocation: exceeding it before an item's first call throws `AiMapBudgetExceededError`; a repair that would exceed it returns the item as failed.
- **Pacing.** `realtime.minDelayMs` (number or `"1s"`) is the minimum spacing between model calls *on one concurrency slot*: after a slot finishes an item it waits that long before taking the next one. With `concurrency: 4` and `minDelayMs: "1s"` the map makes at most four calls per second. Use it instead of a hand-written cooldown between items — a cooldown outside a step re-runs on every replay, and one inside a step burns a ledger row per item.
- **Failed items do not fail the stage.** An item whose in-process retries are exhausted comes back as `status: "failed"` and the map still resolves; deciding what a failed item means is the stage's job. This is the opposite of a bare `ctx.step.run`, where an exhausted step rethrows its stored error and the stage fails. A failed item carries `errorName` — the `Error.name` of the last failure — so a caller can tell a quota or transport error apart from a content failure without matching on the message. The item's ledger row is recorded as `failed` with the verdict (including `errorName`, `attempts` and tokens) as its result, so a replay of the same attempt reports the same verdict without a model call, while a new job attempt of the stage (the body threw after the map, or the stage is retried for any other reason) re-opens the row and re-prompts the item — `realtime.retries` and `repair.attempts` bound one attempt, job retries bound how many attempts there are. There is no `cause`: map results live in the step ledger and must stay JSON.
- **Streaming.** `stream: true` sends realtime items through `ctx.ai.streamText` and collects the text instead of calling `generateText`/`generateObject` — the same reason `ctx.step.ai.streamText` exists, for hosts that kill an idle connection. `schema` still applies: the collected text is parsed as JSON, validated, and repaired the usual way. The batch path ignores the flag.
- **Batch.** `${id}:submit` submits the fan-out exactly once and stores the handle, refs and request ids; `${id}:poll` is a `waitFor` with a stored deadline; `${id}:collect` fetches results with the schemas re-supplied so `validated` is true, and stores only a summary — `total`, `succeeded`, the `failed` items (id, error, tokens, cost) and the `repair` list (the feedback the repair pass will quote back). Each item's verdict is written to its own `${id}:${itemId}` row, completed or failed, exactly as on the realtime path, so `workflow_steps.result` stays small on a clean batch whatever its size (27 verdicts used to make a 92 KB collect row); the rows follow the collect in item order. Items that failed or did not validate then go through the realtime repair pass, which writes their rows. Nothing is threaded through `suspendedState.metadata`. On Google the engine sends its own conversion of the JSON Schema as the OpenAPI `responseSchema` for inline submissions — Gemini's batch endpoint ignores or rejects `responseJsonSchema`, and the provider's own conversion forwards `oneOf`, which Gemini does not have, so discriminated unions came back flat; the engine's conversion keeps unions (`anyOf`), enums, nullability and array bounds, verified live against a schema with nested discriminated unions. OpenAI's strict structured outputs — native, and through OpenRouter's `:batch` endpoint — reject `oneOf` outright (`'oneOf' is not permitted`), so those batch bodies carry the same rewrite (`oneOf` → `anyOf`, `additionalProperties: false` on every object); the realtime path applies it at the model boundary for every OpenAI, OpenRouter and Google model (see *Structured output portability* in 04-ai-integration.md), so a repair call sends the same portable schema as the batch. When the batch settles with provider-side item failures the poll logs a WARN with the counts, and when more than half of a batch fails — at the provider or in schema validation — `getResults` logs a WARN naming the batch id, the failure class and the first error; that is the signal that every item is being paid for twice. Batch accounting rows carry the item prompt, the model's reply (its raw text when the reply failed validation), and `metadata.batchDurationMs` (the batch wall time; providers report no per-item latency, so there is no per-row `durationMs`).
- **Repair.** On a schema failure the item is re-prompted with its previous output and the Zod issues appended, up to `repair.attempts` times (default 1). `attempts` on the result counts every model call for the item. The repair loop engages when the model *answered* but the answer was unusable: the returned object fails the schema, or the call threw a repairable error — the AI SDK's `NoObjectGeneratedError` (re-exported from the root entry), any error carrying the model's raw text as `text` (or `cause.text`), a `ZodError`, or a JSON `SyntaxError`. An `AIAdapter` that parses model output itself should therefore throw `NoObjectGeneratedError` from `ai` with `text` set to the raw output (and `cause` set to the parse/validation error) so the loop can quote the bad output back to the model; any other thrown error counts against `realtime.retries`, not `repair`.
- **Expiry.** `onExpiry: "fail"` (default) throws `AiMapBatchFailedError` when the batch fails or the wait times out; `"partial"` returns every item as failed with that error so the stage can decide. Failed items from the batch path carry `errorName` too: `StepTimeoutError`, `AiMapBatchFailedError`, `AiMapBatchItemFailedError` (the provider reported the request as failed) or `AiMapBatchItemMissingError` (the batch returned no result for it).
- `itemId` values `submit`, `poll` and `collect` are reserved.
- `cost` per item is the recorded cost summed over its attempts; batch items use the transport-aware batch price.

## `ctx.ai` and `ctx.aiLogger`

Every stage context and `checkCompletion` context exposes `ctx.ai`, an `AIHelper` built lazily on first access under the topic `workflow.<workflowRunId>.stage.<stageId>`, and `ctx.aiLogger`, the configured `AICallLogger`. Call logs land in the run's log table through the helper's `LogContext`.

```typescript
createKernel({
  ...deps,
  services: {
    aiLogger: createPrismaAICallLogger(prisma),
    // optional; defaults to createAIHelper
    ai: (topic, logger, logContext, providerResolver, options) =>
      createAIHelper(topic, logger, logContext, providerResolver, {
        ...options,
        timeout: { perCallMs: 8 * 60 * 1000 },
      }),
  },
});
```

`AIHelperFactory` has the exact signature of `createAIHelper`, so a factory can add routing options, an adapter or timeouts for every stage in one place. Remote activity workers expose the same properties but throw `AIServicesNotConfiguredError` until that host wires services.

### Adapter seam

`AIHelperOptions.adapter` swaps the transport below logging and cost. Any subset of the four operations can be provided; missing ones fall through to the AI SDK. Topic, cost records, failure logging, `recordCall`, `getStats`, `createChild` and `batch` stay the helper's.

```typescript
import type { AIAdapter } from "@bratsos/workflow-engine";

const localCli: AIAdapter = {
  async generateText({ model, prompt, options }) {
    const out = await runLocalModel(model.id, promptToString(prompt), options.maxTokens);
    return { text: out.text, inputTokens: out.promptTokens, outputTokens: out.completionTokens };
  },
};

const helper = createAIHelper("dev.local", logger, undefined, undefined, { adapter: localCli });
```

Request shapes: `AdapterTextRequest { model, prompt, options }`, `AdapterObjectRequest { model, prompt, schema, options }`, `AdapterEmbedRequest { model, values, options }`, `AdapterStreamRequest { model, prompt?, messages?, instructions?, options }`. Responses return the text, object, embeddings or stream plus `inputTokens`, `outputTokens`, optional `reasoning`, optional `providerMetadata`, and optional `costUsd`. When `costUsd` is present it is recorded as the reported cost (`costSource: "reported"`) instead of the estimate from the model's price table; use it for transports whose price the registry does not know, such as subscription CLIs.

### Timeouts

`AIHelperOptions.timeout.perCallMs` applies to every non-batch call; `timeoutMs` on `TextOptions`, `ObjectOptions`, `EmbedOptions` and `StreamOptions` overrides it per call. The helper combines the caller's `abortSignal` with the deadline. On expiry the call throws `AICallTimeoutError` (with `timeoutMs` and `modelKey`) and the failure is still logged as a cost row. For streams the deadline covers the whole call; the stream is aborted and the error surfaces from iteration or `getUsage()`.

### Open model keys

The **type** `ModelKey` accepts any string: registered keys keep autocomplete
through the `ModelRegistry` interface, and config that holds a plain
`z.string()` no longer needs `as ModelKey`.

The **schema** `ModelKey` (the value exported under the same name) is
`z.string().min(1)`. It does not check the registry, so a
`schemas.config` field typed with it accepts a key the consumer registers
later or resolves through a custom provider — `run.create` no longer rejects
one with "Model not found".

Validation happens where the model is actually resolved: `getModel(key)`
throws with the registered-key list in the message.

## The builder

`defineWorkflow(id, options?).stage(id, definition)` defines a stage and adds it in one call. The stage's context type is the accumulated output of every earlier stage, so `ctx.require()` is typed without casts and `dependencies` only accepts earlier ids.

```typescript
import { defineWorkflow } from "@bratsos/workflow-engine";
import { z } from "zod";

const In = z.object({ repo: z.string() });
const ChapterIndex = z.object({ chapters: z.array(z.string()) });
const Extract = z.object({ count: z.number() });

const repository = defineWorkflow("repository", { input: In })
  .stage("chapter-index", {
    schemas: { input: In, output: ChapterIndex, config: z.object({}) },
    async execute(ctx) {
      const chapters = await ctx.step.run("list", () => listChapters(ctx.input.repo));
      return { output: { chapters } };
    },
  })
  .stage("unified-extract", {
    dependencies: ["chapter-index"],
    schemas: { input: "none", output: Extract, config: z.object({}) },
    async execute(ctx) {
      const idx = ctx.require("chapter-index"); // z.infer<typeof ChapterIndex>
      const results = await ctx.step.ai.map("extract", idx.chapters, {
        model: "gemini-2.5-flash",
        prompt: (chapter) => `Extract sections from ${chapter}`,
        schema: z.object({ sections: z.array(z.string()) }),
      });
      return { output: { count: results.filter((r) => r.status === "succeeded").length } };
    },
  })
  .build();
```

- `dependencies: ["nope"]` is a type error, as is `ctx.require("later-stage")` and reusing a stage id.
- `.stage(prebuilt)` and `.pipe(prebuilt)` also check the *prebuilt stage's* context: a stage built with `defineStage<{ "chapter-index": ChapterIndex }>()({...})` is only accepted after a stage producing `chapter-index` with a compatible type. Otherwise the parameter resolves to an error type — `{ __error: "stage requires context keys not produced by earlier stages: chapter-index" }` — and the call does not compile. A stage built without an explicit context (the open `Record<string, unknown>`) is accepted anywhere, as before.
- `ctx.require()` and `ctx.optional()` live on `EnhancedStageContext`, the context `defineStage`/`.stage()` hand to `execute`. The raw `StageContext` (what a custom host builds, and what `Stage.execute` declares) has only `ctx.workflowContext`; read it directly there.
- `.parallel([a, b])` and `.parallel((group) => group.stage("a", {...}).stage("b", {...}))` add a parallel group; the outputs of all members are available to later stages.
- `.stage(prebuilt)` and `.pipe(prebuilt)` accept a `defineStage()` result and add its output type to the context. The two styles mix freely.
- `.build()` returns the same runtime `Workflow` the `.pipe()` style produces; the kernel, hosts and persistence are unchanged.
- `InferWorkflowContext<typeof repository>` and `InferStageOutputById<typeof repository, "chapter-index">` expose the inferred types for code outside the stages.

## Testing a durable stage

`createTestHarness()` from `@bratsos/workflow-engine/testing` gives you the
kernel, the ledger, the mock AI factory and a driver loop that keeps ticking
(claim → execute → poll suspended → flush → advance the clock) until the run
is terminal. `07-testing-patterns.md` covers it in full; the scripting
methods that matter for durable AI stages are:

```typescript
const harness = createTestHarness({ workflows: [workflow] });

harness.mockAi.setTextResponse("summarize", { text: "the summary" });
// Dispatch on schema identity when several calls share a prompt shape.
harness.mockAi.mockObjectResponseForSchema(FactsSchema, { facts: [] });
// The next matching call throws exactly once; later calls succeed. This is
// how a replay-safety test makes one item fail one time.
harness.mockAi.failOnce("item-2", new Error("subscription limit reached"));

const result = await harness.run("wf", { docs });
expect(result.reports[0]?.outcomes[0]?.outcome).toBe("suspended");
expect(result.status).toBe("COMPLETED");
```

`failOnce` matches a substring, a RegExp, or a predicate over
`{ modelKey, prompt, kind }`, and the armed scripts are shared with every
child helper — so arming one on the harness's root helper fires inside the
stage-scoped helper the kernel actually injects.

## Migrating an async-batch stage to steps

Before, with a hand-written suspend, `checkCompletion` and metadata threading:

```typescript
const extract = defineAsyncBatchStage({
  id: "extract",
  name: "Extract",
  schemas: { input: In, output: Out, config: Cfg },
  async execute(ctx) {
    const batch = ctx.ai.batch("gemini-2.5-flash");
    const handle = await batch.submit(buildRequests(ctx.input.docs));
    return {
      suspended: true,
      state: { batchId: handle.batchId, metadata: { batchRefs: handle.refs, requestIds: handle.requestIds } },
    };
  },
  async checkCompletion(state, ctx) {
    const batch = ctx.ai.batch("gemini-2.5-flash");
    const status = await batch.getStatus(state.batchId, state.metadata);
    if (status.status !== "completed") return { completed: false };
    const results = await batch.getResults(state.batchId, { ...state.metadata, schemas });
    return { completed: true, output: toOutput(results) };
  },
});
```

After, one linear body with the same exactly-once submit and validated results:

```typescript
const extract = defineStage({
  id: "extract",
  name: "Extract",
  schemas: { input: In, output: Out, config: Cfg },
  async execute(ctx) {
    const results = await ctx.step.ai.map("extract", ctx.input.docs, {
      model: "gemini-2.5-flash",
      schema: SectionSchema,
      prompt: (doc) => `Extract sections from:\n${doc.text}`,
      itemId: (doc) => doc.id,
      batch: { pollEvery: "60s", timeout: "24h" },
    });
    return { output: toOutput(results) };
  },
});
```

What changes: no `checkCompletion`, no `suspendedState.metadata`, batch results are validated and repaired like realtime ones, a crash between submit and collect resumes from the ledger, and the same stage runs realtime for small inputs. `defineAsyncBatchStage` is not exported from 1.0; `npx workflow-engine-codemod --from 0.13` flags every remaining use (and `checkCompletion`, `requireStageOutput`, `experimental_output`, the removed model helpers) with a pointer to the 0.13→1.0 guide.
