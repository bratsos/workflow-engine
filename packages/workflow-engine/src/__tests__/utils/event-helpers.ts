/**
 * Event Helpers
 *
 * Utilities for testing event emission and handling in workflows.
 * Provides tools for waiting on events, collecting events, and asserting event sequences.
 */

import type { workflowEventBus } from "../../core/workflow-event-bus.server.js";

// ============================================================================
// Types
// ============================================================================

export interface CollectedEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

/** @deprecated Use CollectedEvent instead */
export type WorkflowEvent = CollectedEvent;

export type EventBusLike = typeof workflowEventBus;

export interface EventCollector {
  start(): void;
  stop(): void;
  getEvents(): CollectedEvent[];
  getEventsByType(type: string): CollectedEvent[];
  getLastEvent(type: string): CollectedEvent | undefined;
  clear(): void;
  getCount(): number;
  getCountByType(type: string): number;
  hasEvent(type: string, matcher?: Partial<Record<string, unknown>>): boolean;
}

export interface MockEventBus {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, payload: Record<string, unknown>): void;
  getEmittedEvents(): CollectedEvent[];
  clear(): void;
  getListenerCount(event: string): number;
}

// ============================================================================
// Event Collector
// ============================================================================

/**
 * Collects events from an event bus for later inspection
 *
 * @example
 * ```typescript
 * const collector = createEventCollector(eventBus);
 * collector.start();
 *
 * await executeWorkflow();
 *
 * collector.stop();
 * const events = collector.getEvents();
 * expect(events).toContainEqual(expect.objectContaining({ type: "workflow:started" }));
 * ```
 */
export function createEventCollector(eventBus: EventBusLike): EventCollector {
  const events: CollectedEvent[] = [];
  const listeners: Array<{
    event: string;
    listener: (...args: unknown[]) => void;
  }> = [];
  let started = false;

  const eventTypes = [
    "workflow:started",
    "workflow:completed",
    "workflow:failed",
    "workflow:suspended",
    "workflow:cancelled",
    "stage:started",
    "stage:completed",
    "stage:failed",
    "stage:suspended",
    "stage:progress",
    "log",
  ];

  return {
    /**
     * Start collecting events
     */
    start() {
      if (started) return;
      started = true;

      for (const eventType of eventTypes) {
        const listener = (payload: unknown) => {
          events.push({
            type: eventType,
            payload: payload as Record<string, unknown>,
            timestamp: Date.now(),
          });
        };
        // @ts-expect-error - Event types are dynamic
        eventBus.on(eventType, listener);
        listeners.push({ event: eventType, listener });
      }
    },

    /**
     * Stop collecting events and remove listeners
     */
    stop() {
      if (!started) return;
      started = false;

      for (const { event, listener } of listeners) {
        // @ts-expect-error - Event types are dynamic
        eventBus.off(event, listener);
      }
      listeners.length = 0;
    },

    /**
     * Get all collected events
     */
    getEvents(): CollectedEvent[] {
      return [...events];
    },

    /**
     * Get events of a specific type
     */
    getEventsByType(type: string): CollectedEvent[] {
      return events.filter((e) => e.type === type);
    },

    /**
     * Get the last event of a specific type
     */
    getLastEvent(type: string): CollectedEvent | undefined {
      const filtered = events.filter((e) => e.type === type);
      return filtered[filtered.length - 1];
    },

    /**
     * Clear collected events
     */
    clear() {
      events.length = 0;
    },

    /**
     * Get event count
     */
    getCount(): number {
      return events.length;
    },

    /**
     * Get event count by type
     */
    getCountByType(type: string): number {
      return events.filter((e) => e.type === type).length;
    },

    /**
     * Check if an event with specific properties was emitted
     */
    hasEvent(
      type: string,
      matcher?: Partial<Record<string, unknown>>,
    ): boolean {
      return events.some((e) => {
        if (e.type !== type) return false;
        if (!matcher) return true;
        return Object.entries(matcher).every(
          ([key, value]) => e.payload[key] === value,
        );
      });
    },
  };
}

// ============================================================================
// Wait For Event
// ============================================================================

/**
 * Wait for a specific event to be emitted
 *
 * @example
 * ```typescript
 * const completedPromise = waitForEvent(eventBus, "workflow:completed");
 * await executeWorkflow();
 * const event = await completedPromise;
 * expect(event.output).toBeDefined();
 * ```
 */
