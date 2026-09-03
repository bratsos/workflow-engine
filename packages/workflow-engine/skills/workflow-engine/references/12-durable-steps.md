# Durable Steps

Durable steps let a stage's `execute()` be a replayable script: side effects run inside named steps whose results are stored in a step ledger, and a suspended stage resumes by re-running `execute()` from the top with completed steps answered from the ledger. This reference covers the step API, the determinism rules, `ctx.step.ai.*`, `ctx.ai` injection, the AI adapter seam and timeouts, the builder-first workflow API, and how to move an async-batch stage onto steps.

## Setup

The kernel needs a `StepLedger` for durable steps and, for `ctx.ai`, AI services:

```typescript
import { createKernel, createPrismaAICallLogger } from "@bratsos/workflow-engine";
import { PrismaStepLedger } from "@bratsos/workflow-engine";

const kernel = createKernel({
  ...deps,
  stepLedger: new PrismaStepLedger(prisma),
  services: { aiLogger: createPrismaAICallLogger(prisma) },
});
```

In tests use `InMemoryStepLedger`, `InMemoryAICallLogger` and `createMockAIHelperFactory()` from `@bratsos/workflow-engine/testing`. A stage that never touches `ctx.step` or `ctx.ai` runs without either; touching them unconfigured throws `StepLedgerNotConfiguredError` or `AIServicesNotConfiguredError`.

The Prisma ledger uses the `WorkflowStep` model in `prisma/schema.prisma`; consumers add it (and its `attempt`, `leaseExpiresAt`, `deadlineAt` columns) with a migration.

## The step API

```typescript
interface StepApi {
  run<T>(id: string, fn: () => Promise<T>, options?: StepRunOptions): Promise<T>;
  waitFor<T>(id: string, opts: StepWaitOptions<T>): Promise<T>;
  waitForSignal<T = unknown>(id: string, opts: { timeout: number | string }): Promise<T>;
  sleep(id: string, duration: number | string): Promise<void>;
  readonly ai: StepAiApi;
}

interface StepRunOptions {
  leaseMs?: number;       // lease held while fn runs; default 5 minutes
  retries?: number;       // retries after the first failed attempt; default 0
  retryDelayMs?: number;  // delay before a retry; default 0
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
- `waitFor`'s `timeout` is computed once, when the wait is first recorded, and stored on the step. Every replay compares against that stored deadline, so it never slides. Past the deadline the step is marked failed and the stage fails with `StepTimeoutError`.
- A `poll` that throws does not fail the stage: the error is logged as a warning and the stage suspends for `pollBackoffMs`.
- Signalling a step twice is a no-op; the result carries `alreadyCompleted: true`. Signalling a timed-out step is rejected.
- If `fn` succeeded but the ledger write failed, `run` throws `StepLedgerWriteError` and does not record a failure, because the side effect already happened; the lease expiry path re-claims on the next replay.

### Determinism rules

- **Side effects only inside steps.** Everything outside `ctx.step.*` runs again on every replay. Reading `ctx.input`, `ctx.require(...)` and building prompts is fine; calling an API outside a step is not.
- **Stable ids.** A step is keyed by `(stageRecordId, stepId)`. Ids must be the same string on every replay and unique within the stage. Derive ids from data (`item-${doc.id}`), never from `Math.random()` or the current time.
- **Never swallow step errors.** A `try/catch` around `ctx.step.*` must rethrow, or check `isStepControlFlowError(error)` and rethrow those. If a catch swallows one anyway, the step API records the pending suspension and the stage factory discards the returned value and suspends, logging one warning.
- **Results are JSON.** `run` results round-trip through JSON: Dates become strings, `undefined` fields disappear, Maps and Sets lose their runtime types. A result that cannot be serialized throws `StepResultNotSerializable`.
- **Order warnings.** Each step gets a sequence number when first created. A replay that reaches a known step at a different position logs a warning that the stage body is no longer deterministic; fix the body rather than the warning.
- **Re-running a stage from scratch** (a failed stage re-executed, `run.rerunFrom`) clears that stage's ledger rows so stale results do not replay.

## `ctx.step.ai`

Durable AI calls are `ctx.ai.*` wrapped in `step.run`: on replay a completed call returns its stored result without contacting the model. Stored results carry `text` or `object`, tokens, cost and reasoning, but not the raw SDK object.

```typescript
const summary = await ctx.step.ai.generateText("summary", "gemini-2.5-flash", prompt);
const facts = await ctx.step.ai.generateObject("facts", "gemini-2.5-flash", prompt, FactsSchema);
```

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
  realtime: { concurrency: 10, budget: 500 },
});

for (const r of results) {
  if (r.status === "succeeded") use(r.result, r.validated, r.cost);
  else ctx.log("WARN", `item ${r.id} failed after ${r.attempts} attempts: ${r.error}`);
}
```

