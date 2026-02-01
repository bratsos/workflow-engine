# Testing Patterns

Complete guide for testing workflow stages and complete workflows.

## Test Utilities

The workflow engine provides testing utilities:

```typescript
import {
  TestWorkflowPersistence,
  TestJobQueue,
  MockAIHelper,
} from "@bratsos/workflow-engine/testing";
```

## TestWorkflowPersistence

In-memory implementation of `WorkflowPersistence` for testing:

```typescript
const persistence = new TestWorkflowPersistence();

// Create a run
const run = await persistence.createRun({
  workflowId: "test-workflow",
  workflowName: "Test Workflow",
  workflowType: "test",
  input: { data: "test" },
});

// Update and query
await persistence.updateRun(run.id, { status: "RUNNING" });
const retrieved = await persistence.getRun(run.id);

// Reset between tests
persistence.reset();
```

## TestJobQueue

In-memory implementation of `JobQueue`:

```typescript
const jobQueue = new TestJobQueue();

// Enqueue a job
const jobId = await jobQueue.enqueue({
  workflowRunId: "run-123",
  stageId: "stage-1",
  priority: 5,
});

// Dequeue
const job = await jobQueue.dequeue();

// Complete or fail
await jobQueue.complete(jobId);
await jobQueue.fail(jobId, "Error message", true); // retry=true

// Reset between tests
jobQueue.reset();
```

## MockAIHelper

Mock implementation of `AIHelper` for predictable test results:

```typescript
const mockAI = new MockAIHelper();

// Mock generateText responses
mockAI.mockGenerateText("Expected text response");
mockAI.mockGenerateText("Second response"); // Queue multiple

// Mock generateObject responses
mockAI.mockGenerateObject({
  title: "Test Title",
  tags: ["test", "mock"],
});

// Mock embeddings
mockAI.mockEmbed([0.1, 0.2, 0.3, /* ... */]);

// Mock errors
mockAI.mockError(new Error("API rate limit"));

// Use in tests
const result = await mockAI.generateText("gemini-2.5-flash", "Any prompt");
// Returns "Expected text response"

// Check calls
console.log(mockAI.calls.length);        // Number of calls
console.log(mockAI.calls[0].modelKey);   // Model used
console.log(mockAI.calls[0].prompt);     // Prompt sent

// Reset between tests
mockAI.reset();
```

## Testing Individual Stages

### Unit Testing a Sync Stage

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { TestWorkflowPersistence, MockAIHelper } from "@bratsos/workflow-engine/testing";
import { myStage } from "./my-stage";

