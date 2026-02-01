# AI Integration

Complete guide for using AIHelper for text generation, structured output, embeddings, and batch operations.

## Topic Convention for Cost Tracking

**Topics are hierarchical strings that enable cost aggregation at different levels.**

### The Convention

```
workflow.{workflowRunId}.stage.{stageId}.{optional-suffix}
```

| Topic Pattern | Use Case | Example |
|---------------|----------|---------|
| `workflow.{runId}` | Root topic for a workflow run | `workflow.abc123` |
| `workflow.{runId}.stage.{stageId}` | Specific stage | `workflow.abc123.stage.extraction` |
| `workflow.{runId}.stage.{stageId}.tool.{name}` | Tool call within a stage | `workflow.abc123.stage.extraction.tool.search` |
| `task.{taskId}` | Standalone task (not a workflow) | `task.process-document-456` |

### How Cost Aggregation Works

The `AICallLogger.getStats(topicPrefix)` method uses **prefix matching** to aggregate costs:

```typescript
// All AI calls are logged with their topic
ai.generateText("gemini-2.5-flash", prompt);  // Logged with topic "workflow.abc123.stage.extraction"

// Later, aggregate by prefix:
const workflowStats = await aiLogger.getStats("workflow.abc123");
// Returns: all costs for that workflow run (all stages)

const stageStats = await aiLogger.getStats("workflow.abc123.stage.extraction");
// Returns: costs for just that stage

const allStats = await aiLogger.getStats("workflow");
// Returns: costs for ALL workflows
```

### Automatic Workflow Cost Tracking

When a workflow completes, the executor automatically calculates total cost:

```typescript
// Inside WorkflowExecutor (automatic)
const stats = await aiLogger.getStats(`workflow.${workflowRunId}`);
await persistence.updateRun(workflowRunId, {
  totalCost: stats.totalCost,
  totalTokens: stats.totalInputTokens + stats.totalOutputTokens,
});
```

**Result:** `WorkflowRun.totalCost` and `WorkflowRun.totalTokens` are populated automatically.

### Using Topics in Stages

```typescript
const extractStage = defineStage({
  id: "extraction",
  // ...
  async execute(ctx) {
    // Create AI helper with proper topic convention
    const ai = runtime.createAIHelper(
      `workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`
    );

    // All AI calls are now tracked under this topic
    const { text } = await ai.generateText("gemini-2.5-flash", prompt);

    return { output: { extracted: text } };
  },
});
```

### Querying Costs

```typescript
// Get costs for a specific workflow run
const runStats = await aiLogger.getStats(`workflow.${workflowRunId}`);
console.log(`Workflow cost: $${runStats.totalCost.toFixed(4)}`);
console.log(`Total tokens: ${runStats.totalInputTokens + runStats.totalOutputTokens}`);
console.log(`Calls by model:`, runStats.perModel);

// Get costs for a specific stage
const stageStats = await aiLogger.getStats(`workflow.${workflowRunId}.stage.extraction`);

// Get costs across all workflows (for reporting)
const allStats = await aiLogger.getStats("workflow");
```

### Stats Response Type

```typescript
interface AIHelperStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  perModel: {
    [modelKey: string]: {
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    };
  };
}
```

## Creating an AIHelper

```typescript
import { createAIHelper } from "@bratsos/workflow-engine";
import { createPrismaAICallLogger } from "@bratsos/workflow-engine/persistence/prisma";

// Basic usage (with topic convention)
const ai = createAIHelper(`workflow.${runId}.stage.${stageId}`, aiCallLogger);

// With log context (for batch persistence)
const logContext = {
  workflowRunId: "run-123",
  stageRecordId: "stage-456",
  createLog: (data) => persistence.createLog(data),
};
const ai = createAIHelper("workflow.run-123", aiCallLogger, logContext);

// From runtime (preferred in stages)
const ai = runtime.createAIHelper(`workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`);
```

## AIHelper Interface

```typescript
interface AIHelper {
  readonly topic: string;

  generateText(modelKey, prompt, options?): Promise<AITextResult>;
  generateObject(modelKey, prompt, schema, options?): Promise<AIObjectResult>;
  embed(modelKey, text, options?): Promise<AIEmbedResult>;
  streamText(modelKey, input, options?): AIStreamResult;
  batch(modelKey, provider?): AIBatch;

  createChild(segment, id?): AIHelper;
  recordCall(params): void;
  getStats(): Promise<AIHelperStats>;
}
```

## generateText

Generate text from a prompt.

```typescript
const result = await ai.generateText(
  "gemini-2.5-flash",  // Model key
  "Explain quantum computing in simple terms",
  {
    temperature: 0.7,   // 0-2, default 0.7
    maxTokens: 1000,    // Max output tokens
  }
);

console.log(result.text);           // Generated text
console.log(result.inputTokens);    // Token count
console.log(result.outputTokens);
console.log(result.cost);           // Calculated cost
```

### Multimodal Input

