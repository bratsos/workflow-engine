/**
 * Workflow Event Bus - Global event emitter for workflow events
 *
 * This singleton allows SSE endpoints to subscribe to real-time workflow events
 * emitted by WorkflowExecutor instances running in the same process.
 *
 * Supports cross-process events via PostgreSQL LISTEN/NOTIFY when enabled.
 *
 * Events are namespaced by workflowRunId:
 * - workflow:{runId}:stage:started
 * - workflow:{runId}:stage:completed
 * - workflow:{runId}:log
 * - etc.
 */

import { EventEmitter } from "node:events";
import { createLogger } from "../utils/logger";
import type { WorkflowSSEEvent, WorkflowEventType } from "./workflow-events";

const logger = createLogger("WorkflowEventBus");

// ============================================================================
// Types for PgNotify integration (to avoid circular dependency)
// ============================================================================

/**
 * Interface matching PgNotify from @zertai/database
 * Defined here to avoid importing the database package into workflow-engine
 */
export interface PgNotifyLike {
  listen(
    channel: string,
    handler: (channel: string, payload: string) => void,
  ): Promise<() => void>;
  notify(channel: string, payload: string): Promise<void>;
  isConnected(): boolean;
}

// ============================================================================
// Global Event Bus
// ============================================================================

class WorkflowEventBus extends EventEmitter {
  private static instance: WorkflowEventBus;
  private pgNotify: PgNotifyLike | null = null;
  private static readonly PG_CHANNEL = "workflow_events";
  private pgListenerUnsubscribe: (() => void) | null = null;
  // PostgreSQL NOTIFY has an 8000 byte limit for payloads
  // We use 7500 to leave room for encoding overhead
  private static readonly MAX_PAYLOAD_SIZE = 7500;

  private constructor() {
    super();
    // Allow many listeners (one per SSE connection)
    this.setMaxListeners(1000);
  }

  static getInstance(): WorkflowEventBus {
    if (!WorkflowEventBus.instance) {
      WorkflowEventBus.instance = new WorkflowEventBus();
    }
    return WorkflowEventBus.instance;
  }

  /**
   * Enable cross-process event publishing via PostgreSQL NOTIFY
   *
   * Call this during process initialization to enable events to propagate
   * across multiple workers and the React Router app.
   *
   * @param pgNotify - A connected PgNotify instance from @zertai/database
   */
  async enablePgNotify(pgNotify: PgNotifyLike): Promise<void> {
    if (this.pgNotify) {
      logger.warn("PgNotify already enabled, skipping");
      return;
    }

    this.pgNotify = pgNotify;

    // Subscribe to receive events FROM other processes
    this.pgListenerUnsubscribe = await pgNotify.listen(
      WorkflowEventBus.PG_CHANNEL,
      (_channel: string, payload: string) => {
        try {
          const event = JSON.parse(payload) as WorkflowSSEEvent;

          // Re-emit to local subscribers WITHOUT triggering another pg notify
          // (to avoid infinite loops)
          this.emitLocally(event);
        } catch (err) {
          logger.error("Failed to parse pg notification:", err);
        }
      },
    );

    logger.info("Cross-process events enabled via PostgreSQL NOTIFY");
  }

  /**
   * Disable cross-process events (for cleanup)
   */
  disablePgNotify(): void {
    if (this.pgListenerUnsubscribe) {
      this.pgListenerUnsubscribe();
      this.pgListenerUnsubscribe = null;
    }
    this.pgNotify = null;
  }

  /**
   * Check if cross-process events are enabled
   */
  isPgNotifyEnabled(): boolean {
    return this.pgNotify !== null && this.pgNotify.isConnected();
  }

  /**
   * Truncate event payload to fit within PostgreSQL NOTIFY size limits.
   * Large data fields (like workflow output) are replaced with a truncation marker.
   */
  private truncatePayloadForNotify(event: WorkflowSSEEvent): WorkflowSSEEvent {
    const serialized = JSON.stringify(event);

    // If it fits, return as-is
    if (serialized.length <= WorkflowEventBus.MAX_PAYLOAD_SIZE) {
      return event;
    }

    // Create a truncated version
    const truncatedData: Record<string, unknown> = {};
    const keysToPreserve = [
      "workflowRunId",
      "stageId",
      "stageName",
      "stageNumber",
      "error",
      "level",
      "message",
      "duration",
      "cost",
    ];

    for (const key of keysToPreserve) {
      if (key in event.data) {
        truncatedData[key] = event.data[key];
      }
    }

    // Mark that payload was truncated
    truncatedData._truncated = true;
    truncatedData._originalSize = serialized.length;

    return {
      ...event,
      data: truncatedData,
    };
  }

  /**
   * Emit event locally only (used for re-emitting pg notifications)
   */
  private emitLocally(event: WorkflowSSEEvent): void {
    const eventName = `workflow:${event.workflowRunId}:${event.type}`;

    // Emit namespaced event (for specific SSE clients)
    this.emit(eventName, event);

    // Emit wildcard event for this workflow
    this.emit(`workflow:${event.workflowRunId}:*`, event);

    // Emit global event (for system-wide listeners)
    this.emit(event.type, event);
  }

  /**
   * Emit a workflow event with proper namespacing
   *
   * When PgNotify is enabled, also publishes to PostgreSQL for cross-process
   * consumption by other workers and the React Router app.
   */
  emitWorkflowEvent(
    workflowRunId: string,
    eventType: WorkflowEventType,
    payload: Record<string, unknown>,
  ): void {
    const sseEvent: WorkflowSSEEvent = {
      type: eventType,
      workflowRunId,
      timestamp: new Date(),
      data: payload,
    };

    // Emit locally
    this.emitLocally(sseEvent);

    // Also publish to Postgres for cross-process consumption
    if (this.pgNotify) {
      // Truncate large payloads to fit PostgreSQL NOTIFY limits
      const notifyEvent = this.truncatePayloadForNotify(sseEvent);
      this.pgNotify
        .notify(WorkflowEventBus.PG_CHANNEL, JSON.stringify(notifyEvent))
        .catch((err) => {
          logger.error("Pg notify failed:", err);
        });
    }
  }

  /**
   * Subscribe to all events for a specific workflow run
   */
  subscribeToWorkflow(
    workflowRunId: string,
    handler: (event: WorkflowSSEEvent) => void,
  ): () => void {
    const eventName = `workflow:${workflowRunId}:*`;
    this.on(eventName, handler);

    // Return unsubscribe function
    return () => {
      this.off(eventName, handler);
    };
  }

  /**
   * Subscribe to a specific event type globally (across all workflows)
   */
  subscribeGlobal(
    eventType: WorkflowEventType,
    handler: (event: WorkflowSSEEvent) => void,
  ): () => void {
    this.on(eventType, handler);

    return () => {
      this.off(eventType, handler);
    };
  }

  /**
   * Subscribe to a specific event type for a workflow
   */
  subscribeToEvent(
    workflowRunId: string,
    eventType: WorkflowEventType,
    handler: (event: WorkflowSSEEvent) => void,
  ): () => void {
    const eventName = `workflow:${workflowRunId}:${eventType}`;
    this.on(eventName, handler);

    return () => {
      this.off(eventName, handler);
    };
  }
}

// Export singleton instance
export const workflowEventBus = WorkflowEventBus.getInstance();