export function waitForEvent<T = Record<string, unknown>>(
  eventBus: EventBusLike,
  eventType: string,
  options?: {
    timeout?: number;
    filter?: (payload: T) => boolean;
  },
): Promise<T> {
  const timeout = options?.timeout ?? 10000;

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for event: ${eventType}`));
    }, timeout);

    const listener = (payload: T) => {
      if (options?.filter && !options.filter(payload)) {
        return; // Keep waiting
      }
      cleanup();
      resolve(payload);
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      // @ts-expect-error - Event types are dynamic
      eventBus.off(eventType, listener);
    };

    // @ts-expect-error - Event types are dynamic
    eventBus.on(eventType, listener);
  });
}

/**
 * Wait for multiple events in sequence
 *
 * @example
 * ```typescript
 * const events = await waitForEvents(eventBus, [
 *   "stage:started",
 *   "stage:completed",
 *   "workflow:completed",
 * ]);
 * ```
 */
export async function waitForEvents(
  eventBus: EventBusLike,
  eventTypes: string[],
  options?: {
    timeout?: number;
  },
): Promise<CollectedEvent[]> {
  const timeout = options?.timeout ?? 30000;
  const events: CollectedEvent[] = [];
  let currentIndex = 0;

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timeout waiting for events. Received: ${events.map((e) => e.type).join(", ")}. ` +
            `Waiting for: ${eventTypes[currentIndex]}`,
        ),
      );
    }, timeout);

    const listeners: Array<{
      event: string;
      listener: (...args: unknown[]) => void;
    }> = [];

    const checkComplete = () => {
      if (currentIndex >= eventTypes.length) {
        cleanup();
        resolve(events);
      }
    };

    const createListener = (eventType: string) => {
      const listener = (payload: unknown) => {
        if (eventType === eventTypes[currentIndex]) {
          events.push({
            type: eventType,
            payload: payload as Record<string, unknown>,
            timestamp: Date.now(),
          });
          currentIndex++;
          checkComplete();
        }
      };
      // @ts-expect-error - Event types are dynamic
      eventBus.on(eventType, listener);
      listeners.push({ event: eventType, listener });
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      for (const { event, listener } of listeners) {
        // @ts-expect-error - Event types are dynamic
        eventBus.off(event, listener);
      }
    };

    // Listen for all unique event types
    const uniqueTypes = [...new Set(eventTypes)];
    for (const eventType of uniqueTypes) {
      createListener(eventType);
    }
  });
}

// ============================================================================
// Event Sequence Assertions
// ============================================================================

/**
 * Assert that events were emitted in a specific order
 *
 * @example
 * ```typescript
 * const collector = createEventCollector(eventBus);
 * collector.start();
 * await executeWorkflow();
 * collector.stop();
 *
 * assertEventSequence(collector.getEvents(), [
 *   "workflow:started",
 *   "stage:started",
 *   "stage:completed",
 *   "workflow:completed",
 * ]);
 * ```
 */
export function assertEventSequence(
  events: CollectedEvent[],
  expectedSequence: string[],
): void {
  const actualSequence = events.map((e) => e.type);

  // Find the subsequence in order
  let expectedIndex = 0;
  for (const eventType of actualSequence) {
    if (eventType === expectedSequence[expectedIndex]) {
      expectedIndex++;
      if (expectedIndex >= expectedSequence.length) {
        return; // All expected events found in order
      }
    }
  }

  throw new Error(
    `Event sequence mismatch.\n` +
      `Expected sequence: ${expectedSequence.join(" -> ")}\n` +
      `Actual events: ${actualSequence.join(", ")}\n` +
      `Missing: ${expectedSequence.slice(expectedIndex).join(", ")}`,
  );
}

/**
 * Assert that events were emitted in exact order (no extra events)
 */
export function assertExactEventSequence(
  events: CollectedEvent[],
  expectedSequence: string[],
): void {
  const actualSequence = events.map((e) => e.type);

  if (actualSequence.length !== expectedSequence.length) {
    throw new Error(
      `Event count mismatch.\n` +
        `Expected: ${expectedSequence.length} events\n` +
        `Actual: ${actualSequence.length} events\n` +
        `Expected: ${expectedSequence.join(", ")}\n` +
        `Actual: ${actualSequence.join(", ")}`,
    );
  }

  for (let i = 0; i < expectedSequence.length; i++) {
    if (actualSequence[i] !== expectedSequence[i]) {
      throw new Error(
        `Event sequence mismatch at position ${i}.\n` +
          `Expected: ${expectedSequence[i]}\n` +
          `Actual: ${actualSequence[i]}\n` +
          `Full expected: ${expectedSequence.join(", ")}\n` +
          `Full actual: ${actualSequence.join(", ")}`,
      );
    }
  }
}

/**
 * Assert that specific events exist (order doesn't matter)
 */
export function assertEventsExist(
  events: CollectedEvent[],
  expectedTypes: string[],
): void {
  const actualTypes = events.map((e) => e.type);

  for (const expected of expectedTypes) {
    if (!actualTypes.includes(expected)) {
      throw new Error(
        `Missing expected event: ${expected}\n` +
          `Actual events: ${actualTypes.join(", ")}`,
      );
    }
  }
}

// ============================================================================
// Mock Event Bus
// ============================================================================

/**
 * Create a mock event bus for testing
 *
 * This is useful when you don't have access to the real event bus
 * or want to test event handling in isolation.
 */
export function createMockEventBus(): MockEventBus {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const emittedEvents: CollectedEvent[] = [];

  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(listener);
    },

    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
    },

    emit(event: string, payload: Record<string, unknown>) {
      emittedEvents.push({
        type: event,
        payload,
        timestamp: Date.now(),
      });

      const eventListeners = listeners.get(event);
      if (eventListeners) {
        for (const listener of eventListeners) {
          listener(payload);
        }
      }
    },

    // Test helpers
    getEmittedEvents(): CollectedEvent[] {
      return [...emittedEvents];
    },

    clear() {
      emittedEvents.length = 0;
    },

    getListenerCount(event: string): number {
      return listeners.get(event)?.size ?? 0;
    },
  };
}