describe("myStage", () => {
  let persistence: TestWorkflowPersistence;
  let mockAI: MockAIHelper;

  beforeEach(() => {
    persistence = new TestWorkflowPersistence();
    mockAI = new MockAIHelper();
  });

  it("should process input correctly", async () => {
    // Arrange
    const input = { data: "test input" };
    const config = { verbose: true };

    // Create context
    const ctx = {
      input,
      config,
      workflowContext: {},
      workflowRunId: "test-run",
      stageId: "my-stage",
      log: async () => {},
      storage: persistence.createStorage("test-run"),
      require: (id: string) => {
        throw new Error(`Stage ${id} not found`);
      },
      optional: (id: string) => undefined,
    };

    // Act
    const result = await myStage.execute(ctx);

    // Assert
    expect(result.output).toBeDefined();
    expect(result.output.processedData).toBe("TEST INPUT");
  });

  it("should use AI helper correctly", async () => {
    // Mock AI response
    mockAI.mockGenerateObject({ classification: "tech" });

    const ctx = {
      input: { text: "AI content" },
      config: {},
      workflowContext: {},
      workflowRunId: "test-run",
      stageId: "ai-stage",
      log: async () => {},
      storage: persistence.createStorage("test-run"),
      require: () => ({}),
      optional: () => undefined,
      // Inject mock AI helper
      ai: mockAI,
    };

    const result = await aiStage.execute(ctx);

    // Verify AI was called
    expect(mockAI.calls.length).toBe(1);
    expect(mockAI.calls[0].modelKey).toBe("gemini-2.5-flash");

    // Verify result
    expect(result.output.classification).toBe("tech");
  });

  it("should handle errors gracefully", async () => {
    mockAI.mockError(new Error("API error"));

    const ctx = createTestContext({ ai: mockAI });

    await expect(myStage.execute(ctx)).rejects.toThrow("API error");
  });
});
```

### Testing Stage with Dependencies

```typescript
it("should access previous stage output", async () => {
  // Setup workflow context with previous stage output
  const workflowContext = {
    "data-extraction": {
      title: "Test Document",
      sections: [{ heading: "Intro", content: "..." }],
    },
  };

  const ctx = {
    input: {},
    config: {},
    workflowContext,
    workflowRunId: "test-run",
    stageId: "processing-stage",
    log: async () => {},
    storage: persistence.createStorage("test-run"),
    require: (id: string) => {
      const output = workflowContext[id];
      if (!output) throw new Error(`Missing ${id}`);
      return output;
    },
    optional: (id: string) => workflowContext[id],
  };

  const result = await processingStage.execute(ctx);

  expect(result.output.processedTitle).toBe("Test Document");
});
```

## Testing Async Batch Stages

### Testing Execute (Suspension)

```typescript
it("should suspend and return batch info", async () => {
  const ctx = createTestContext({
    workflowContext: {
      "data-extraction": { items: ["a", "b", "c"] },
    },
  });

  const result = await batchStage.execute(ctx);

  // Verify suspended result
  expect(result.suspended).toBe(true);
  expect(result.state.batchId).toBeDefined();
  expect(result.state.pollInterval).toBe(60000);
  expect(result.pollConfig.nextPollAt).toBeInstanceOf(Date);
});
```

### Testing Execute (Resume)

```typescript
it("should return cached results on resume", async () => {
  // Setup storage with cached results
  await persistence.saveArtifact({
    workflowRunId: "test-run",
    key: "batch-result",
    type: "ARTIFACT",
    data: { items: ["processed-a", "processed-b"] },
    size: 100,
  });

  const ctx = createTestContext({
    resumeState: {
      batchId: "batch-123",
      submittedAt: new Date().toISOString(),
      pollInterval: 60000,
      maxWaitTime: 3600000,
    },
  });

  const result = await batchStage.execute(ctx);

  expect(result.suspended).toBeUndefined();
  expect(result.output.items).toEqual(["processed-a", "processed-b"]);
});
```

### Testing checkCompletion

```typescript
import { vi } from "vitest";

describe("checkCompletion", () => {
  it("should return not ready when batch is processing", async () => {
    // Mock batch API
    vi.spyOn(batchProvider, "getStatus").mockResolvedValue({
      status: "processing",
    });

    const result = await batchStage.checkCompletion(
      { batchId: "batch-123", submittedAt: "...", pollInterval: 60000, maxWaitTime: 3600000 },
      { workflowRunId: "test-run", stageId: "batch-stage", config: {}, log: async () => {}, storage: persistence.createStorage("test-run") }
    );

    expect(result.ready).toBe(false);
    expect(result.nextCheckIn).toBe(60000);
  });

  it("should return results when batch is completed", async () => {
    vi.spyOn(batchProvider, "getStatus").mockResolvedValue({ status: "completed" });
    vi.spyOn(batchProvider, "getResults").mockResolvedValue([
      { id: "req-1", result: "processed", inputTokens: 100, outputTokens: 50, status: "succeeded" },
    ]);

    const result = await batchStage.checkCompletion(
      { batchId: "batch-123", submittedAt: "...", pollInterval: 60000, maxWaitTime: 3600000 },
      createCheckContext()
    );

    expect(result.ready).toBe(true);
    expect(result.output.items).toHaveLength(1);
  });

  it("should return error when batch fails", async () => {
    vi.spyOn(batchProvider, "getStatus").mockResolvedValue({ status: "failed" });

    const result = await batchStage.checkCompletion(
      { batchId: "batch-123", submittedAt: "...", pollInterval: 60000, maxWaitTime: 3600000 },
      createCheckContext()
    );

    expect(result.ready).toBe(false);
    expect(result.error).toBeDefined();
  });
});
```

## Integration Testing Workflows

### Testing Complete Workflow

```typescript
import { WorkflowExecutor } from "@bratsos/workflow-engine";

