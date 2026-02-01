# Common Patterns

Best practices, recipes, and troubleshooting for the workflow engine.

## Document Processing Pipeline

A common pattern for processing documents through multiple stages:

```typescript
import { WorkflowBuilder, defineStage } from "@bratsos/workflow-engine";
import { z } from "zod";

// Stage 1: Extract content
const extractStage = defineStage({
  id: "extract",
  name: "Extract Content",
  schemas: {
    input: z.object({ documentUrl: z.string().url() }),
    output: z.object({
      text: z.string(),
      metadata: z.object({
        title: z.string().optional(),
        pageCount: z.number(),
      }),
    }),
    config: z.object({
      maxPages: z.number().default(100),
    }),
  },
  async execute(ctx) {
    const content = await fetchAndExtract(ctx.input.documentUrl, ctx.config);
    return { output: content };
  },
});

// Stage 2: Analyze (parallel)
const classifyStage = defineStage({
  id: "classify",
  name: "Classify",
  dependencies: ["extract"],
  schemas: {
    input: "none",
    output: z.object({ categories: z.array(z.string()) }),
    config: z.object({ model: z.string().default("gemini-2.5-flash") }),
  },
  async execute(ctx) {
    const { text } = ctx.require("extract");
    const ai = createAIHelper("classify", aiLogger);
    const { object } = await ai.generateObject(ctx.config.model, text, ctx.schemas.output);
    return { output: object };
  },
});

const summarizeStage = defineStage({
  id: "summarize",
  name: "Summarize",
  dependencies: ["extract"],
  schemas: {
    input: "none",
    output: z.object({ summary: z.string() }),
    config: z.object({
      maxWords: z.number().default(200),
      model: z.string().default("gemini-2.5-flash"),
    }),
  },
  async execute(ctx) {
    const { text } = ctx.require("extract");
    const ai = createAIHelper("summarize", aiLogger);
    const { text: summary } = await ai.generateText(
      ctx.config.model,
      `Summarize in ${ctx.config.maxWords} words:\n\n${text}`
    );
    return { output: { summary } };
  },
});

// Stage 3: Merge results
const mergeStage = defineStage({
  id: "merge",
  name: "Merge Results",
  dependencies: ["classify", "summarize"],
  schemas: {
    input: "none",
    output: z.object({
      title: z.string().optional(),
      summary: z.string(),
      categories: z.array(z.string()),
    }),
    config: z.object({}),
  },
  async execute(ctx) {
    const extraction = ctx.require("extract");
    const classification = ctx.require("classify");
    const summary = ctx.require("summarize");

    return {
      output: {
        title: extraction.metadata.title,
        summary: summary.summary,
        categories: classification.categories,
      },
    };
  },
});

// Build workflow
const documentPipeline = new WorkflowBuilder(
  "document-pipeline",
  "Document Pipeline",
  "Extract, classify, and summarize documents",
  z.object({ documentUrl: z.string().url() }),
  z.object({ title: z.string().optional(), summary: z.string(), categories: z.array(z.string()) })
)
  .pipe(extractStage)
  .parallel([classifyStage, summarizeStage])
  .pipe(mergeStage)
  .build();
```

## AI Classification Workflow

Pattern for multi-label classification with confidence scores:

```typescript
const ClassificationSchema = z.object({
  labels: z.array(z.object({
    name: z.string(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  })),
  primaryLabel: z.string(),
});

const classificationStage = defineStage({
  id: "classification",
  name: "AI Classification",
  schemas: {
    input: z.object({ text: z.string() }),
    output: ClassificationSchema,
    config: z.object({
      model: z.string().default("gemini-2.5-flash"),
      labels: z.array(z.string()),
      minConfidence: z.number().default(0.7),
    }),
  },
  async execute(ctx) {
    const ai = createAIHelper("classification", aiLogger);

    const prompt = `Classify the following text into these categories: ${ctx.config.labels.join(", ")}

For each applicable label, provide:
- The label name
- A confidence score (0-1)
- Brief reasoning

