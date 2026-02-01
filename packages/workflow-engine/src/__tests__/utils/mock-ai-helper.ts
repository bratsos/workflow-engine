/**
 * Mock AI Helper
 *
 * A complete mock implementation of AIHelper for testing.
 * Supports configurable responses, call tracking, and simulated errors.
 */

import type { z } from "zod";
import type {
  AIHelper,
  AITextResult,
  AIObjectResult,
  AIEmbedResult,
  AIStreamResult,
  AIBatch,
  BatchRequest,
  BatchHandle,
  BatchResult,
  TextOptions,
  ObjectOptions,
  EmbedOptions,
  StreamOptions,
  TextInput,
  StreamTextInput,
  RecordCallParams,
  AIHelperStats,
  AICallType,
  BatchProvider,
} from "../../ai/ai-helper.js";
import type { ModelKey } from "../../ai/model-helper.js";

// ============================================================================
// Types
// ============================================================================

export interface MockTextResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export interface MockObjectResponse<T = unknown> {
  object: T;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export interface MockEmbedResponse {
  embedding: number[];
  embeddings?: number[][];
  dimensions?: number;
  inputTokens?: number;
  cost?: number;
}

export interface MockBatchResult<T = string> {
  id: string;
  result: T;
  inputTokens?: number;
  outputTokens?: number;
  status?: "succeeded" | "failed";
  error?: string;
}

export interface MockAIHelperConfig {
  /** Default response for generateText calls */
  defaultTextResponse?: MockTextResponse;
  /** Default response for generateObject calls */
  defaultObjectResponse?: MockObjectResponse;
  /** Default response for embed calls */
  defaultEmbedResponse?: MockEmbedResponse;
  /** Map of prompt patterns to specific responses */
  textResponses?: Map<string | RegExp, MockTextResponse>;
  /** Map of prompt patterns to specific object responses */
  objectResponses?: Map<string | RegExp, MockObjectResponse>;
  /** Whether to simulate errors */
  shouldError?: boolean;
  /** Error message when shouldError is true */
  errorMessage?: string;
  /** Delay in ms to simulate latency */
  latencyMs?: number;
}

export interface RecordedCall {
  type: AICallType;
  modelKey: ModelKey;
  prompt: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  options?: Record<string, unknown>;
  timestamp: Date;
}

// ============================================================================
// MockAIHelper Implementation
// ============================================================================

export class MockAIHelper implements AIHelper {
  readonly topic: string;
  private config: MockAIHelperConfig;
  private calls: RecordedCall[] = [];
  private children: MockAIHelper[] = [];
  private parent?: MockAIHelper;

  constructor(
    topic: string,
    config: MockAIHelperConfig = {},
    parent?: MockAIHelper,
  ) {
    this.topic = topic;
    this.config = {
      defaultTextResponse: {
        text: "mock response",
        inputTokens: 10,
        outputTokens: 20,
        cost: 0.001,
      },
      defaultObjectResponse: {
        object: {},
        inputTokens: 10,
        outputTokens: 20,
        cost: 0.001,
      },
      defaultEmbedResponse: {
        embedding: new Array(768).fill(0).map(() => Math.random()),
        dimensions: 768,
        inputTokens: 5,
        cost: 0.0001,
      },
      ...config,
    };
    this.parent = parent;
  }

  // ============================================================================
  // Core AI Methods
  // ============================================================================

  async generateText<
    TTools extends Record<string, unknown> = Record<string, unknown>,
  >(
    modelKey: ModelKey,
    prompt: TextInput,
    options?: TextOptions<TTools>,
  ): Promise<AITextResult> {
    await this.simulateLatency();
    this.checkForError();

    const promptStr = this.extractPromptString(prompt);
    const response = this.findMatchingTextResponse(promptStr);

    const result: AITextResult = {
      text: response.text,
      inputTokens: response.inputTokens ?? 10,
      outputTokens: response.outputTokens ?? 20,
      cost: response.cost ?? 0.001,
    };

    this.recordCallInternal({
      type: "text",
      modelKey,
      prompt: promptStr,
      response: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cost: result.cost,
      options: options as Record<string, unknown>,
      timestamp: new Date(),
    });

    return result;
  }

