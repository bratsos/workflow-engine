/**
 * Core type definitions for Workflow System v2
 *
 * See WORKFLOW_SYSTEM_PROPOSAL.md for full architectural details
 */

import { z } from "zod";

// ============================================================================
// Progress & Metrics
// ============================================================================

export interface ProgressUpdate {
  stageId: string;
  stageName: string;
  progress: number; // 0-100
  message: string;
  details?: Record<string, unknown>;
}

export interface StageMetrics {
  startTime: number;
  endTime: number;
  duration: number;
  itemsProcessed?: number;
  itemsProduced?: number;
  aiCalls?: number;
  totalTokens?: number;
  totalCost?: number;
}

// ============================================================================
// Embedding Support
// ============================================================================

export interface EmbeddingResult {
  id: string;
  content: string;
  embedding: number[];
  similarity?: number;
  metadata?: Record<string, unknown>;
}

export interface EmbeddingInfo {
  model: string;
  dimensions: number;
  results: EmbeddingResult[];
  totalProcessed?: number;
  averageSimilarity?: number;
}

// ============================================================================
// Stage Results
// ============================================================================

export interface StageResult<TOutput> {
  output: TOutput;
  metrics: StageMetrics;
  artifacts?: Record<string, unknown>;
  embeddings?: EmbeddingInfo;
}

// ============================================================================
// Suspended State (for async-batch operations)
// ============================================================================

export const SuspendedStateSchema = z.object({
  batchId: z.string(),
  statusUrl: z.string().optional(),
  apiKey: z.string().optional(),
  submittedAt: z.string(), // ISO date string
  pollInterval: z.number(), // milliseconds
  maxWaitTime: z.number(), // milliseconds
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface SuspendedResult {
  suspended: true;
  state: z.infer<typeof SuspendedStateSchema>;
  pollConfig: {
    pollInterval: number;
    maxWaitTime: number;
    nextPollAt: Date;
  };
  metrics: StageMetrics;
}

// ============================================================================
// Completion Check Result (for orchestrator polling)
// ============================================================================

export interface CompletionCheckResult<TOutput> {
  ready: boolean;
  output?: TOutput;
  error?: string;
  nextCheckIn?: number; // Optional: override next poll interval
  metrics?: StageMetrics;
  embeddings?: EmbeddingInfo;
}

// ============================================================================
// Log Levels
// ============================================================================

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

// ============================================================================
// Stage Mode
// ============================================================================

export type StageMode =
  | "sync" // Execute and return immediately
  | "async-batch"; // Start batch job, return suspended state (separate poller handles completion)

// ============================================================================
// Type Guards
// ============================================================================

export function isSuspendedResult<T>(
  result: StageResult<T> | SuspendedResult,
): result is SuspendedResult {
  return "suspended" in result && result.suspended === true;
}

export function isStageResult<T>(
  result: StageResult<T> | SuspendedResult,
): result is StageResult<T> {
  return !isSuspendedResult(result);
}
