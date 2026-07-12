---
sidebar_position: 1
title: Workflows and Stages
---

# Workflows and Stages

Workflows in **workflow-engine** are built as a sequence of **execution groups**. Each execution group contains one or more **stages**. 

---

## Defining a Stage

A stage is an atomic, retryable step of execution. You define a stage using either `defineStage` (for standard execution) or `defineAsyncBatchStage` (for long-running, suspendable processes). Every stage must define:
1. **`id`**: Unique string identifier.
2. **`name`**: A human-friendly display name.
3. **`schemas`**: Zod schemas defining its validated `input`, `output`, and `config`.
4. **`execute`**: The core execution function.

### Standard Sync Stage
Standard stages execute immediately and complete in a single invocation.

```typescript
import { defineStage } from "@bratsos/workflow-engine";
import { z } from "zod";

export const extractTextStage = defineStage({
  id: "extract-text",
  name: "Extract Text",
  schemas: {
    input: z.object({ url: z.string().url() }),
    output: z.object({ text: z.string(), wordCount: z.number() }),
    config: z.object({ maxLength: z.number().default(50000) }),
  },
  async execute(ctx) {
    const response = await fetch(ctx.input.url);
    const text = (await response.text()).slice(0, ctx.config.maxLength);
    return {
      output: { 
        text, 
        wordCount: text.split(/\s+/).length 
      },
    };
  },
});
```

### Typed Context with the Curried Form

The example above lets TypeScript infer everything from `schemas`, but `ctx.require()`/`ctx.optional()` stay untyped unless you also tell `defineStage` what the workflow **context** looks like. Call the **curried form** — `defineStage<TContext>()({ ... })` — supplying only the context type and letting TypeScript infer the stage's `id` (as a string literal), input, output, and config from the definition object itself:

```typescript
type MyContext = { "previous-stage": { value: string } };

export const myStage = defineStage<MyContext>()({
  id: "my-stage",              // TId inferred as the literal "my-stage"
  name: "My Stage",
  schemas: { input: InputSchema, output: OutputSchema, config: ConfigSchema },
  async execute(ctx) {
    const prev = ctx.require("previous-stage"); // typed via MyContext
    return { output: { /* ... */ } };
  },
});
```

The older form that spells out all five generics positionally (`defineStage<TId, TInput, TOutput, TConfig, TContext>({...})`) still works but is deprecated in favor of the curried form above — spelling out all five by hand is verbose, and silently loses `TId` string-literal inference if any of them are mistyped.

---

## Defining a Workflow

Workflows chain stages together. The recommended way to build a workflow is `defineWorkflow`, an options-object API; the positional `WorkflowBuilder` constructor still works but is deprecated in its favor.

### `defineWorkflow` API (recommended)

`defineWorkflow` returns the same `WorkflowBuilder` instance but accepts a cleaner options object instead of positional arguments. Since the final output schema is implicitly set by the output of the final stage in the pipeline, you can omit the output schema from the arguments.

```typescript
import { defineWorkflow } from "@bratsos/workflow-engine";
import { z } from "zod";
import { extractTextStage } from "./stages";

export const myWorkflow = defineWorkflow({
  id: "text-analyzer",
  name: "Text Analyzer",
  description: "Downloads and analyzes text",
  input: z.object({ url: z.string().url() }),
})
  .pipe(extractTextStage)
  .build();
```

### Positional `WorkflowBuilder` API (deprecated)

**Deprecated:** `inputSchema` and the output schema are both plain `z.ZodTypeAny`, so positional arguments of the same type are easy to transpose by accident. Prefer `defineWorkflow` above instead.

```typescript
import { WorkflowBuilder } from "@bratsos/workflow-engine";
import { z } from "zod";
import { extractTextStage } from "./stages";

export const myWorkflow = new WorkflowBuilder(
  "text-analyzer",                  // Workflow ID
  "Text Analyzer",                  // Display Name
  "Downloads and analyzes text",    // Description
  z.object({ url: z.string().url() }), // Input Schema
  z.object({ wordCount: z.number() })  // Final Output Schema
)
  .pipe(extractTextStage)
  .build();
```

---

## Pipeline Control: Sequential vs. Parallel

Workflows are built incrementally by chaining `.pipe()` and `.parallel()` onto the builder.

### Sequential execution (`.pipe`)
`.pipe()` schedules a single stage to run after all previously added stages.

```typescript
const workflow = defineWorkflow({ ... })
  .pipe(extractStage) // Execution Group 1
  .pipe(summarizeStage) // Execution Group 2 (runs after Group 1 completes)
  .build();
```

### Parallel execution (`.parallel`)
`.parallel()` runs multiple independent stages concurrently in the same execution group. Parallel stages receive the same input (the cumulative workflow context from the previous group).

```typescript
const workflow = defineWorkflow({ ... })
  .pipe(extractStage)
  .parallel([
    sentimentAnalysisStage, // stage id: "sentiment"
    keywordExtractionStage,  // stage id: "keywords"
  ])
  .pipe(generateReportStage)
  .build();
```

---

## State & Workflow Context

When stages run, their outputs are saved to the **Workflow Context** database record. The context maps stage IDs to their outputs.

### Accessing Context: `ctx.require` and `ctx.optional`
Within a stage's `execute` function, you can retrieve outputs of preceding stages from the context:

* **`ctx.require(stageId)`**: Gets the output of a preceding stage. Throws a compile-time and runtime error if the stage did not run or is not declared in dependencies.
* **`ctx.optional(stageId)`**: Gets the output of a preceding stage, returning `undefined` if it was not run.

For stages executing after a `.parallel()` block, the outputs are keyed by their respective stage IDs:

```typescript
// Inside generateReportStage's execute(ctx)
async execute(ctx) {
  // Retrieve outputs from the concurrent group
  const sentiment = ctx.require("sentiment"); // output of sentimentAnalysisStage
  const keywords = ctx.require("keywords");   // output of keywordExtractionStage
  
  // These are fully type-safe based on their respective Zod definitions!
  ctx.log("INFO", `Sentiment was: ${sentiment.sentiment}`);
  
  return {
    output: {
      report: `Sentiment: ${sentiment.sentiment}. Keywords: ${keywords.list.join(", ")}`
    }
  };
}
```

---

## Zod Schema Design Best Practices

To maximize the benefits of type-safety and AI integrations, follow these design principles:

### 1. Default and Optional Fields
Utilize `.default()` and `.optional()` in config schemas. Hosts auto-generate default configurations from these schemas.
```typescript
const ConfigSchema = z.object({
  model: z.string().default("gemini-2.5-flash"),
  temperature: z.number().min(0).max(2).default(0.7),
  promptPrefix: z.string().optional(),
});
```

### 2. No-Input / Context-Only Stages
If a stage reads entirely from previous stages and doesn't require any immediate input when launched, set its input schema to `"none"` (or import `NoInputSchema`):
```typescript
schemas: {
  input: "none",
  output: OutputSchema,
  config: ConfigSchema,
}
```
