/**
 * Workflow Event Types for SSE Streaming
 *
 * This file contains ONLY types and interfaces for workflow events.
 * It is safe to use in both client and server environments.
 */

export interface WorkflowSSEEvent {
  type: WorkflowEventType;
  workflowRunId: string;
  timestamp: Date;
  data: Record<string, unknown>;
}

export type WorkflowEventType =
  | "connected"
  | "workflow:started"
  | "workflow:completed"
  | "workflow:suspended"
  | "workflow:cancelled"
  | "workflow:failed"
  | "stage:started"
  | "stage:progress"
  | "stage:completed"
  | "stage:suspended"
  | "stage:failed"
  | "log";

// Event payloads matching ExecutorEvents interface
export interface WorkflowStartedPayload {
  workflowRunId: string;
  workflowName: string;
}

export interface WorkflowCompletedPayload {
  workflowRunId: string;
  output: unknown;
  duration?: number;
  totalCost?: number;
  totalTokens?: number;
}

export interface WorkflowSuspendedPayload {
  workflowRunId: string;
  stageId: string;
}

export interface WorkflowFailedPayload {
  workflowRunId: string;
  error: string;
}

export interface StageStartedPayload {
  stageId: string;
  stageName: string;
  stageNumber: number;
}

export interface StageCompletedPayload {
  stageId: string;
  stageName: string;
  duration: number;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  outputCount?: number;
}

export interface StageFailedPayload {
  stageId: string;
  stageName: string;
  error: string;
}

export interface LogPayload {
  level: string; // Avoid circular dep with LogLevel if possible or import type
  message: string;
  meta?: Record<string, unknown>;
}
