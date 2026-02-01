# Stage Definitions

Complete API reference for `defineStage` and `defineAsyncBatchStage`.

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

## defineAsyncBatchStage

Creates an asynchronous stage that can suspend execution and resume later.

```typescript
import { defineAsyncBatchStage } from "@bratsos/workflow-engine";

const batchStage = defineAsyncBatchStage({
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

  // Services
  log: LogFunction;                // Async logging
  storage: StageStorage;           // Artifact storage

  // Resume state (for async-batch stages)
  resumeState?: SuspendedState;    // Present when resuming

  // Fluent helpers
  require<K>(stageId: K): TContext[K];     // Get required output
  optional<K>(stageId: K): TContext[K] | undefined;  // Get optional output
}
```

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

```typescript
async execute(ctx) {
  await ctx.log("INFO", "Starting processing");
  await ctx.log("DEBUG", "Input received", { count: ctx.input.items.length });

  try {
    // ... processing
    await ctx.log("INFO", "Processing complete");
  } catch (error) {
    await ctx.log("ERROR", "Processing failed", { error: error.message });
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
    submittedAt: string;           // Required: ISO timestamp
    pollInterval: number;          // Required: ms between checks
    maxWaitTime: number;           // Required: max wait ms
    metadata?: Record<string, unknown>;  // Optional: custom data
    apiKey?: string;               // Optional: for resumption
  };
  pollConfig: {
    pollInterval: number;          // ms between polls
    maxWaitTime: number;           // max total wait
    nextPollAt: Date;              // first poll time
  };
  customMetrics?: Record<string, number>;
}
```

### Example

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
  stageRecordId: string;           // For AI logging context
  config: TConfig;
  log: LogFunction;
  onLog: LogFunction;              // Alias for log
  storage: StageStorage;
}
```

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
    await ctx.log("INFO", `Extracting from ${ctx.input.documentUrl}`);

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
const classificationStage = defineStage({
  id: "classification",
  name: "Content Classification",
  dependencies: ["data-extraction"],

  schemas: {
    input: "none",
    output: z.object({
      categories: z.array(z.string()),
      confidence: z.number(),
      reasoning: z.string(),
    }),
    config: z.object({
      model: z.string().default("gemini-2.5-flash"),
      minConfidence: z.number().default(0.8),
    }),
  },

  async execute(ctx) {
    const extraction = ctx.require("data-extraction");

    const ai = createAIHelper("classification", aiLogger);
    const { object } = await ai.generateObject(
      ctx.config.model,
      `Classify this document:\n\n${extraction.sections.map(s => s.content).join("\n")}`,
      ctx.schemas.output
    );

    return { output: object };
  },
});
```

### Batch Processing Stage

```typescript
const batchEmbeddingStage = defineAsyncBatchStage({
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
    const ai = createAIHelper(`batch.${ctx.workflowRunId}`, aiLogger);
    const batch = ai.batch(ctx.config.model, "google");
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
        metadata: { sectionCount: texts.length },
      },
      pollConfig: {
        pollInterval: 30000,
        maxWaitTime: 1800000,
        nextPollAt: new Date(Date.now() + 30000),
      },
    };
  },

  async checkCompletion(state, ctx) {
    const ai = createAIHelper(`batch.${ctx.workflowRunId}`, aiLogger);
    const batch = ai.batch(ctx.config.model, "google");

    const status = await batch.getStatus(state.batchId);

    if (status.status === "completed") {
      const results = await batch.getResults(state.batchId);
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