  async generateObject<TSchema extends z.ZodTypeAny>(
    modelKey: ModelKey,
    prompt: TextInput,
    schema: TSchema,
    options?: ObjectOptions,
  ): Promise<AIObjectResult<z.infer<TSchema>>> {
    await this.simulateLatency();
    this.checkForError();

    const promptStr = this.extractPromptString(prompt);
    const response = this.findMatchingObjectResponse(promptStr);

    const result: AIObjectResult<z.infer<TSchema>> = {
      object: response.object as z.infer<TSchema>,
      inputTokens: response.inputTokens ?? 10,
      outputTokens: response.outputTokens ?? 20,
      cost: response.cost ?? 0.001,
    };

    this.recordCallInternal({
      type: "object",
      modelKey,
      prompt: promptStr,
      response: JSON.stringify(result.object),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cost: result.cost,
      options: options as Record<string, unknown>,
      timestamp: new Date(),
    });

    return result;
  }

  async embed(
    modelKey: ModelKey,
    text: string | string[],
    options?: EmbedOptions,
  ): Promise<AIEmbedResult> {
    await this.simulateLatency();
    this.checkForError();

    const texts = Array.isArray(text) ? text : [text];
    const defaultResponse = this.config.defaultEmbedResponse!;

    const embeddings = texts.map(
      () =>
        defaultResponse.embedding ??
        new Array(768).fill(0).map(() => Math.random()),
    );

    const result: AIEmbedResult = {
      embedding: embeddings[0]!,
      embeddings,
      dimensions: options?.dimensions ?? defaultResponse.dimensions ?? 768,
      inputTokens: defaultResponse.inputTokens ?? 5 * texts.length,
      cost: defaultResponse.cost ?? 0.0001 * texts.length,
    };

    this.recordCallInternal({
      type: "embed",
      modelKey,
      prompt: texts.join("\n"),
      response: `[${embeddings.length} embeddings, ${result.dimensions} dims]`,
      inputTokens: result.inputTokens,
      outputTokens: 0,
      cost: result.cost,
      options: options as Record<string, unknown>,
      timestamp: new Date(),
    });

    return result;
  }

  streamText(
    modelKey: ModelKey,
    input: StreamTextInput,
    options?: StreamOptions,
  ): AIStreamResult {
    const promptStr =
      "prompt" in input && input.prompt
        ? input.prompt
        : JSON.stringify(input.messages);

    const response = this.findMatchingTextResponse(promptStr);
    const chunks = response.text.split(" ");
    let chunkIndex = 0;

    const streamIterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<string>> => {
          if (this.config.shouldError) {
            throw new Error(this.config.errorMessage ?? "Mock stream error");
          }

          if (this.config.latencyMs) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.config.latencyMs! / chunks.length),
            );
          }

          if (chunkIndex >= chunks.length) {
            return { done: true, value: undefined };
          }

