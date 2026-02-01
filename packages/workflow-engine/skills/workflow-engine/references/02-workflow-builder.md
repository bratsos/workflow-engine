# WorkflowBuilder

Complete API for building type-safe workflows with sequential and parallel stages.

## Creating a Workflow

```typescript
import { WorkflowBuilder } from "@bratsos/workflow-engine";
import { z } from "zod";

const workflow = new WorkflowBuilder(
  "workflow-id",       // Unique identifier
  "Workflow Name",     // Display name
  "Description",       // Description
  InputSchema,         // Zod schema for workflow input
  OutputSchema         // Zod schema for final output
)
  .pipe(stage1)
  .pipe(stage2)
  .build();
```

## WorkflowBuilder Methods

### pipe(stage)

Add a stage to execute sequentially after the previous stage.

```typescript
const workflow = new WorkflowBuilder(...)
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

```typescript
const workflow = new WorkflowBuilder(...)
  .pipe(extractionStage)                    // Group 1
  .parallel([classifyStage, summarizeStage]) // Group 2 (parallel)
  .pipe(mergeStage)                          // Group 3
  .build();
```

Parallel stages:
- Run in the same execution group
- Receive the same input (output from previous group)
- Must not depend on each other

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

### getExecutionOrder()

Get a human-readable visualization of execution order.

```typescript
console.log(workflow.getExecutionOrder());
// Workflow: My Workflow (my-workflow)
// Total stages: 4
// Execution groups: 3
//
// Execution Order:
// ================
// 1. Data Extraction (extraction)
//    Extracts data from documents
//
// 2. [PARALLEL]
//    - Classification (classify)
//    - Summarization (summarize)
//
// 3. Merge Results (merge)
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

### estimateCost(input, config)

Estimate total workflow cost (if stages implement `estimateCost`).

```typescript
const cost = workflow.estimateCost(
  { documentUrl: "..." },
  workflow.getDefaultConfig()
);
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
new WorkflowBuilder(...)
  .pipe(stageA)  // Throws: "stage-a" has missing dependencies: stage-b
  .pipe(stageB)
  .build();

// Correct order:
new WorkflowBuilder(...)
  .pipe(stageB)  // Add dependency first
  .pipe(stageA)  // Now stage-a can depend on stage-b
  .build();
```

## Complete Example

```typescript
import { WorkflowBuilder, defineStage } from "@bratsos/workflow-engine";
import { z } from "zod";

// Define stages
const extractStage = defineStage({
  id: "extract",
  name: "Extract Data",
  schemas: {
    input: z.object({ url: z.string() }),
    output: z.object({ text: z.string(), metadata: z.any() }),
    config: z.object({ maxLength: z.number().default(10000) }),
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
const documentWorkflow = new WorkflowBuilder(
  "document-analysis",
  "Document Analysis",
  "Analyzes documents: extracts, classifies, and summarizes",
  z.object({ url: z.string().url() }),
  z.object({ summary: z.string(), categories: z.array(z.string()) })
)
  .pipe(extractStage)
  .parallel([classifyStage, summarizeStage])
  .pipe(mergeStage)
  .build();

// Use the workflow
console.log(documentWorkflow.getExecutionOrder());
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
