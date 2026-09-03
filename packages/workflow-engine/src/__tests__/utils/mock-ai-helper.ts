/**
 * Mock AI Helper
 *
 * A complete mock implementation of AIHelper for testing.
 * Supports configurable responses, call tracking, and simulated errors.
 */

import type { ToolSet } from "ai";
import type { z } from "zod";
import type {
  AIBatch,
  AIBatchHandle,
  AIBatchProvider,
  AIBatchRequest,
  AIBatchResult,
  AICallType,
  AIEmbedResult,
  AIHelper,
  AIHelperStats,
  AIObjectResult,
  AIStreamResult,
  AITextResult,
  BatchOptions,
  EmbedOptions,
  ObjectOptions,
  RecordCallParams,
  StreamOptions,
  StreamTextInput,
  TextInput,
  TextOptions,
} from "../../ai/ai-helper.js";
import type { ModelKey } from "../../ai/model-helper.js";
import { getModel } from "../../ai/model-helper.js";
import type { AIHelperFactory } from "../../kernel/ports.js";
import type { AICallLogger } from "../../persistence/interface.js";

// ============================================================================
// Types
// ============================================================================

export interface MockTextResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  /** Optional reasoning text, surfaced via AITextResult.reasoning / getReasoning() */
  reasoning?: string;
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

/** How a `failOnce` script decides whether a call is the one that throws. */
export type MockCallMatcher =
  | string
  | RegExp
  | ((call: MockCallDescriptor) => boolean);

/** The call a `failOnce` matcher is asked about. */
export interface MockCallDescriptor {
  modelKey: string;
  prompt: string;
  kind: "text" | "object" | "embed" | "stream";
}

/** One armed, not-yet-consumed `failOnce` script. */
export interface MockOneShotFailure {
  match: MockCallMatcher;
  error: Error;
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
  /**
   * Object responses keyed by Zod schema identity, consulted before the
   * prompt patterns. Seeded through `mockObjectResponseForSchema`.
   */
  schemaResponses?: Map<z.ZodTypeAny, MockObjectResponse>;
  /**
   * Armed one-shot failures, seeded through `failOnce`. The array (and the
   * schema map above) are shared by reference with every child helper, so a
   * script armed on the root helper fires on the stage-scoped child the
   * kernel actually hands to a stage.
   */
  failures?: MockOneShotFailure[];
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
  private callLogger?: AICallLogger;

