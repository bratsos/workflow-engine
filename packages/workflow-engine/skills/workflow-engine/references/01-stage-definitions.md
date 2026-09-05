# Stage Definitions

Complete API reference for `defineStage` — sync stages and the legacy `mode: "async-batch"` shape. (`defineAsyncBatchStage` was removed from the root entry at 1.0; see below.)

## defineStage

Creates a synchronous stage that executes immediately and returns a result.

```typescript
import { defineStage } from "@bratsos/workflow-engine";
import { z } from "zod";

const myStage = defineStage({
  // Required fields
  id: string,           // Unique identifier (used in workflow context)
  name: string,         // Human-readable name
  schemas: {
    input: ZodSchema | "none",   // Input validation schema
    output: ZodSchema,           // Output validation schema
    config: ZodSchema,           // Configuration schema
  },
  execute: (ctx) => Promise<SimpleStageResult>,

  // Optional fields
  description?: string,          // Stage description
  dependencies?: string[],       // Stage IDs that must complete first
  estimateCost?: (input, config) => number,  // Cost estimation
});
```

### Typed Context: the Curried Form (Recommended)

The call above lets TypeScript infer everything from the definition object, which is fine as long as you don't need `ctx.require()`/`ctx.optional()` to be typed against the workflow's accumulated context. When you do, use the **curried form** — supply only `TContext` and let TypeScript infer `TId` (as a string literal), `TInput`, `TOutput`, and `TConfig` from the definition object passed to the returned function:

```typescript
type MyContext = { "previous-stage": { value: string } };

export const myStage = defineStage<MyContext>()({
  id: "my-stage",              // TId inferred as the literal "my-stage"
  name: "My Stage",
  schemas: {
    input: InputSchema,
    output: OutputSchema,
    config: ConfigSchema,
  },
  async execute(ctx) {
    const prev = ctx.require("previous-stage"); // typed via MyContext
    return { output: { /* ... */ } };
  },
});
```

This is the recommended way to fix `TContext` explicitly. The alternative — spelling out all five generics positionally, `defineStage<TId, TInput, TOutput, TConfig, TContext>({...})` — is `@deprecated`: it's verbose, and TypeScript can't infer a subset from the middle of a generic list, so it silently loses `TId` string-literal inference if any of the five are mistyped. The curried form only ever requires the one generic TypeScript truly can't infer on its own, and it accepts both stage shapes (`defineStage<TContext>()({ mode: "async-batch", ... })` works too).