          const chunk =
            chunks[chunkIndex]! + (chunkIndex < chunks.length - 1 ? " " : "");
          chunkIndex++;
          options?.onChunk?.(chunk);
          return { done: false, value: chunk };
        },
      }),
    };

    const inputTokens = response.inputTokens ?? 10;
    const outputTokens = response.outputTokens ?? 20;
    const cost = response.cost ?? 0.001;

    this.recordCallInternal({
      type: "stream",
      modelKey,
      prompt: promptStr,
      response: response.text,
      inputTokens,
      outputTokens,
      cost,
      options: options as Record<string, unknown>,
      timestamp: new Date(),
    });

    return {
      stream: streamIterable,
      getUsage: async () => ({ inputTokens, outputTokens, cost }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rawResult: {} as any, // Mock raw result
    };
  }

  batch<T = string>(modelKey: ModelKey, _provider?: BatchProvider): AIBatch<T> {
    return new MockAIBatch<T>(this, modelKey);
  }

  // ============================================================================
  // Hierarchy Methods
  // ============================================================================

  createChild(segment: string, id?: string): AIHelper {
    const newTopic = id
      ? `${this.topic}.${segment}.${id}`
      : `${this.topic}.${segment}`;
    const child = new MockAIHelper(newTopic, this.config, this);
    this.children.push(child);
    return child;
  }

  // ============================================================================
  // Recording Methods
  // ============================================================================

  recordCall(
    paramsOrModelKey: RecordCallParams | ModelKey,
    prompt?: string,
    response?: string,
    tokens?: { input: number; output: number },
    options?: {
      callType?: AICallType;
      isBatch?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): void {
    if (
      typeof paramsOrModelKey === "object" &&
      "modelKey" in paramsOrModelKey
    ) {
      const params = paramsOrModelKey as RecordCallParams;
      this.recordCallInternal({
        type: params.callType,
        modelKey: params.modelKey,
        prompt: params.prompt,
        response: params.response,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        cost: 0,
        options: params.metadata,
        timestamp: new Date(),
      });
    } else {
      this.recordCallInternal({
        type: options?.callType ?? "text",
        modelKey: paramsOrModelKey as ModelKey,
        prompt: prompt ?? "",
        response: response ?? "",
        inputTokens: tokens?.input ?? 0,
        outputTokens: tokens?.output ?? 0,
        cost: 0,
        options: options?.metadata,
        timestamp: new Date(),
      });
    }
  }

  async getStats(): Promise<AIHelperStats> {
    const allCalls = this.getAllCallsRecursive();
    const stats: AIHelperStats = {
      totalCalls: allCalls.length,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      perModel: {},
    };

    for (const call of allCalls) {
      stats.totalInputTokens += call.inputTokens;
      stats.totalOutputTokens += call.outputTokens;
      stats.totalCost += call.cost;

      if (!stats.perModel[call.modelKey]) {
        stats.perModel[call.modelKey] = {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        };
      }
      stats.perModel[call.modelKey]!.calls++;
      stats.perModel[call.modelKey]!.inputTokens += call.inputTokens;
      stats.perModel[call.modelKey]!.outputTokens += call.outputTokens;
      stats.perModel[call.modelKey]!.cost += call.cost;
    }

    return stats;
  }

  // ============================================================================
  // Test Helpers (not part of interface)
  // ============================================================================

  /**
   * Configure the mock to return specific text for a prompt pattern
   */
  setTextResponse(pattern: string | RegExp, response: MockTextResponse): void {
    if (!this.config.textResponses) {
      this.config.textResponses = new Map();
    }
    this.config.textResponses.set(pattern, response);
  }

  /**
   * Configure the mock to return specific object for a prompt pattern
   */
  setObjectResponse(
    pattern: string | RegExp,
    response: MockObjectResponse,
  ): void {
    if (!this.config.objectResponses) {
      this.config.objectResponses = new Map();
    }
    this.config.objectResponses.set(pattern, response);
  }

  /**
   * Configure the mock to throw errors
   */
  setError(shouldError: boolean, message?: string): void {
    this.config.shouldError = shouldError;
    if (message) {
      this.config.errorMessage = message;
    }
  }

  /**
   * Configure simulated latency
   */
  setLatency(ms: number): void {
    this.config.latencyMs = ms;
  }

  /**
   * Get all recorded calls for this helper
   */
  getCalls(): RecordedCall[] {
    return [...this.calls];
  }

  /**
   * Get all recorded calls including children
   */
  getAllCallsRecursive(): RecordedCall[] {
    const allCalls = [...this.calls];
    for (const child of this.children) {
      allCalls.push(...child.getAllCallsRecursive());
    }
    return allCalls;
  }

  /**
   * Get calls by type
   */
  getCallsByType(type: AICallType): RecordedCall[] {
    return this.calls.filter((c) => c.type === type);
  }

  /**
   * Get calls by model
   */
  getCallsByModel(modelKey: ModelKey): RecordedCall[] {
    return this.calls.filter((c) => c.modelKey === modelKey);
  }

  /**
   * Get the last call made
   */
  getLastCall(): RecordedCall | null {
    if (this.calls.length === 0) return null;
    return this.calls[this.calls.length - 1]!;
  }

  /**
   * Clear all recorded calls
   */
  clearCalls(): void {
    this.calls = [];
    for (const child of this.children) {
      child.clearCalls();
    }
  }

  /**
   * Get child helpers
   */
  getChildren(): MockAIHelper[] {
    return [...this.children];
  }

  /**
   * Reset the mock to default state
   */
  reset(): void {
    this.clearCalls();
    this.children = [];
    this.config.shouldError = false;
    this.config.latencyMs = undefined;
    this.config.textResponses?.clear();
    this.config.objectResponses?.clear();
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private extractPromptString(prompt: TextInput): string {
    if (typeof prompt === "string") {
      return prompt;
    }
    return (
      prompt
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n") || "[multimodal content]"
    );
  }

  private findMatchingTextResponse(prompt: string): MockTextResponse {
    if (this.config.textResponses) {
      for (const [pattern, response] of this.config.textResponses) {
        if (typeof pattern === "string" && prompt.includes(pattern)) {
          return response;
        }
        if (pattern instanceof RegExp && pattern.test(prompt)) {
          return response;
        }
      }
    }
    return this.config.defaultTextResponse!;
  }

  private findMatchingObjectResponse(prompt: string): MockObjectResponse {
    if (this.config.objectResponses) {
      for (const [pattern, response] of this.config.objectResponses) {
        if (typeof pattern === "string" && prompt.includes(pattern)) {
          return response;
        }
        if (pattern instanceof RegExp && pattern.test(prompt)) {
          return response;
        }
      }
    }
    return this.config.defaultObjectResponse!;
  }

  private async simulateLatency(): Promise<void> {
    if (this.config.latencyMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.latencyMs),
      );
    }
  }

  private checkForError(): void {
    if (this.config.shouldError) {
      throw new Error(this.config.errorMessage ?? "Mock AI error");
    }
  }

  private recordCallInternal(call: RecordedCall): void {
    this.calls.push(call);
    // Also propagate to parent for aggregate stats
    if (this.parent) {
      this.parent.recordCallInternal(call);
    }
  }
}

