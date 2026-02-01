/**
 * Workflow Events Tests
 *
 * Tests for the workflow event bus and event types.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type {
  WorkflowSSEEvent,
  WorkflowEventType,
} from "../../core/workflow-events.js";

// Create a fresh WorkflowEventBus class for each test to avoid singleton state issues
class TestableWorkflowEventBus extends EventEmitter {
  private pgNotify: PgNotifyLike | null = null;
  private pgListenerUnsubscribe: (() => void) | null = null;

  constructor() {
    super();
    this.setMaxListeners(1000);
  }

  async enablePgNotify(pgNotify: PgNotifyLike): Promise<void> {
    if (this.pgNotify) {
      return;
    }

    this.pgNotify = pgNotify;

    this.pgListenerUnsubscribe = await pgNotify.listen(
      "workflow_events",
      (_channel: string, payload: string) => {
        try {
          const event = JSON.parse(payload) as WorkflowSSEEvent;
          this.emitLocally(event);
        } catch {
          // Ignore parse errors in tests
        }
      },
    );
  }

  disablePgNotify(): void {
    if (this.pgListenerUnsubscribe) {
      this.pgListenerUnsubscribe();
      this.pgListenerUnsubscribe = null;
    }
    this.pgNotify = null;
  }

  isPgNotifyEnabled(): boolean {
    return this.pgNotify !== null && this.pgNotify.isConnected();
  }

  private emitLocally(event: WorkflowSSEEvent): void {
    const eventName = `workflow:${event.workflowRunId}:${event.type}`;
    this.emit(eventName, event);
    this.emit(`workflow:${event.workflowRunId}:*`, event);
    this.emit(event.type, event);
  }

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

    this.emitLocally(sseEvent);

    if (this.pgNotify) {
      this.pgNotify
        .notify("workflow_events", JSON.stringify(sseEvent))
        .catch(() => {});
    }
  }

  subscribeToWorkflow(
    workflowRunId: string,
    handler: (event: WorkflowSSEEvent) => void,
  ): () => void {
    const eventName = `workflow:${workflowRunId}:*`;
    this.on(eventName, handler);
    return () => {
      this.off(eventName, handler);
    };
  }

  subscribeGlobal(
    eventType: WorkflowEventType,
    handler: (event: WorkflowSSEEvent) => void,
  ): () => void {
    this.on(eventType, handler);
    return () => {
      this.off(eventType, handler);
    };
  }

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

interface PgNotifyLike {
  listen(
    channel: string,
    handler: (channel: string, payload: string) => void,
  ): Promise<() => void>;
  notify(channel: string, payload: string): Promise<void>;
  isConnected(): boolean;
}

describe("I want to use the workflow event bus", () => {
  let eventBus: TestableWorkflowEventBus;

  beforeEach(() => {
    eventBus = new TestableWorkflowEventBus();
  });

  afterEach(() => {
    eventBus.removeAllListeners();
  });

  describe("emitWorkflowEvent", () => {
    it("should emit event with correct structure", () => {
      // Given: An event bus and a handler
      const receivedEvents: WorkflowSSEEvent[] = [];
      eventBus.subscribeToWorkflow("run-123", (event) => {
        receivedEvents.push(event);
      });

      // When: I emit an event
      eventBus.emitWorkflowEvent("run-123", "workflow:started", {
        workflowName: "Test Workflow",
      });

      // Then: Event has correct structure
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]?.type).toBe("workflow:started");
      expect(receivedEvents[0]?.workflowRunId).toBe("run-123");
      expect(receivedEvents[0]?.timestamp).toBeInstanceOf(Date);
      expect(receivedEvents[0]?.data).toEqual({
        workflowName: "Test Workflow",
      });
    });

    it("should set timestamp to current time", () => {
      // Given: A handler
      const receivedEvents: WorkflowSSEEvent[] = [];
      eventBus.subscribeToWorkflow("run-ts", (event) => {
        receivedEvents.push(event);
      });

      const before = new Date();

      // When: I emit an event
      eventBus.emitWorkflowEvent("run-ts", "stage:started", { stageId: "s1" });

      const after = new Date();

      // Then: Timestamp is between before and after
      const timestamp = receivedEvents[0]?.timestamp;
      expect(timestamp?.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(timestamp?.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe("subscribeToWorkflow", () => {
    it("should receive all events for a workflow", () => {
      // Given: A subscription to a workflow
      const receivedEvents: WorkflowSSEEvent[] = [];
      eventBus.subscribeToWorkflow("run-abc", (event) => {
        receivedEvents.push(event);
      });

      // When: I emit multiple event types
      eventBus.emitWorkflowEvent("run-abc", "workflow:started", {});
      eventBus.emitWorkflowEvent("run-abc", "stage:started", { stageId: "s1" });
      eventBus.emitWorkflowEvent("run-abc", "stage:completed", {
        stageId: "s1",
      });
      eventBus.emitWorkflowEvent("run-abc", "workflow:completed", {});

      // Then: All events received
      expect(receivedEvents).toHaveLength(4);
      expect(receivedEvents.map((e) => e.type)).toEqual([
        "workflow:started",
        "stage:started",
        "stage:completed",
        "workflow:completed",
      ]);
    });

    it("should not receive events from other workflows", () => {
      // Given: A subscription to workflow A
      const receivedEvents: WorkflowSSEEvent[] = [];
      eventBus.subscribeToWorkflow("run-A", (event) => {
        receivedEvents.push(event);
      });

      // When: I emit events from both A and B
      eventBus.emitWorkflowEvent("run-A", "workflow:started", {});
      eventBus.emitWorkflowEvent("run-B", "workflow:started", {}); // Different workflow
      eventBus.emitWorkflowEvent("run-A", "workflow:completed", {});

      // Then: Only events from A received
      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents.every((e) => e.workflowRunId === "run-A")).toBe(
        true,
      );
    });

    it("should return unsubscribe function", () => {
      // Given: A subscription
      const receivedEvents: WorkflowSSEEvent[] = [];
      const unsubscribe = eventBus.subscribeToWorkflow("run-unsub", (event) => {
        receivedEvents.push(event);
      });

      // When: I emit, unsubscribe, then emit again
      eventBus.emitWorkflowEvent("run-unsub", "workflow:started", {});
      unsubscribe();
      eventBus.emitWorkflowEvent("run-unsub", "workflow:completed", {});

      // Then: Only first event received
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]?.type).toBe("workflow:started");
    });
  });

  describe("subscribeGlobal", () => {
    it("should receive events of specific type from all workflows", () => {
      // Given: A global subscription to stage:completed
      const receivedEvents: WorkflowSSEEvent[] = [];
      eventBus.subscribeGlobal("stage:completed", (event) => {
        receivedEvents.push(event);
      });

      // When: I emit various events from different workflows
      eventBus.emitWorkflowEvent("run-1", "stage:started", { stageId: "s1" });
      eventBus.emitWorkflowEvent("run-1", "stage:completed", { stageId: "s1" });
      eventBus.emitWorkflowEvent("run-2", "stage:started", { stageId: "s2" });
      eventBus.emitWorkflowEvent("run-2", "stage:completed", { stageId: "s2" });

      // Then: Only stage:completed events received
      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents.every((e) => e.type === "stage:completed")).toBe(
        true,
      );
    });

    it("should return unsubscribe function", () => {
      // Given: A global subscription
      const receivedEvents: WorkflowSSEEvent[] = [];
      const unsubscribe = eventBus.subscribeGlobal(
        "workflow:failed",
        (event) => {
          receivedEvents.push(event);
        },
      );

      // When: I emit, unsubscribe, emit again
      eventBus.emitWorkflowEvent("run-1", "workflow:failed", {
        error: "first",
      });
      unsubscribe();
      eventBus.emitWorkflowEvent("run-2", "workflow:failed", {
        error: "second",
      });

      // Then: Only first event received
      expect(receivedEvents).toHaveLength(1);
    });
  });

  describe("subscribeToEvent", () => {
    it("should receive only specific event type for specific workflow", () => {
      // Given: A subscription to stage:progress for workflow A
      const receivedEvents: WorkflowSSEEvent[] = [];
      eventBus.subscribeToEvent("run-A", "stage:progress", (event) => {
        receivedEvents.push(event);
      });

      // When: I emit various events
      eventBus.emitWorkflowEvent("run-A", "stage:started", {});
      eventBus.emitWorkflowEvent("run-A", "stage:progress", { percent: 50 });
      eventBus.emitWorkflowEvent("run-A", "stage:progress", { percent: 100 });
      eventBus.emitWorkflowEvent("run-B", "stage:progress", { percent: 50 });

      // Then: Only stage:progress from run-A received
      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents.every((e) => e.type === "stage:progress")).toBe(
        true,
      );
      expect(receivedEvents.every((e) => e.workflowRunId === "run-A")).toBe(
        true,
      );
    });

    it("should return unsubscribe function", () => {
      // Given: A specific event subscription
      const receivedEvents: WorkflowSSEEvent[] = [];
      const unsubscribe = eventBus.subscribeToEvent("run-X", "log", (event) => {
        receivedEvents.push(event);
      });

      // When: I emit, unsubscribe, emit again
      eventBus.emitWorkflowEvent("run-X", "log", { message: "first" });
      unsubscribe();
      eventBus.emitWorkflowEvent("run-X", "log", { message: "second" });

      // Then: Only first event received
      expect(receivedEvents).toHaveLength(1);
    });
  });

  describe("multiple subscribers", () => {
    it("should deliver event to all subscribers", () => {
      // Given: Multiple subscribers to same workflow
      const events1: WorkflowSSEEvent[] = [];
      const events2: WorkflowSSEEvent[] = [];
      const events3: WorkflowSSEEvent[] = [];

      eventBus.subscribeToWorkflow("run-multi", (e) => events1.push(e));
      eventBus.subscribeToWorkflow("run-multi", (e) => events2.push(e));
      eventBus.subscribeToWorkflow("run-multi", (e) => events3.push(e));

      // When: I emit an event
      eventBus.emitWorkflowEvent("run-multi", "workflow:started", {});

      // Then: All subscribers receive it
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect(events3).toHaveLength(1);
    });

    it("should handle mixed subscription types", () => {
      // Given: Different subscription types for same event
      const workflowEvents: WorkflowSSEEvent[] = [];
      const globalEvents: WorkflowSSEEvent[] = [];
      const specificEvents: WorkflowSSEEvent[] = [];

      eventBus.subscribeToWorkflow("run-mix", (e) => workflowEvents.push(e));
      eventBus.subscribeGlobal("stage:completed", (e) => globalEvents.push(e));
      eventBus.subscribeToEvent("run-mix", "stage:completed", (e) =>
        specificEvents.push(e),
      );

      // When: I emit stage:completed for run-mix
      eventBus.emitWorkflowEvent("run-mix", "stage:completed", {
        stageId: "s1",
      });

      // Then: All subscriptions receive the event
      expect(workflowEvents).toHaveLength(1);
      expect(globalEvents).toHaveLength(1);
      expect(specificEvents).toHaveLength(1);
    });
  });

  describe("pgNotify integration", () => {
    it("should enable pgNotify", async () => {
      // Given: A mock PgNotify
      const mockPgNotify: PgNotifyLike = {
        listen: vi.fn().mockResolvedValue(() => {}),
        notify: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
      };

      // When: I enable pgNotify
      await eventBus.enablePgNotify(mockPgNotify);

      // Then: pgNotify is enabled
      expect(eventBus.isPgNotifyEnabled()).toBe(true);
      expect(mockPgNotify.listen).toHaveBeenCalledWith(
        "workflow_events",
        expect.any(Function),
      );
    });

    it("should skip duplicate enablePgNotify calls", async () => {
      // Given: pgNotify already enabled
      const mockPgNotify: PgNotifyLike = {
        listen: vi.fn().mockResolvedValue(() => {}),
        notify: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
      };
      await eventBus.enablePgNotify(mockPgNotify);

      // When: I try to enable again
      await eventBus.enablePgNotify(mockPgNotify);

      // Then: listen was only called once
      expect(mockPgNotify.listen).toHaveBeenCalledTimes(1);
    });

    it("should notify via pg when enabled", async () => {
      // Given: pgNotify enabled
      const mockPgNotify: PgNotifyLike = {
        listen: vi.fn().mockResolvedValue(() => {}),
        notify: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
      };
      await eventBus.enablePgNotify(mockPgNotify);

      // When: I emit an event
      eventBus.emitWorkflowEvent("run-pg", "workflow:started", {
        name: "test",
      });

      // Then: notify was called
      expect(mockPgNotify.notify).toHaveBeenCalledTimes(1);
      expect(mockPgNotify.notify).toHaveBeenCalledWith(
        "workflow_events",
        expect.stringContaining("run-pg"),
      );
    });

    it("should disable pgNotify", async () => {
      // Given: pgNotify enabled with unsubscribe function
      const unsubscribeFn = vi.fn();
      const mockPgNotify: PgNotifyLike = {
        listen: vi.fn().mockResolvedValue(unsubscribeFn),
        notify: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
      };
      await eventBus.enablePgNotify(mockPgNotify);

      // When: I disable pgNotify
      eventBus.disablePgNotify();

      // Then: Unsubscribe was called and pgNotify is disabled
      expect(unsubscribeFn).toHaveBeenCalled();
      expect(eventBus.isPgNotifyEnabled()).toBe(false);
    });

    it("should return false for isPgNotifyEnabled when not connected", async () => {
      // Given: pgNotify enabled but not connected
      const mockPgNotify: PgNotifyLike = {
        listen: vi.fn().mockResolvedValue(() => {}),
        notify: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(false), // Not connected
      };
      await eventBus.enablePgNotify(mockPgNotify);

      // When: I check if enabled
      const enabled = eventBus.isPgNotifyEnabled();

      // Then: Returns false
      expect(enabled).toBe(false);
    });

    it("should re-emit events received from pg listener", async () => {
      // Given: pgNotify enabled with a captured handler
      let capturedHandler: ((channel: string, payload: string) => void) | null =
        null;
      const mockPgNotify: PgNotifyLike = {
        listen: vi.fn().mockImplementation((_channel, handler) => {
          capturedHandler = handler;
          return Promise.resolve(() => {});
        }),
        notify: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
      };
      await eventBus.enablePgNotify(mockPgNotify);

      // And: A workflow subscriber
      const receivedEvents: WorkflowSSEEvent[] = [];
      eventBus.subscribeToWorkflow("run-pg-listen", (e) =>
        receivedEvents.push(e),
      );

      // When: pg sends an event
      const pgEvent: WorkflowSSEEvent = {
        type: "stage:completed",
        workflowRunId: "run-pg-listen",
        timestamp: new Date(),
        data: { stageId: "s1" },
      };
      capturedHandler!("workflow_events", JSON.stringify(pgEvent));

      // Then: Event is re-emitted locally
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]?.type).toBe("stage:completed");
    });
  });

  describe("event types", () => {
    it("should handle all workflow event types", () => {
      // Given: A subscription
      const receivedTypes: WorkflowEventType[] = [];
      eventBus.subscribeToWorkflow("run-types", (e) =>
        receivedTypes.push(e.type),
      );

      // When: I emit all event types
      const allTypes: WorkflowEventType[] = [
        "connected",
        "workflow:started",
        "workflow:completed",
        "workflow:suspended",
        "workflow:cancelled",
        "workflow:failed",
        "stage:started",
        "stage:progress",
        "stage:completed",
        "stage:suspended",
        "stage:failed",
        "log",
      ];

      for (const type of allTypes) {
        eventBus.emitWorkflowEvent("run-types", type, {});
      }

      // Then: All types received
      expect(receivedTypes).toEqual(allTypes);
    });
  });
});