  constructor(
    topic: string,
    config: MockAIHelperConfig = {},
    parent?: MockAIHelper,
    callLogger?: AICallLogger,
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
      // Shared-by-reference scripting state: `createAtTopic`/`createChild`
      // hand `this.config` to the child, whose own spread copies these two
      // references rather than cloning them.
      schemaResponses: new Map(),
      failures: [],
      ...config,
    };
    this.parent = parent;
    this.callLogger = callLogger;
  }

  // ============================================================================
  // Core AI Methods
  // ============================================================================

  async generateText<TTools extends ToolSet = ToolSet>(
    modelKey: ModelKey,
    prompt: TextInput,
    options?: TextOptions<TTools>,
  ): Promise<AITextResult> {
    await this.simulateLatency();
    this.checkForError();

    const promptStr = this.extractPromptString(prompt);
    this.consumeScriptedFailure({ modelKey, prompt: promptStr, kind: "text" });
    const response = this.findMatchingTextResponse(promptStr);

    const result: AITextResult = {
      text: response.text,
      inputTokens: response.inputTokens ?? 10,
      outputTokens: response.outputTokens ?? 20,
      cost: response.cost ?? 0.001,
      ...(response.reasoning ? { reasoning: response.reasoning } : {}),
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
    this.consumeScriptedFailure({
      modelKey,
      prompt: promptStr,
      kind: "object",
    });
    const response = this.findMatchingObjectResponse(promptStr, schema);

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
    this.consumeScriptedFailure({
      modelKey,
      prompt: texts.join("\n"),
      kind: "embed",
    });
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

    this.consumeScriptedFailure({
      modelKey,
      prompt: promptStr,
      kind: "stream",
    });
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
      getText: async () => response.text,
      getReasoning: async () => response.reasoning,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rawResult: {} as any, // Mock raw result
    };
  }

  batch<T = string>(
    modelKey: ModelKey,
    _provider?: AIBatchProvider,
    _options?: BatchOptions,
  ): AIBatch<T> {
    return new MockAIBatch<T>(this, modelKey);
  }

  // ============================================================================
  // Hierarchy Methods
  // ============================================================================

  createChild(segment: string, id?: string): AIHelper {
    const newTopic = id
      ? `${this.topic}.${segment}.${id}`
      : `${this.topic}.${segment}`;
    const child = this.createAtTopic(newTopic, this.callLogger);
    this.children.push(child);
    return child;
  }

  /**
   * Create a helper at an exact topic while sharing this mock's state.
   * Constructed through `this.constructor` so a subclass survives
   * `createChild` and the kernel's per-stage factory call.
   */
  createAtTopic(topic: string, callLogger?: AICallLogger): MockAIHelper {
    const Ctor = this.constructor as typeof MockAIHelper;
    return new Ctor(topic, this.config, this, callLogger);
  }

  // ============================================================================
  // Recording Methods
  // ============================================================================

  recordCall(params: RecordCallParams): void {
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
   * Register an object response keyed by Zod schema identity rather than by
   * prompt text. Consulted before the prompt patterns, so several
   * `generateObject` calls over near-identical prompts can be dispatched on
   * the schema they ask for.
   *
   * @example
   * ```typescript
   * mock.mockObjectResponseForSchema(SummarySchema, { summary: "ok" });
   * mock.mockObjectResponseForSchema(FactsSchema, { facts: [] });
   * ```
   */
  mockObjectResponseForSchema(
    schema: z.ZodTypeAny,
    value: unknown,
    meta?: Omit<MockObjectResponse, "object">,
  ): void {
    if (!this.config.schemaResponses) {
      this.config.schemaResponses = new Map();
    }
    this.config.schemaResponses.set(schema, { object: value, ...meta });
  }

  /**
   * Arm a one-shot failure: the next call matching `match` throws `error`
   * once, and every later call succeeds normally. This is how a
   * replay-safety test says "make exactly one item throw once" without
   * flipping `setError` on and off around the call.
   *
   * A string matches when the prompt contains it, a RegExp when it tests
   * true against the prompt, and a predicate when it returns true for the
   * call descriptor. Scripts are shared with child helpers, so arming one on
   * the factory's root helper fires inside a stage.
   *
   * @example
   * ```typescript
   * mock.failOnce("item-2", new Error("subscription limit reached"));
   * ```
   */
  failOnce(match: MockCallMatcher, error?: Error): void {
    if (!this.config.failures) this.config.failures = [];
    this.config.failures.push({
      match,
      error: error ?? new Error("Mock scripted failure"),
    });
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
    this.config.schemaResponses?.clear();
    this.config.failures?.splice(0, this.config.failures.length);
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

  /**
   * Throw and consume the first armed `failOnce` script matching this call.
   */
  private consumeScriptedFailure(call: MockCallDescriptor): void {
    const failures = this.config.failures;
    if (!failures || failures.length === 0) return;
    const index = failures.findIndex((failure) => {
      if (typeof failure.match === "string") {
        return call.prompt.includes(failure.match);
      }
      if (failure.match instanceof RegExp)
        return failure.match.test(call.prompt);
      return failure.match(call);
    });
    if (index === -1) return;
    const [failure] = failures.splice(index, 1);
    throw failure!.error;
  }

  private findMatchingObjectResponse(
    prompt: string,
    schema?: z.ZodTypeAny,
  ): MockObjectResponse {
    if (schema && this.config.schemaResponses) {
      const bySchema = this.config.schemaResponses.get(schema);
      if (bySchema) return bySchema;
    }
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

  private recordCallInternal(call: RecordedCall, writeLog = true): void {
    this.calls.push(call);
    if (writeLog && this.callLogger) {
      let modelId = call.modelKey;
      try {
        modelId = getModel(call.modelKey).id;
      } catch {
        // Mock calls intentionally allow unregistered model keys.
      }
      this.callLogger.logCall({
        topic: this.topic,
        callType: call.type,
        modelKey: call.modelKey,
        modelId,
        prompt: call.prompt,
        response: call.response,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cost: call.cost,
        metadata: call.options,
      });
    }
    // Also propagate to parent for aggregate stats
    if (this.parent) {
      this.parent.recordCallInternal(call, false);
    }
  }
}

// ============================================================================
// MockAIBatch Implementation
// ============================================================================

export class MockAIBatch<T = string> implements AIBatch<T> {
  private submittedBatches = new Map<string, AIBatchRequest[]>();
  private batchResults = new Map<string, AIBatchResult<T>[]>();
  private batchStatuses = new Map<string, AIBatchHandle["status"]>();
  private recordedBatches = new Set<string>();

  constructor(
    private helper: MockAIHelper,
    private modelKey: ModelKey,
  ) {}

  async submit(requests: AIBatchRequest[]): Promise<AIBatchHandle> {
    // Mirror the real AIBatchImpl contract so a stage tested against the mock
    // cannot pass while forgetting things the real class rejects.
    const seen = new Set<string>();
    for (const req of requests) {
      if (!req.id || typeof req.id !== "string" || req.id.trim().length === 0) {
        throw new Error("Batch request id must be a non-empty string");
      }
      if (seen.has(req.id)) {
        throw new Error(
          `Duplicate request id "${req.id}" in batch submission.`,
        );
      }
      seen.add(req.id);
    }

    const batchId = `mock-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.submittedBatches.set(batchId, requests);
    this.batchStatuses.set(
      batchId,
      requests.length === 0 ? "completed" : "pending",
    );

    // Generate mock results
    const results: AIBatchResult<T>[] = requests.map((req) => ({
      id: req.id,
      prompt: req.prompt,
      result: `mock result for ${req.id}` as unknown as T,
      inputTokens: 10,
      outputTokens: 20,
      status: "succeeded" as const,
    }));
    this.batchResults.set(batchId, results);

    return this.handleFor(batchId);
  }

  /** Same handle shape the real implementation returns, so tests can persist `refs`. */
  private handleFor(batchId: string): AIBatchHandle {
    const requests = this.submittedBatches.get(batchId) ?? [];
    const ref = {
      version: 1 as const,
      type: "text" as const,
      id: batchId,
      provider: "google",
      modelId: String(this.modelKey),
    };
    return {
      id: batchId,
      status: this.batchStatuses.get(batchId) ?? "pending",
      provider: "google",
      refs: [ref],
      batchIds: [batchId],
      totalRequests: requests.length,
      requestCounts: { total: requests.length, completed: 0, failed: 0 },
    };
  }

  async getStatus(
    batchId: string,
    _metadata?: Record<string, unknown>,
  ): Promise<AIBatchHandle> {
    return this.handleFor(batchId);
  }

  async getResults(
    batchId: string,
    _metadata?: Record<string, unknown>,
  ): Promise<AIBatchResult<T>[]> {
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
    results: AIBatchResult<T>[],
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
          result.status === "succeeded"
            ? typeof result.result === "string"
              ? result.result
              : JSON.stringify(result.result)
            : "",
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
    const fullResults: AIBatchResult<T>[] = results.map((r) =>
      (r.status ?? "succeeded") === "failed"
        ? {
            id: r.id,
            prompt: "",
            inputTokens: r.inputTokens ?? 10,
            outputTokens: r.outputTokens ?? 20,
            status: "failed" as const,
            error: r.error ?? "Mock failure",
          }
        : {
            id: r.id,
            prompt: "",
            result: r.result,
            inputTokens: r.inputTokens ?? 10,
            outputTokens: r.outputTokens ?? 20,
            status: "succeeded" as const,
          },
    );
    this.batchResults.set(batchId, fullResults);
    this.batchStatuses.set(batchId, "completed");
  }

  /**
   * Set batch status
   */
  setStatus(batchId: string, status: AIBatchHandle["status"]): void {
    this.batchStatuses.set(batchId, status);
  }

  /**
   * Get submitted requests for a batch
   */
  getSubmittedRequests(batchId: string): AIBatchRequest[] | undefined {
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

export type MockAIHelperFactory<THelper extends MockAIHelper = MockAIHelper> =
  AIHelperFactory & {
    readonly helper: THelper;
    setTextResponse: MockAIHelper["setTextResponse"];
    setObjectResponse: MockAIHelper["setObjectResponse"];
    mockObjectResponseForSchema: MockAIHelper["mockObjectResponseForSchema"];
    failOnce: MockAIHelper["failOnce"];
    setError: MockAIHelper["setError"];
    setLatency: MockAIHelper["setLatency"];
    getCalls: MockAIHelper["getCalls"];
  };

/** Options accepted by {@link createMockAIHelperFactory}. */
export interface CreateMockAIHelperFactoryOptions<
  THelper extends MockAIHelper = MockAIHelper,
> {
  /**
   * The helper the factory hands out. Every per-stage helper is built from
   * it through `createAtTopic`, which preserves the concrete class, so a
   * `MockAIHelper` subclass reaches the stage intact.
   */
  helper?: THelper;
}

/**
 * Create a kernel-compatible factory backed by one shared mock. The helper
 * property and delegated test methods make it possible to seed responses and
 * inspect calls before/after a stage executes.
 */
export function createMockAIHelperFactory<
  THelper extends MockAIHelper = MockAIHelper,
>(
  optionsOrHelper?: CreateMockAIHelperFactoryOptions<THelper> | THelper,
): MockAIHelperFactory<THelper> {
  const helper = (
    optionsOrHelper instanceof MockAIHelper
      ? optionsOrHelper
      : (optionsOrHelper?.helper ?? new MockAIHelper("test"))
  ) as THelper;
  const factory = ((topic: string, callLogger: AICallLogger) =>
    helper.createAtTopic(
      topic,
      callLogger,
    )) as unknown as MockAIHelperFactory<THelper>;
  Object.assign(factory, {
    helper,
    setTextResponse: helper.setTextResponse.bind(helper),
    setObjectResponse: helper.setObjectResponse.bind(helper),
    mockObjectResponseForSchema:
      helper.mockObjectResponseForSchema.bind(helper),
    failOnce: helper.failOnce.bind(helper),
    setError: helper.setError.bind(helper),
    setLatency: helper.setLatency.bind(helper),
    getCalls: helper.getCalls.bind(helper),
  });
  return factory;
}