- **Policy.** `auto` (default) uses batch when there are at least `auto.batchAbove` items (default 20), the model's registry entry has `supportsAsyncBatch`, a batch provider resolves, and every prompt is a string; otherwise realtime. `realtime` and `batch` force a path; forcing batch on a model that cannot batch throws.
- **Realtime.** Each item is a durable step `${id}:${itemId}` (default `itemId` is the index) run under an in-process semaphore of `concurrency` (default 10). A thrown model call is retried durably (`realtime.retries`, default 1). `budget` caps model calls including repairs per stage invocation: exceeding it before an item's first call throws `AiMapBudgetExceededError`; a repair that would exceed it returns the item as failed.
- **Batch.** `${id}:submit` submits the fan-out exactly once and stores the handle, refs and request ids; `${id}:poll` is a `waitFor` with a stored deadline; `${id}:collect` fetches results with the schemas re-supplied so `validated` is true. Items that failed or did not validate then go through the realtime repair pass. Nothing is threaded through `suspendedState.metadata`.
- **Repair.** On a schema failure the item is re-prompted with its previous output and the Zod issues appended, up to `repair.attempts` times (default 1). `attempts` on the result counts every model call for the item.
- **Expiry.** `onExpiry: "fail"` (default) throws `AiMapBatchFailedError` when the batch fails or the wait times out; `"partial"` returns every item as failed with that error so the stage can decide.
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

Request shapes: `AdapterTextRequest { model, prompt, options }`, `AdapterObjectRequest { model, prompt, schema, options }`, `AdapterEmbedRequest { model, values, options }`, `AdapterStreamRequest { model, prompt?, messages?, instructions?, options }`. Responses return the text, object, embeddings or stream plus `inputTokens`, `outputTokens`, optional `reasoning` and optional `providerMetadata` (a reported cost in metadata is used instead of the estimate).

### Timeouts

`AIHelperOptions.timeout.perCallMs` applies to every non-batch call; `timeoutMs` on `TextOptions`, `ObjectOptions`, `EmbedOptions` and `StreamOptions` overrides it per call. The helper combines the caller's `abortSignal` with the deadline. On expiry the call throws `AICallTimeoutError` (with `timeoutMs` and `modelKey`) and the failure is still logged as a cost row. For streams the deadline covers the whole call; the stream is aborted and the error surfaces from iteration or `getUsage()`.

### Open model keys

`ModelKey` accepts any string. Registered keys keep autocomplete; unknown keys fail at `getModel()` with the registered-key list in the message. Config that holds `z.string()` no longer needs `as ModelKey`.

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
- `.parallel([a, b])` and `.parallel((group) => group.stage("a", {...}).stage("b", {...}))` add a parallel group; the outputs of all members are available to later stages.
- `.stage(prebuilt)` and `.pipe(prebuilt)` accept a `defineStage()` result and add its output type to the context. The two styles mix freely.
- `.build()` returns the same runtime `Workflow` the `.pipe()` style produces; the kernel, hosts and persistence are unchanged.
- `InferWorkflowContext<typeof repository>` and `InferStageOutputById<typeof repository, "chapter-index">` expose the inferred types for code outside the stages.

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

What changes: no `checkCompletion`, no `suspendedState.metadata`, batch results are validated and repaired like realtime ones, a crash between submit and collect resumes from the ledger, and the same stage runs realtime for small inputs. `defineAsyncBatchStage` keeps working for stages that still want an explicit `checkCompletion`.
