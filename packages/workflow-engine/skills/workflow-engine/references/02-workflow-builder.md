# WorkflowBuilder

Complete API for building type-safe workflows with sequential and parallel stages.

## Creating a Workflow

`defineWorkflow` has two forms. The workflow's output schema is always the last stage's `outputSchema` (or the merged object of the last parallel group); there is no separate output option.

```typescript
import { defineWorkflow } from "@bratsos/workflow-engine";
import { z } from "zod";

// id + options: name defaults to the id, input defaults to z.unknown()
const workflow = defineWorkflow("workflow-id", { input: InputSchema })
  .stage("first", { schemas: { ... }, execute })
  .build();

// options object
const workflow = defineWorkflow({
  id: "workflow-id",
  name: "Workflow Name",
  description: "Description",
  input: InputSchema,
})
  .pipe(stage1)
  .pipe(stage2)
  .build();
```

`new WorkflowBuilder(id, name, description, inputSchema, outputSchema)` is the low-level constructor both forms use; it is supported but easy to mistype because two positional arguments share the type `z.ZodTypeAny`.

### version(version)

Every built workflow carries a definition version — by default a `sha256-…` hash of its structure (stage ids and order, execution groups, dependencies, modes and every schema; not stage names or bodies). `.version("2026-09-04.1")` declares one explicitly instead; re-registering the same explicit version with a different structure throws `DefinitionVersionConflictError`. Runs are pinned to the version they were created under. See [13-definition-versioning.md](13-definition-versioning.md).

```typescript
const workflow = defineWorkflow("repository", { input: In })
  .stage("index", { /* ... */ })
  .version("2026-09-04.1")
  .build();

workflow.definitionVersion;      // "2026-09-04.1" (or "sha256-…" when derived)
workflow.getDefinitionSnapshot(); // the structure the version identifies
```

## WorkflowBuilder Methods

### stage(id, definition) / stage(prebuiltStage)