describe("documentWorkflow integration", () => {
  let persistence: TestWorkflowPersistence;
  let mockAI: MockAIHelper;

  beforeEach(() => {
    persistence = new TestWorkflowPersistence();
    mockAI = new MockAIHelper();

    // Setup mock responses for all AI calls
    mockAI.mockGenerateObject({ title: "Test", sections: [] });
    mockAI.mockGenerateObject({ categories: ["tech"] });
    mockAI.mockGenerateText("This is a summary.");
  });

  it("should execute complete workflow", async () => {
    // Create run record
    const run = await persistence.createRun({
      workflowId: "document-analysis",
      workflowName: "Document Analysis",
      workflowType: "document-analysis",
      input: { documentUrl: "https://example.com/doc.pdf" },
    });

    // Create executor
    const executor = new WorkflowExecutor(
      documentWorkflow,
      run.id,
      "document-analysis",
      {
        persistence,
        aiLogger: createMockAILogger(),
      }
    );

    // Execute
    const result = await executor.execute(
      { documentUrl: "https://example.com/doc.pdf" },
      documentWorkflow.getDefaultConfig()
    );

    // Verify
    expect(result.status).toBe("COMPLETED");

    // Check stages were created
    const stages = await persistence.getStagesByRun(run.id);
    expect(stages.length).toBe(4);
    expect(stages.every(s => s.status === "COMPLETED")).toBe(true);
  });
});
```

### Testing with Runtime

```typescript
describe("workflow with runtime", () => {
  let runtime: WorkflowRuntime;
  let persistence: TestWorkflowPersistence;
  let jobQueue: TestJobQueue;

  beforeEach(() => {
    persistence = new TestWorkflowPersistence();
    jobQueue = new TestJobQueue();

    runtime = createWorkflowRuntime({
      persistence,
      jobQueue,
      registry: { getWorkflow: (id) => workflows[id] ?? null },
      pollIntervalMs: 100,
      jobPollIntervalMs: 50,
    });
  });

  afterEach(() => {
    runtime.stop();
  });

  it("should process workflow through runtime", async () => {
    // Create run
    const { workflowRunId } = await runtime.createRun({
      workflowId: "simple-workflow",
      input: { data: "test" },
    });

    // Start runtime (in test mode)
    await runtime.start();

    // Wait for completion
    await waitFor(async () => {
      const run = await persistence.getRun(workflowRunId);
      return run?.status === "COMPLETED";
    }, { timeout: 5000 });

    // Verify
    const run = await persistence.getRun(workflowRunId);
    expect(run?.status).toBe("COMPLETED");
  });
});
```

## Test Helpers

### Creating Test Context

```typescript
function createTestContext<TInput, TConfig>(
  overrides: Partial<{
    input: TInput;
    config: TConfig;
    workflowContext: Record<string, unknown>;
    resumeState: unknown;
    ai: MockAIHelper;
  }> = {}
) {
  const persistence = new TestWorkflowPersistence();

  return {
    input: overrides.input ?? {},
    config: overrides.config ?? {},
    workflowContext: overrides.workflowContext ?? {},
    workflowRunId: "test-run",
    stageId: "test-stage",
    resumeState: overrides.resumeState,
    log: async (level: string, message: string) => {
      console.log(`[${level}] ${message}`);
    },
    storage: persistence.createStorage("test-run"),
    require: (id: string) => {
      const output = overrides.workflowContext?.[id];
      if (!output) throw new Error(`Missing required stage: ${id}`);
      return output;
    },
    optional: (id: string) => overrides.workflowContext?.[id],
  };
}
```

### Wait Helper

```typescript
async function waitFor(
  condition: () => Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 5000, interval = 100 } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, interval));
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}
```

### Mock AI Logger

```typescript
function createMockAILogger(): AICallLogger {
  const calls: CreateAICallInput[] = [];

  return {
    logCall: (call) => { calls.push(call); },
    logBatchResults: async (batchId, results) => { calls.push(...results); },
    getStats: async (topic) => ({
      totalCalls: calls.filter(c => c.topic.startsWith(topic)).length,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      perModel: {},
    }),
    isRecorded: async (batchId) => calls.some(c => c.metadata?.batchId === batchId),
  };
}
```

## Best Practices

### 1. Isolate Tests

```typescript
beforeEach(() => {
  persistence.reset();
  jobQueue.reset();
  mockAI.reset();
});
```

### 2. Test Edge Cases

```typescript
it("should handle empty input", async () => { ... });
it("should handle missing dependencies", async () => { ... });
it("should handle AI errors", async () => { ... });
it("should handle timeout", async () => { ... });
```

### 3. Use Type-Safe Mocks

```typescript
// Bad: loosely typed
const ctx = { input: {}, config: {} } as any;

// Good: properly typed
const ctx = createTestContext<InputType, ConfigType>({
  input: { data: "test" },
  config: { verbose: true },
});
```

### 4. Test Metrics and Artifacts

```typescript
it("should record metrics", async () => {
  const result = await stage.execute(ctx);

  expect(result.customMetrics?.itemsProcessed).toBe(10);
  expect(result.artifacts?.rawData).toBeDefined();
});
```