```typescript
// With images/PDFs
const result = await ai.generateText("gemini-2.5-flash", [
  { type: "text", text: "What's in this image?" },
  {
    type: "file",
    data: imageBuffer,  // Buffer, Uint8Array, or base64 string
    mediaType: "image/png",
    filename: "image.png",
  },
]);
```

### With Tools

```typescript
import { tool } from "ai";

const result = await ai.generateText("gemini-2.5-flash", "What's the weather?", {
  tools: {
    getWeather: tool({
      description: "Get weather for a location",
      parameters: z.object({ location: z.string() }),
      execute: async ({ location }) => {
        return { temperature: 72, condition: "sunny" };
      },
    }),
  },
  toolChoice: "auto",  // or "required", "none", { type: "tool", toolName: "getWeather" }
  onStepFinish: async (step) => {
    console.log("Tool results:", step.toolResults);
  },
});
```

## generateObject

Generate structured output with Zod schema validation.

```typescript
const OutputSchema = z.object({
  title: z.string(),
  tags: z.array(z.string()),
  sentiment: z.enum(["positive", "negative", "neutral"]),
});

const result = await ai.generateObject(
  "gemini-2.5-flash",
  "Analyze this article: ...",
  OutputSchema,
  {
    temperature: 0,  // Lower for structured output
    maxTokens: 500,
  }
);

console.log(result.object);  // Typed as z.infer<typeof OutputSchema>
// { title: "...", tags: ["tech", "ai"], sentiment: "positive" }
```

### Multimodal with Schema

```typescript
const result = await ai.generateObject(
  "gemini-2.5-flash",
  [
    { type: "text", text: "Extract text from this document" },
    { type: "file", data: pdfBuffer, mediaType: "application/pdf" },
  ],
  z.object({
    title: z.string(),
    content: z.string(),
    pageCount: z.number(),
  })
);
```

## embed

Generate embeddings for text.

```typescript
// Single text
const result = await ai.embed(
  "text-embedding-004",
  "The quick brown fox",
  {
    dimensions: 768,  // Output dimensions (default: 768)
    taskType: "RETRIEVAL_DOCUMENT",  // or "RETRIEVAL_QUERY", "SEMANTIC_SIMILARITY"
  }
);

console.log(result.embedding);     // number[] (768 dimensions)
console.log(result.dimensions);    // 768
console.log(result.inputTokens);
console.log(result.cost);

// Multiple texts (batch)
const result = await ai.embed("text-embedding-004", [
  "First document",
  "Second document",
  "Third document",
]);

console.log(result.embeddings);    // number[][] (3 embeddings)
console.log(result.embedding);     // First embedding (convenience)
```

## streamText

Stream text generation.

```typescript
const result = ai.streamText(
  "gemini-2.5-flash",
  { prompt: "Write a story about a robot" },
  {
    temperature: 0.9,
    onChunk: (chunk) => process.stdout.write(chunk),
  }
);

// Consume the stream
for await (const chunk of result.stream) {
  console.log(chunk);
}

// Get usage after stream completes
const usage = await result.getUsage();
console.log(usage.cost);

// Or use raw AI SDK result for UI streaming
const response = result.rawResult.toUIMessageStreamResponse();
```

### With Messages

```typescript
const result = ai.streamText("gemini-2.5-flash", {
  system: "You are a helpful assistant.",
  messages: [
    { role: "user", content: "Hello!" },
    { role: "assistant", content: "Hi! How can I help?" },
    { role: "user", content: "Tell me a joke." },
  ],
});
```

## batch

Submit batch operations for 50% cost savings.

```typescript
const batch = ai.batch<OutputType>("claude-sonnet-4-20250514", "anthropic");

// Submit requests
const handle = await batch.submit([
  { id: "req-1", prompt: "Summarize: ..." },
  { id: "req-2", prompt: "Summarize: ...", schema: SummarySchema },
]);

console.log(handle.id);       // Batch ID
console.log(handle.status);   // "pending"
console.log(handle.provider); // "anthropic"

// Check status
const status = await batch.getStatus(handle.id);
// { id: "...", status: "processing" | "completed" | "failed", provider: "anthropic" }

// Get results (when completed)
const results = await batch.getResults(handle.id);
// [
//   { id: "req-1", result: "...", inputTokens: 100, outputTokens: 50, status: "succeeded" },
//   { id: "req-2", result: { parsed: "object" }, inputTokens: 100, outputTokens: 50, status: "succeeded" },
// ]

// Check if already recorded (avoid duplicate logging)
const recorded = await batch.isRecorded(handle.id);
```

### Batch Providers

| Provider | Models | Discount |
|----------|--------|----------|
| `anthropic` | Claude models | 50% |
| `google` | Gemini models | 50% |
| `openai` | GPT models | 50% |

```typescript
// Provider auto-detected based on model
const batch = ai.batch("claude-sonnet-4-20250514");  // Uses anthropic

// Or specify explicitly
const batch = ai.batch("gemini-2.5-flash", "google");
```

## Child Helpers