Text to classify:
${ctx.input.text}`;

    const { object } = await ai.generateObject(ctx.config.model, prompt, ClassificationSchema);

    // Filter by minimum confidence
    const filtered = {
      ...object,
      labels: object.labels.filter(l => l.confidence >= ctx.config.minConfidence),
    };

    return { output: filtered };
  },
});
```

## Error Recovery Pattern

Graceful error handling with fallbacks:

```typescript
const robustStage = defineStage({
  id: "robust-stage",
  name: "Robust Stage",
  schemas: {
    input: z.object({ data: z.any() }),
    output: z.object({
      result: z.any(),
      usedFallback: z.boolean(),
      error: z.string().optional(),
    }),
    config: z.object({
      primaryModel: z.string().default("claude-sonnet-4-20250514"),
      fallbackModel: z.string().default("gemini-2.5-flash"),
      maxRetries: z.number().default(3),
    }),
  },
  async execute(ctx) {
    const ai = createAIHelper("robust", aiLogger);

    // Try primary model
    for (let attempt = 1; attempt <= ctx.config.maxRetries; attempt++) {
      try {
        const result = await ai.generateText(ctx.config.primaryModel, ctx.input.data);
        return {
          output: { result: result.text, usedFallback: false },
        };
      } catch (error) {
        await ctx.log("WARN", `Primary model failed (attempt ${attempt})`, {
          error: error.message,
        });

        if (attempt === ctx.config.maxRetries) break;
        await sleep(1000 * attempt); // Exponential backoff
      }
    }

    // Try fallback model
    try {
      await ctx.log("INFO", "Using fallback model");
      const result = await ai.generateText(ctx.config.fallbackModel, ctx.input.data);
      return {
        output: {
          result: result.text,
          usedFallback: true,
          error: "Primary model failed, used fallback",
        },
      };
    } catch (error) {
      await ctx.log("ERROR", "Fallback model also failed");
      throw new Error(`All models failed: ${error.message}`);
    }
  },
});
```

## Cost Optimization Strategies

### 1. Use Batch Operations

```typescript
// Instead of many individual calls
for (const item of items) {
  await ai.generateText(model, item.prompt);  // Expensive!
}

// Use batch for 50% savings
const batch = ai.batch(model, "anthropic");
const handle = await batch.submit(items.map((item, i) => ({
  id: `item-${i}`,
  prompt: item.prompt,
})));
```

### 2. Cache Expensive Results

```typescript
async execute(ctx) {
  const cacheKey = `result-${hash(ctx.input)}`;

  // Check cache
  if (await ctx.storage.exists(cacheKey)) {
    return { output: await ctx.storage.load(cacheKey) };
  }

  // Compute expensive result
  const result = await expensiveOperation(ctx.input);

  // Cache for future runs
  await ctx.storage.save(cacheKey, result);

  return { output: result };
}
```

### 3. Use Appropriate Models

```typescript
// Quick classification - use fast model
const { object } = await ai.generateObject("gemini-2.5-flash", prompt, schema);

// Complex reasoning - use powerful model
const { text } = await ai.generateText("claude-sonnet-4-20250514", complexPrompt, {
  maxTokens: 4000,
});
```

### 4. Optimize Token Usage

```typescript
// Truncate long inputs
const truncatedText = text.slice(0, 50000);

// Use structured output to reduce tokens
const { object } = await ai.generateObject(model, prompt, schema);
// vs: const { text } = await ai.generateText(model, prompt); JSON.parse(text);
```

## Logging Best Practices

### Structured Logging

```typescript
async execute(ctx) {
  await ctx.log("INFO", "Stage started", {
    inputSize: JSON.stringify(ctx.input).length,
    config: ctx.config,
  });

  try {
    const result = await processData(ctx.input);

    await ctx.log("INFO", "Processing complete", {
      itemsProcessed: result.items.length,
      duration: Date.now() - startTime,
    });

    return { output: result };
  } catch (error) {
    await ctx.log("ERROR", "Processing failed", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
```

### Log Levels

| Level | Use For |
|-------|---------|
| DEBUG | Detailed debugging info |
| INFO | Normal operations |
| WARN | Recoverable issues |
| ERROR | Failures |

## Type-Safe Context Passing

### Define Workflow Context Type

