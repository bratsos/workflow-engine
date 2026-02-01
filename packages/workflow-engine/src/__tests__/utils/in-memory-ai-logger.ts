/**
 * In-Memory AI Call Logger
 *
 * A complete in-memory implementation of AICallLogger for testing.
 * Tracks all AI calls with full cost/token tracking and topic-based aggregation.
 */

import { randomUUID } from "crypto";
import type {
  AICallLogger,
  AICallRecord,
  AIHelperStats,
  CreateAICallInput,
} from "../../persistence/interface.js";

export class InMemoryAICallLogger implements AICallLogger {
  private calls = new Map<string, AICallRecord>();
  private recordedBatches = new Set<string>();

  // ============================================================================
  // Core Operations
  // ============================================================================

  /**
   * Log a single AI call (fire and forget)
   */
  logCall(call: CreateAICallInput): void {
    const id = randomUUID();
    const record: AICallRecord = {
      id,
      createdAt: new Date(),
      topic: call.topic,
      callType: call.callType,
      modelKey: call.modelKey,
      modelId: call.modelId,
      prompt: call.prompt,
      response: call.response,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cost: call.cost,
      metadata: call.metadata ?? null,
    };
    this.calls.set(id, record);
  }

  /**
   * Log batch results (for recording batch API results)
   */
  async logBatchResults(
    batchId: string,
    results: CreateAICallInput[],
  ): Promise<void> {
    // Mark batch as recorded
    this.recordedBatches.add(batchId);

    // Log each result
    for (const result of results) {
      this.logCall({
        ...result,
        metadata: {
          ...(result.metadata as Record<string, unknown> | undefined),
          batchId,
        },
      });
    }
  }

  /**
   * Get aggregated stats for a topic prefix
   */
  async getStats(topicPrefix: string): Promise<AIHelperStats> {
    const matchingCalls = Array.from(this.calls.values()).filter((call) =>
      call.topic.startsWith(topicPrefix),
    );

    const stats: AIHelperStats = {
      totalCalls: matchingCalls.length,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      perModel: {},
    };

    for (const call of matchingCalls) {
      stats.totalInputTokens += call.inputTokens;
      stats.totalOutputTokens += call.outputTokens;
      stats.totalCost += call.cost;

      // Aggregate per model
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

  /**
   * Check if batch results are already recorded
   */
  async isRecorded(batchId: string): Promise<boolean> {
    return this.recordedBatches.has(batchId);
  }

  // ============================================================================
  // Test Helpers (not part of interface)
  // ============================================================================

  /**
   * Clear all data - useful between tests
   */
  clear(): void {
    this.calls.clear();
    this.recordedBatches.clear();
  }

  /**
   * Get all calls for inspection
   */
  getAllCalls(): AICallRecord[] {
    return Array.from(this.calls.values()).map((c) => ({ ...c }));
  }

  /**
   * Get calls by topic for inspection
   */
  getCallsByTopic(topic: string): AICallRecord[] {
    return Array.from(this.calls.values())
      .filter((c) => c.topic === topic)
      .map((c) => ({ ...c }));
  }

  /**
   * Get calls by topic prefix for inspection
   */
  getCallsByTopicPrefix(prefix: string): AICallRecord[] {
    return Array.from(this.calls.values())
      .filter((c) => c.topic.startsWith(prefix))
      .map((c) => ({ ...c }));
  }

  /**
   * Get calls by model for inspection
   */
  getCallsByModel(modelKey: string): AICallRecord[] {
    return Array.from(this.calls.values())
      .filter((c) => c.modelKey === modelKey)
      .map((c) => ({ ...c }));
  }

  /**
   * Get calls by call type for inspection
   */
  getCallsByType(callType: string): AICallRecord[] {
    return Array.from(this.calls.values())
      .filter((c) => c.callType === callType)
      .map((c) => ({ ...c }));
  }

  /**
   * Get total cost across all calls
   */
  getTotalCost(): number {
    let total = 0;
    for (const call of this.calls.values()) {
      total += call.cost;
    }
    return total;
  }

  /**
   * Get total tokens across all calls
   */
  getTotalTokens(): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const call of this.calls.values()) {
      input += call.inputTokens;
      output += call.outputTokens;
    }
    return { input, output };
  }

  /**
   * Get call count
   */
  getCallCount(): number {
    return this.calls.size;
  }

  /**
   * Get all recorded batch IDs
   */
  getRecordedBatchIds(): string[] {
    return Array.from(this.recordedBatches);
  }

  /**
   * Get the last call made (useful for assertions)
   */
  getLastCall(): AICallRecord | null {
    const calls = Array.from(this.calls.values());
    if (calls.length === 0) return null;

    // Sort by createdAt descending
    calls.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { ...calls[0]! };
  }

  /**
   * Assert a call was made with specific properties
   */
  hasCallMatching(predicate: (call: AICallRecord) => boolean): boolean {
    return Array.from(this.calls.values()).some(predicate);
  }
}