Define and add a stage in one call. The definition is the shape `defineStage` accepts (sync or async-batch) minus `id`; `name` defaults to the id. Its context type is the context accumulated so far, so `ctx.require()` is typed and `dependencies` only accepts earlier stage ids. Reusing an id is a type error and a runtime error. See [12-durable-steps.md](12-durable-steps.md#the-builder) for the full walkthrough.

```typescript
const workflow = defineWorkflow("repository", { input: In })
  .stage("chapter-index", {
    schemas: { input: In, output: ChapterIndex, config: z.object({}) },
    async execute(ctx) { /* ... */ },
  })
  .stage("unified-extract", {
    dependencies: ["chapter-index"],          // type error if not an earlier id
    schemas: { input: "none", output: Extract, config: z.object({}) },
    async execute(ctx) {
      const idx = ctx.require("chapter-index"); // z.infer<typeof ChapterIndex>
      return { output: { count: idx.chapters.length } };
    },
  })
  .stage(prebuiltStage)                        // defineStage() result; id/output read from its generics
  .build();
```

### pipe(stage)

Add a stage built with `defineStage` to execute sequentially after the previous stage. Same as `.stage(prebuiltStage)` without the duplicate-id check. Both forms check a prebuilt stage's declared context (the `TContext` of `defineStage<TContext>()`) against the context accumulated so far: a stage that requires a key no earlier stage produces, or produces with an incompatible type, no longer compiles — the parameter resolves to `{ __error: "stage requires context keys not produced by earlier stages: ..." }`. Stages built without an explicit context are unaffected.

```typescript
const workflow = defineWorkflow({ ... })
  .pipe(extractionStage)     // Execution group 1
  .pipe(processingStage)     // Execution group 2
  .pipe(outputStage)         // Execution group 3
  .build();
```

Each `.pipe()` call:
- Creates a new execution group
- Validates stage dependencies against existing stages
- Accumulates the stage output in the workflow context

### parallel(stages)

Add multiple stages that execute concurrently in the same execution group.

Two forms. The array form takes stages built with `defineStage`; the callback form takes inline definitions with the same typed context as `.stage()`. Members see the context accumulated *before* the group (they cannot depend on each other) and every member output is available after it.

```typescript
defineWorkflow("fan-out", { input: In })
  .stage("index", { /* ... */ })
  .parallel((group) =>
    group
      .stage("left", { dependencies: ["index"], schemas: { /* ... */ }, execute })
      .stage("right", { schemas: { /* ... */ }, execute })
      .stage(prebuiltStage),
  )
  .stage("join", {
    dependencies: ["left", "right"],
    schemas: { /* ... */ },
    async execute(ctx) {
      ctx.require("left");  // typed
      ctx.require("right"); // typed
      /* ... */
    },
  });
```

```typescript
const workflow = defineWorkflow({ ... })
  .pipe(extractionStage)                    // Group 1
  .parallel([classifyStage, summarizeStage]) // Group 2 (parallel)
  .pipe(mergeStage)                          // Group 3
  .build();
```

Parallel stages:
- Run in the same execution group
- Receive the same input (output from previous group)
- Must not depend on each other
- Their outputs are merged into the workflow context keyed by stage ID (e.g., `{ "classify": classifyOutput, "summarize": summarizeOutput }`)
- Subsequent stages access each parallel stage's output via `ctx.require("classify")`, `ctx.require("summarize")`, etc.

### build()

Finalize and return the `Workflow` object.

```typescript
const workflow = builder.build();

// Workflow is immutable after build()
```

## Workflow Class Methods

### getExecutionPlan()

Returns stages grouped by execution order.

```typescript
const plan = workflow.getExecutionPlan();
// [
//   [{ stage: extractionStage, executionGroup: 1 }],
//   [{ stage: classifyStage, executionGroup: 2 },
//    { stage: summarizeStage, executionGroup: 2 }],
//   [{ stage: mergeStage, executionGroup: 3 }]
// ]
```

### getAllStages()

Returns every `StageNode` (`{ stage, executionGroup }`) flat, in execution order.

### getStageIds()

Returns all stage IDs in execution order.

```typescript
const ids = workflow.getStageIds();
// ["extraction", "classify", "summarize", "merge"]
```

### getStage(stageId)

Get a specific stage by ID.

```typescript
const stage = workflow.getStage("extraction");
if (stage) {
  console.log(stage.name);
}
```

### hasStage(stageId)

Check if a stage exists.

```typescript
if (workflow.hasStage("optional-stage")) {
  // ...
}
```

### getStageConfigs()

Get configuration metadata for all stages.

```typescript
const configs = workflow.getStageConfigs();
// {
//   "extraction": {
//     schema: ZodObject,
//     defaults: { maxPages: 100 },
//     name: "Data Extraction",
//     description: "..."
//   },
//   ...
// }
```

### getDefaultConfig()

Generate default configuration for all stages.

```typescript
const config = workflow.getDefaultConfig();
// {
//   "extraction": { maxPages: 100, extractImages: false },
//   "classify": { model: "gemini-2.5-flash" },
//   ...
// }
```

### validateConfig(config)

Validate a configuration object.

```typescript
const result = workflow.validateConfig({
  extraction: { maxPages: -1 }, // Invalid!
  classify: { model: "invalid" },
});

if (!result.valid) {
  for (const error of result.errors) {
    console.log(`${error.stageId}: ${error.error}`);
  }
}
```

### getStagesInExecutionGroup(groupIndex)

Get stages in a specific execution group.

```typescript
const parallelStages = workflow.getStagesInExecutionGroup(2);
// [classifyStage, summarizeStage]
```

### getStageIndex(stageId)

Get the sequential index of a stage (0-based).

```typescript
const index = workflow.getStageIndex("classify");
// 1
```

### getExecutionGroupIndex(stageId)

Get the execution group for a stage.

```typescript
const group = workflow.getExecutionGroupIndex("classify");
// 2
```

### getPreviousStageId(stageId)

Get the ID of the stage immediately before.

```typescript
const prevId = workflow.getPreviousStageId("merge");
// "summarize" (last in previous group)
```

## Type Inference

### InferWorkflowContext

Extract the accumulated context type from a workflow.

```typescript
import type { InferWorkflowContext } from "@bratsos/workflow-engine";

type MyContext = InferWorkflowContext<typeof workflow>;
// {
//   "extraction": ExtractionOutput;
//   "classify": ClassifyOutput;
//   "summarize": SummarizeOutput;
// }
```

### InferWorkflowInput / InferWorkflowOutput

Extract input/output types.

```typescript
import type {
  InferWorkflowInput,
  InferWorkflowOutput,
} from "@bratsos/workflow-engine";

type Input = InferWorkflowInput<typeof workflow>;
type Output = InferWorkflowOutput<typeof workflow>;
```

### InferWorkflowStageIds

Extract stage IDs as a union type.

```typescript
import type { InferWorkflowStageIds } from "@bratsos/workflow-engine";

type StageId = InferWorkflowStageIds<typeof workflow>;
// "extraction" | "classify" | "summarize" | "merge"
```

### InferStageOutputById

Get the output type for a specific stage.

```typescript
import type { InferStageOutputById } from "@bratsos/workflow-engine";

type ExtractionOutput = InferStageOutputById<typeof workflow, "extraction">;
```

## Dependency Validation

The builder validates dependencies at build time:

```typescript
const stageA = defineStage({
  id: "stage-a",
  dependencies: ["stage-b"], // ERROR: stage-b doesn't exist yet!
  // ...
});

// This will throw an error:
defineWorkflow({ ... })
  .pipe(stageA)  // Throws: "stage-a" has missing dependencies: stage-b
  .pipe(stageB)
  .build();

// Correct order:
defineWorkflow({ ... })
  .pipe(stageB)  // Add dependency first
  .pipe(stageA)  // Now stage-a can depend on stage-b
  .build();
```

## Complete Example

```typescript
import { defineWorkflow, defineStage } from "@bratsos/workflow-engine";
import { z } from "zod";

// Define stages
const extractStage = defineStage({
  id: "extract",
  name: "Extract Data",
  schemas: {
    input: z.object({ url: z.string() }),
    output: z.object({ text: z.string(), metadata: z.any() }),
    config: z.object({ maxLength: z.number().default(50000) }),
  },
  async execute(ctx) {
    const data = await fetch(ctx.input.url).then(r => r.text());
    return { output: { text: data.slice(0, ctx.config.maxLength), metadata: {} } };
  },
});

const classifyStage = defineStage({
  id: "classify",
  name: "Classify Content",
  dependencies: ["extract"],
  schemas: {
    input: "none",
    output: z.object({ categories: z.array(z.string()) }),
    config: z.object({}),
  },
  async execute(ctx) {
    const { text } = ctx.require("extract");
    // Classification logic...
    return { output: { categories: ["tech", "news"] } };
  },
});

const summarizeStage = defineStage({
  id: "summarize",
  name: "Summarize",
  dependencies: ["extract"],
  schemas: {
    input: "none",
    output: z.object({ summary: z.string() }),
    config: z.object({ maxWords: z.number().default(100) }),
  },
  async execute(ctx) {
    const { text } = ctx.require("extract");
    // Summarization logic...
    return { output: { summary: text.slice(0, 500) } };
  },
});

const mergeStage = defineStage({
  id: "merge",
  name: "Merge Results",
  dependencies: ["classify", "summarize"],
  schemas: {
    input: "none",
    output: z.object({
      summary: z.string(),
      categories: z.array(z.string()),
    }),
    config: z.object({}),
  },
  async execute(ctx) {
    const classify = ctx.require("classify");
    const summarize = ctx.require("summarize");
    return {
      output: {
        summary: summarize.summary,
        categories: classify.categories,
      },
    };
  },
});

// Build workflow
const documentWorkflow = defineWorkflow({
  id: "document-analysis",
  name: "Document Analysis",
  description: "Analyzes documents: extracts, classifies, and summarizes",
  input: z.object({ url: z.string().url() }),
})
  .pipe(extractStage)
  .parallel([classifyStage, summarizeStage])
  .pipe(mergeStage)
  .build();

// Use the workflow
console.log("Execution groups:", documentWorkflow.getExecutionPlan().length);
console.log("Default config:", documentWorkflow.getDefaultConfig());

// Validate custom config
const validation = documentWorkflow.validateConfig({
  extract: { maxLength: 5000 },
  summarize: { maxWords: 50 },
});

if (!validation.valid) {
  console.error("Config errors:", validation.errors);
}
```

## Execution Flow

```
Input → [Group 1: extract] → [Group 2: classify, summarize (parallel)] → [Group 3: merge] → Output
                ↓                         ↓              ↓                      ↓
           workflowContext:          Gets extract    Gets extract         Gets both
           { extract: ... }          output          output               outputs
```

The workflow context accumulates all stage outputs, making them available to subsequent stages via `ctx.require()` or `ctx.optional()`.