```typescript
// Define exact shape of workflow context
type MyWorkflowContext = {
  "extract": { text: string; metadata: { title: string } };
  "classify": { categories: string[] };
  "summarize": { summary: string };
};

// Use in stage definition
const mergeStage = defineStage<
  "none",
  typeof OutputSchema,
  typeof ConfigSchema,
  MyWorkflowContext
>({
  id: "merge",
  // ctx.require("extract") is now typed as { text: string; metadata: { title: string } }
  async execute(ctx) {
    const extract = ctx.require("extract"); // Typed!
    const classify = ctx.require("classify"); // Typed!
  },
});
```

### Infer from Workflow

```typescript
import type { InferWorkflowContext } from "@bratsos/workflow-engine";

const workflow = new WorkflowBuilder(...)
  .pipe(extractStage)
  .pipe(classifyStage)
  .build();

type WorkflowContext = InferWorkflowContext<typeof workflow>;
```

## Troubleshooting Guide

### Stage Not Found in Context

**Error**: `Missing required stage output: "stage-id"`

**Cause**: Stage dependency not in workflow or hasn't run yet.

**Fix**:
1. Check `dependencies` array includes the stage
2. Verify stage is added before dependent stage in workflow
3. Use `ctx.optional()` if stage is truly optional

### Batch Never Completes

**Symptoms**: Stage stays SUSPENDED forever

**Causes**:
1. `nextPollAt` not being updated
2. `maxWaitTime` too short
3. Batch provider issues

**Fix**:
```typescript
// In checkCompletion
return {
  ready: false,
  nextCheckIn: 60000,  // Make sure this is set
};

// Check batch status manually
const batch = ai.batch(model, provider);
const status = await batch.getStatus(batchId);
console.log("Batch status:", status);
```

### Type Mismatch in Workflow

**Error**: TypeScript errors about incompatible types

**Cause**: Output of one stage doesn't match input of next.

**Fix**:
1. Use `input: "none"` for stages that only use context
2. Ensure schemas match across stages
3. Use `.passthrough()` on Zod schemas for flexibility

### Prisma Enum Errors

**Error**: `Invalid value for argument 'status'. Expected Status`

**Cause**: Prisma 7.x requires typed enums, not strings

**Fix**: The library handles this automatically via the enum compatibility layer. If you see this error:
1. Ensure you're using `createPrismaWorkflowPersistence(prisma)`
2. Check you're not bypassing the persistence layer with direct Prisma calls

### Memory Issues with Large Batches

**Symptoms**: Process crashes or slows down

**Fix**:
```typescript
// Process in smaller batches
const CHUNK_SIZE = 100;
for (let i = 0; i < items.length; i += CHUNK_SIZE) {
  const chunk = items.slice(i, i + CHUNK_SIZE);
  await processChunk(chunk);
}

// Stream instead of loading all at once
for await (const chunk of streamResults(batchId)) {
  yield processChunk(chunk);
}
```

### Workflow Stuck in RUNNING

**Symptoms**: Workflow never completes

**Causes**:
1. Stage threw unhandled error
2. Job queue not processing
3. Worker crashed

**Fix**:
```typescript
// Check for failed stages
const stages = await persistence.getStagesByRun(runId);
const failed = stages.filter(s => s.status === "FAILED");
if (failed.length > 0) {
  console.log("Failed stages:", failed.map(s => ({ id: s.stageId, error: s.errorMessage })));
}

// Release stale jobs
await jobQueue.releaseStaleJobs(60000);
```

## Configuration Recipes

### Development Config

```typescript
const devConfig = {
  pollIntervalMs: 2000,
  jobPollIntervalMs: 500,
  staleJobThresholdMs: 30000,
};
```

### Production Config

```typescript
const prodConfig = {
  pollIntervalMs: 10000,
  jobPollIntervalMs: 1000,
  staleJobThresholdMs: 120000,
  workerId: `worker-${process.env.HOSTNAME}`,
};
```

### High-Throughput Config

```typescript
const throughputConfig = {
  pollIntervalMs: 5000,
  jobPollIntervalMs: 100,
  staleJobThresholdMs: 300000,
};
```