When you build the workflow with `defineWorkflow(id, { input }).stage(id, definition)`, the context is inferred from the earlier stages and no generic is needed at all — see [02-workflow-builder.md](02-workflow-builder.md) and [12-durable-steps.md](12-durable-steps.md#the-builder).

## Async-batch mode (legacy)

A stage with `mode: "async-batch"` can suspend execution and resume later through `checkCompletion`. **For new code prefer durable steps** — `ctx.step.waitFor` / `ctx.step.ai.map(id, items, { policy: "batch" })` inside a plain sync stage — which keep the batch bookkeeping in the step ledger (see [12-durable-steps.md](12-durable-steps.md)). The `defineAsyncBatchStage` export was removed from the root and `/client` entries at 1.0; the mode itself still runs, written as `defineStage({ mode: "async-batch", ... })`:

```typescript
import { defineStage } from "@bratsos/workflow-engine";

const batchStage = defineStage({
  id: "batch-process",
  name: "Batch Process",
  mode: "async-batch",    // Required marker

  schemas: {
    input: InputSchema,
    output: OutputSchema,
    config: ConfigSchema,
  },

  execute: (ctx) => Promise<SimpleStageResult | SimpleSuspendedResult>,
  checkCompletion: (state, ctx) => Promise<CompletionCheckResult>,
});
```

## Schema Patterns

### Input Schema

```typescript
// Standard input schema
schemas: {
  input: z.object({
    documentId: z.string(),
    options: z.object({
      format: z.enum(["pdf", "docx"]).default("pdf"),
    }).optional(),
  }),
  // ...
}

// No input (uses workflow context only)
schemas: {
  input: "none",  // or: input: NoInputSchema
  // ...
}
```

### Output Schema

```typescript
schemas: {
  // ...
  output: z.object({
    processedData: z.array(z.string()),
    metadata: z.object({
      count: z.number(),
      timestamp: z.string(),
    }),
  }),
}
```

### Config Schema with Defaults

```typescript
schemas: {
  // ...
  config: z.object({
    // Required config
    apiKey: z.string(),

    // Optional with default
    maxRetries: z.number().default(3),
    timeout: z.number().default(30000),

    // Optional without default
    customEndpoint: z.string().optional(),

    // Nested config
    ai: z.object({
      model: z.string().default("gemini-2.5-flash"),
      temperature: z.number().default(0.7),
    }).default({}),
  }),
}
```

## EnhancedStageContext

The context object passed to `execute()`:

```typescript
interface EnhancedStageContext<TInput, TConfig, TContext> {
  // Input and config
  input: TInput;                    // Validated input data
  config: TConfig;                  // Validated config
  workflowContext: TContext;        // All previous stage outputs

  // Workflow metadata
  workflowRunId: string;           // Current run ID
  stageId: string;                 // Current stage ID
  stageNumber: number;             // Definition order (1-based)
  stageName: string;
  stageRecordId?: string;          // WorkflowStage row id (the stage's attempt counter lives on that row)

  // Services
  log: LogFunction;                // Logging; returns void (fire-and-forget, do not await)
  onLog: LogFunction;              // Same as log
  storage: StageStorage;           // Artifact storage
  annotate: AnnotateFn;            // Durable provenance (see 10-annotations.md)
  step: StepApi;                   // Durable steps: run / waitFor / waitForSignal / sleep / ai.* (see 12-durable-steps.md)
  ai: AIHelper;                    // AIHelper scoped to workflow.<runId>.stage.<stageId>; lazy; needs createKernel({ services })
  aiLogger: AICallLogger;          // The logger behind ctx.ai
  abortSignal: AbortSignal;        // Aborted on run.cancel or a lost job lease; reason is a StageAbortedError
  onProgress: (update: {           // Progress reporting; stageId/stageName
    stageId?: string;              // auto-fill from the current stage as of
    stageName?: string;            // v0.11 (pass them to override)
    progress: number;
    message: string;
    details?: Record<string, unknown>;
  }) => void;

  // Resume state (for async-batch stages)
  resumeState?: SuspendedState;    // Present when resuming

  // Fluent helpers
  require<K>(stageId: K): TContext[K];     // Get required output
  optional<K>(stageId: K): TContext[K] | undefined;  // Get optional output
}
```

`step`, `ai`, `aiLogger` and `abortSignal` are always present as of 1.0 (a hand-built context must supply them; `createStepApi()` from `@bratsos/workflow-engine/kernel` builds a ledger-less `step`, and `new AbortController().signal` is a signal that never fires). Without `createKernel({ stepLedger })` every `ctx.step.*` call throws `StepLedgerNotConfiguredError`; without `createKernel({ services: { aiLogger } })` touching `ctx.ai` throws `AIServicesNotConfiguredError`. There is no `ctx.attempt`: read `WorkflowStage.attempt` through `ctx.stageRecordId` if you need it.

### Using require() and optional()

```typescript
async execute(ctx) {
  // Throws if "data-extraction" output is missing
  const extraction = ctx.require("data-extraction");

  // Returns undefined if "optional-enrichment" didn't run
  const enrichment = ctx.optional("optional-enrichment");

  // Type-safe access to nested data
  const items = extraction.items;

  if (enrichment) {
    // Use enrichment data
  }
}
```

### Logging

`ctx.log` / `ctx.onLog` return `void` (1.0): the entry is handed to persistence without waiting. Awaiting them still compiles but does nothing.

```typescript
async execute(ctx) {
  ctx.log("INFO", "Starting processing");
  ctx.log("DEBUG", "Input received", { count: ctx.input.items.length });

  try {
    // ... processing
    ctx.log("INFO", "Processing complete");
  } catch (error) {
    ctx.log("ERROR", "Processing failed", { error: error.message });
    throw error;
  }
}
```

### Storage

```typescript
async execute(ctx) {
  // Save intermediate data
  await ctx.storage.save("raw-data", rawData);

  // Check if data exists
  if (await ctx.storage.exists("cached-result")) {
    return { output: await ctx.storage.load("cached-result") };
  }

  // Delete old data
  await ctx.storage.delete("old-cache");

  // Get stage-specific key
  const key = ctx.storage.getStageKey(ctx.stageId, "output.json");
}
```

### Durable Steps and `ctx.step.ai`

`ctx.step.run/waitFor/waitForSignal/sleep` (with `lease`, `retries`, `retryDelay`, `retryBackoff`, `heartbeat`, `onReclaim`, `keepalive`), `ctx.step.ai.generateText/generateObject/streamText/map`, `ctx.ai` injection, `ctx.abortSignal`, the adapter seam, timeouts and the builder-first `defineWorkflow(...).stage(...)` API are documented in [12-durable-steps.md](12-durable-steps.md).

## SimpleStageResult

Return type for successful execution:

```typescript
interface SimpleStageResult<TOutput> {
  output: TOutput;                           // Required: validated output
  customMetrics?: Record<string, number>;    // Optional: custom metrics
  artifacts?: Record<string, unknown>;       // Optional: artifacts to store
}
```

### Examples

```typescript
// Minimal return
return { output: { result: "processed" } };

// With metrics
return {
  output: { items: processedItems },
  customMetrics: {
    itemsProcessed: processedItems.length,
    duplicatesRemoved: 5,
  },
};

// With artifacts
return {
  output: { summary: "..." },
  artifacts: {
    rawData: originalData,
    debugInfo: { steps: executionSteps },
  },
};
```

## SimpleSuspendedResult

Return type for suspending execution (async-batch stages only):

```typescript
interface SimpleSuspendedResult {
  suspended: true;                  // Required marker
  state: {
    batchId: string;               // Required: external job ID
    submittedAt?: string;          // Optional: ISO timestamp; defaults to now (deprecated in favour of pollConfig; back-filled for checkCompletion)
    pollInterval?: number;         // Optional: ms between checks; defaults to pollConfig.pollInterval or 30s (deprecated, same)
    maxWaitTime?: number;          // Optional: max wait ms; defaults to pollConfig.maxWaitTime or 24h (deprecated, same)
    metadata?: Record<string, unknown>;  // Optional: custom data (e.g. batchRefs)
    // `apiKey` was removed from the suspended state at 1.0 -- inject credentials through BatchOptions / providerResolver instead
  };
  pollConfig?: {                    // Optional (v0.11+): derived from `state` when omitted
    pollInterval: number;          // ms between polls
    maxWaitTime: number;           // max total wait
    nextPollAt: Date;              // first poll time
  };
  customMetrics?: Record<string, number>;
}
```

As of v0.11, only `state.batchId` is required — `pollConfig` (including `nextPollAt`) is derived automatically from `state.pollInterval` / `state.maxWaitTime` (or the 30s/24h defaults) when omitted.

### Example

```typescript
async execute(ctx) {
  const batchId = await submitBatch(requests);

  // Minimal form — everything else is derived
  return { suspended: true, state: { batchId } };
}
```

Or specify your own timing:

```typescript
async execute(ctx) {
  const batchId = await submitBatch(requests);

  return {
    suspended: true,
    state: {
      batchId,
      submittedAt: new Date().toISOString(),
      pollInterval: 60000,
      maxWaitTime: 3600000,
      metadata: { requestCount: requests.length },
    },
    // pollConfig is optional — this override is equivalent to the derived default
    pollConfig: {
      pollInterval: 60000,
      maxWaitTime: 3600000,
      nextPollAt: new Date(Date.now() + 60000),
    },
  };
}
```

## CompletionCheckResult

Return type for `checkCompletion`:

```typescript
interface CompletionCheckResult<TOutput> {
  ready: boolean;                  // Is the batch complete?
  output?: TOutput;                // Output if ready=true
  error?: string;                  // Error message if failed
  nextCheckIn?: number;            // ms until next check (if not ready)
  metrics?: Record<string, number>;
  embeddings?: unknown;            // Optional embedding info
}
```

### Examples

```typescript
// Not ready yet
return { ready: false, nextCheckIn: 30000 };

// Completed successfully
return {
  ready: true,
  output: { results: batchResults },
  metrics: { itemsProcessed: batchResults.length },
};

// Failed
return {
  ready: false,
  error: "Batch processing failed: timeout exceeded",
};
```

## CheckCompletionContext

Context passed to `checkCompletion`:

```typescript
interface CheckCompletionContext<TConfig> {
  workflowRunId: string;
  stageId: string;
  stageRecordId?: string;          // For AI logging context
  config: TConfig;
  step: StepApi;                   // 1.0: same ledger rows execute() writes (scoped to this stage record)
  ai: AIHelper;                    // 1.0: scoped AIHelper, lazy
  aiLogger: AICallLogger;
  onLog: LogFunction;              // returns void
  log: LogFunction;                // Alias for onLog
  annotate: AnnotateFn;            // buffered, flushed with the completion transaction
  storage: StageStorage;
}
```

`step`, `ai` and `aiLogger` are required on a hand-built `CheckCompletionContext` as of 1.0, exactly as on `StageContext`.

## Complete Examples

### Data Extraction Stage

```typescript
const extractionStage = defineStage({
  id: "data-extraction",
  name: "Data Extraction",
  description: "Extracts structured data from documents",

  schemas: {
    input: z.object({
      documentUrl: z.string().url(),
      format: z.enum(["pdf", "docx", "html"]),
    }),
    output: z.object({
      title: z.string(),
      sections: z.array(z.object({
        heading: z.string(),
        content: z.string(),
      })),
      metadata: z.object({
        pageCount: z.number(),
        wordCount: z.number(),
      }),
    }),
    config: z.object({
      extractImages: z.boolean().default(false),
      maxPages: z.number().default(100),
    }),
  },

  async execute(ctx) {
    ctx.log("INFO", `Extracting from ${ctx.input.documentUrl}`);

    const document = await fetchDocument(ctx.input.documentUrl);
    const extracted = await extractContent(document, {
      format: ctx.input.format,
      extractImages: ctx.config.extractImages,
      maxPages: ctx.config.maxPages,
    });

    return {
      output: extracted,
      customMetrics: {
        pagesProcessed: extracted.metadata.pageCount,
        sectionsFound: extracted.sections.length,
      },
    };
  },
});
```

### AI Classification Stage

```typescript
const ClassificationOutputSchema = z.object({
  categories: z.array(z.string()),
  confidence: z.number(),
  reasoning: z.string(),
});

const classificationStage = defineStage({
  id: "classification",
  name: "Content Classification",
  dependencies: ["data-extraction"],

  schemas: {
    input: "none",
    output: ClassificationOutputSchema,
    config: z.object({
      model: z.string().default("gemini-2.5-flash"),
      minConfidence: z.number().default(0.8),
    }),
  },

  async execute(ctx) {
    const extraction = ctx.require("data-extraction");

    // ctx.ai is scoped to workflow.<runId>.stage.classification; ctx.step.ai.generateObject
    // is the durable (replay-safe) form of the same call — see 12-durable-steps.md
    const { object } = await ctx.ai.generateObject(
      ctx.config.model,
      `Classify this document:\n\n${extraction.sections.map(s => s.content).join("\n")}`,
      ClassificationOutputSchema
    );

    return { output: object };
  },
});
```

### Batch Processing Stage (legacy async-batch mode)

```typescript
const batchEmbeddingStage = defineStage({
  id: "batch-embeddings",
  name: "Batch Embeddings",
  mode: "async-batch",
  dependencies: ["data-extraction"],

  schemas: {
    input: "none",
    output: z.object({
      embeddings: z.array(z.object({
        sectionId: z.number(),
        vector: z.array(z.number()),
      })),
    }),
    config: z.object({
      model: z.string().default("text-embedding-004"),
    }),
  },

  async execute(ctx) {
    // Check for resume
    if (ctx.resumeState) {
      const cached = await ctx.storage.load("embeddings-result");
      if (cached) return { output: cached };
    }

    const extraction = ctx.require("data-extraction");
    const texts = extraction.sections.map(s => s.content);

    // Submit batch
    const batch = ctx.ai.batch(ctx.config.model, "google");
    const handle = await batch.submit(
      texts.map((text, i) => ({ id: `section-${i}`, prompt: text }))
    );

    return {
      suspended: true,
      state: {
        batchId: handle.id,
        submittedAt: new Date().toISOString(),
        pollInterval: 30000,
        maxWaitTime: 1800000,
        metadata: {
          sectionCount: texts.length,
          batchRefs: handle.refs,
        },
      },
      pollConfig: {
        pollInterval: 30000,
        maxWaitTime: 1800000,
        nextPollAt: new Date(Date.now() + 30000),
      },
    };
  },

  async checkCompletion(state, ctx) {
    const batch = ctx.ai.batch(ctx.config.model, "google");

    const status = await batch.getStatus(state.batchId, state.metadata);

    if (status.status === "completed") {
      const results = await batch.getResults(state.batchId, state.metadata);
      const embeddings = results.map((r, i) => ({
        sectionId: i,
        vector: r.result as number[],
      }));

      // Cache for resume
      await ctx.storage.save("embeddings-result", { embeddings });

      return { ready: true, output: { embeddings } };
    }

    if (status.status === "failed") {
      return { ready: false, error: "Batch embedding failed" };
    }

    return { ready: false, nextCheckIn: 30000 };
  },
});
```

## NoInputSchema

For stages that only use workflow context:

```typescript
import { NoInputSchema } from "@bratsos/workflow-engine";

// These are equivalent:
schemas: { input: "none", ... }
schemas: { input: NoInputSchema, ... }
```

## Type Inference Utilities

```typescript
import type {
  InferStageInput,
  InferStageOutput,
  InferStageConfig,
} from "@bratsos/workflow-engine";

// Extract types from a stage
type Input = InferStageInput<typeof myStage>;
type Output = InferStageOutput<typeof myStage>;
type Config = InferStageConfig<typeof myStage>;
```