Create child helpers for hierarchical topic tracking.

```typescript
const rootAI = createAIHelper("workflow.abc123", logger);

// Create child for a specific stage
const stageAI = rootAI.createChild("stage", "extraction");
// topic: "workflow.abc123.stage.extraction"

// Create child for a tool call
const toolAI = stageAI.createChild("tool", "search");
// topic: "workflow.abc123.stage.extraction.tool.search"
```

## Manual Recording

Record AI calls made outside the helper (e.g., direct SDK usage).

```typescript
// Object-based API
ai.recordCall({
  modelKey: "gemini-2.5-flash",
  callType: "text",
  prompt: "...",
  response: "...",
  inputTokens: 100,
  outputTokens: 50,
  metadata: { custom: "data" },
});

// Legacy positional API
ai.recordCall(
  "gemini-2.5-flash",
  "prompt text",
  "response text",
  { input: 100, output: 50 },
  { callType: "text", isBatch: false }
);
```

## Statistics

Get aggregated stats for a topic prefix.

```typescript
const stats = await ai.getStats();
// {
//   totalCalls: 42,
//   totalInputTokens: 50000,
//   totalOutputTokens: 25000,
//   totalCost: 0.15,
//   perModel: {
//     "gemini-2.5-flash": { calls: 30, inputTokens: 40000, outputTokens: 20000, cost: 0.10 },
//     "claude-sonnet-4-20250514": { calls: 12, inputTokens: 10000, outputTokens: 5000, cost: 0.05 },
//   },
// }
```

## Model Configuration

### Available Models

```typescript
import { AVAILABLE_MODELS, listModels } from "@bratsos/workflow-engine";

// List all models
const models = listModels();
// [
//   { key: "gemini-2.5-flash", id: "google/gemini-2.5-flash-preview-05-20", ... },
//   { key: "claude-sonnet-4-20250514", id: "anthropic/claude-sonnet-4-20250514", ... },
//   ...
// ]

// Filter models
const flashModels = listModels({ provider: "google", capabilities: ["embedding"] });
```

### Register Custom Models

```typescript
import { registerModels } from "@bratsos/workflow-engine";

registerModels({
  "my-custom-model": {
    id: "openrouter/my-model",
    provider: "openrouter",
    inputCostPerMillion: 0.5,
    outputCostPerMillion: 1.0,
    contextWindow: 128000,
    maxOutput: 4096,
    capabilities: ["text", "vision"],
  },
});

// Now usable
const result = await ai.generateText("my-custom-model", prompt);
```

### Cost Calculation

```typescript
import { calculateCost } from "@bratsos/workflow-engine";

const cost = calculateCost("gemini-2.5-flash", 1000, 500);
// {
//   inputCost: 0.00015,
//   outputCost: 0.0003,
//   totalCost: 0.00045,
// }
```

## Result Types

```typescript
interface AITextResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  output?: any;  // Present when experimental_output is used
}

interface AIObjectResult<T> {
  object: T;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface AIEmbedResult {
  embedding: number[];      // First embedding
  embeddings: number[][];   // All embeddings
  dimensions: number;
  inputTokens: number;
  cost: number;
}

interface AIStreamResult {
  stream: AsyncIterable<string>;
  getUsage(): Promise<{ inputTokens, outputTokens, cost }>;
  rawResult: AISDKStreamResult;
}

interface AIBatchResult<T = string> {
  id: string;
  prompt: string;
  result: T;
  inputTokens: number;
  outputTokens: number;
  status: "succeeded" | "failed";
  error?: string;
}
```

## Complete Example

```typescript
import {
  createAIHelper,
  createPrismaAICallLogger,
  registerModels,
} from "@bratsos/workflow-engine";
import { z } from "zod";

// Setup
const logger = createPrismaAICallLogger(prisma);
const ai = createAIHelper("document-processor", logger);

// Register a custom model if needed
registerModels({
  "fast-model": {
    id: "openrouter/fast-model",
    provider: "openrouter",
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.2,
  },
});

// Processing pipeline
async function processDocument(content: string) {
  // 1. Extract structure
  const { object: structure } = await ai.generateObject(
    "gemini-2.5-flash",
    `Extract structure from:\n\n${content}`,
    z.object({
      title: z.string(),
      sections: z.array(z.object({
        heading: z.string(),
        content: z.string(),
      })),
    })
  );

  // 2. Generate embeddings for each section
  const embeddings = await ai.embed(
    "text-embedding-004",
    structure.sections.map(s => s.content)
  );

  // 3. Generate summary
  const { text: summary } = await ai.generateText(
    "gemini-2.5-flash",
    `Summarize in 2 sentences:\n\n${content}`,
    { maxTokens: 100 }
  );

  // 4. Check stats
  const stats = await ai.getStats();
  console.log(`Total cost: $${stats.totalCost.toFixed(4)}`);

  return {
    structure,
    embeddings: embeddings.embeddings,
    summary,
    cost: stats.totalCost,
  };
}
```