// ============================================================================
// MockAIBatch Implementation
// ============================================================================

class MockAIBatch<T = string> implements AIBatch<T> {
  private submittedBatches = new Map<string, BatchRequest[]>();
  private batchResults = new Map<string, BatchResult<T>[]>();
  private batchStatuses = new Map<string, BatchHandle["status"]>();
  private recordedBatches = new Set<string>();

  constructor(
    private helper: MockAIHelper,
    private modelKey: ModelKey,
  ) {}

  async submit(requests: BatchRequest[]): Promise<BatchHandle> {
    const batchId = `mock-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.submittedBatches.set(batchId, requests);
    this.batchStatuses.set(batchId, "pending");

    // Generate mock results
    const results: BatchResult<T>[] = requests.map((req) => ({
      id: req.id,
      prompt: req.prompt,
      result: `mock result for ${req.id}` as unknown as T,
      inputTokens: 10,
      outputTokens: 20,
      status: "succeeded" as const,
    }));
    this.batchResults.set(batchId, results);

    // Simulate processing
    setTimeout(() => {
      this.batchStatuses.set(batchId, "completed");
    }, 100);

    return { id: batchId, status: "pending", provider: "google" };
  }

  async getStatus(batchId: string): Promise<BatchHandle> {
    const status = this.batchStatuses.get(batchId) ?? "pending";
    return { id: batchId, status, provider: "google" };
  }

  async getResults(
    batchId: string,
    _metadata?: Record<string, unknown>,
  ): Promise<BatchResult<T>[]> {
    const results = this.batchResults.get(batchId);
    if (!results) {
      throw new Error(`Batch not found: ${batchId}`);
    }

    // Auto-record
    await this.recordResults(batchId, results);

    return results;
  }

  async isRecorded(batchId: string): Promise<boolean> {
    return this.recordedBatches.has(batchId);
  }

  async recordResults(
    batchId: string,
    results: BatchResult<T>[],
  ): Promise<void> {
    if (this.recordedBatches.has(batchId)) {
      return;
    }

    this.recordedBatches.add(batchId);

    // Record each result
    for (const result of results) {
      this.helper.recordCall({
        modelKey: this.modelKey,
        callType: "batch",
        prompt: result.prompt,
        response:
          typeof result.result === "string"
            ? result.result
            : JSON.stringify(result.result),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        metadata: { batchId, requestId: result.id },
      });
    }
  }

  // Test helpers

  /**
   * Set custom results for a batch
   */
  setResults(batchId: string, results: MockBatchResult<T>[]): void {
    const fullResults: BatchResult<T>[] = results.map((r) => ({
      id: r.id,
      prompt: "",
      result: r.result,
      inputTokens: r.inputTokens ?? 10,
      outputTokens: r.outputTokens ?? 20,
      status: r.status ?? "succeeded",
      error: r.error,
    }));
    this.batchResults.set(batchId, fullResults);
    this.batchStatuses.set(batchId, "completed");
  }

  /**
   * Set batch status
   */
  setStatus(batchId: string, status: BatchHandle["status"]): void {
    this.batchStatuses.set(batchId, status);
  }

  /**
   * Get submitted requests for a batch
   */
  getSubmittedRequests(batchId: string): BatchRequest[] | undefined {
    return this.submittedBatches.get(batchId);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a mock AI helper for testing.
 *
 * @param topic - Initial topic path
 * @param config - Configuration for mock responses
 * @returns MockAIHelper instance
 *
 * @example
 * ```typescript
 * const ai = createMockAIHelper("test");
 *
 * // Configure specific responses
 * ai.setTextResponse("extract", { text: "extracted data" });
 *
 * // Use in tests
 * const result = await ai.generateText("gemini-2.5-flash", "extract this");
 * expect(result.text).toBe("extracted data");
 *
 * // Verify calls
 * expect(ai.getCalls()).toHaveLength(1);
 * ```
 */
export function createMockAIHelper(
  topic: string = "test",
  config: MockAIHelperConfig = {},
): MockAIHelper {
  return new MockAIHelper(topic, config);
}
