/**
 * Plugin Runner
 *
 * A concrete EventSink implementation that routes kernel events
 * to registered plugin handlers. Used as the eventSink when the
 * consumer wants domain side-effects on workflow events.
 */

import type { EventSink } from "./ports.js";
import type { KernelEvent, KernelEventType } from "./events.js";

// ============================================================================
// Types
// ============================================================================

export interface PluginDefinition<
  T extends KernelEventType = KernelEventType,
> {
  readonly id: string;
  readonly name: string;
  readonly on: readonly T[];
  handle(event: Extract<KernelEvent, { type: T }>): Promise<void>;
}

export interface PluginRunnerConfig {
  plugins: PluginDefinition[];
  /** Max retries before an event moves to DLQ (default: 3). */
  maxRetries?: number;
}

export interface PluginRunner extends EventSink {
  /** Max retries before DLQ. Exposed so outbox.flush can read it. */
  readonly maxRetries: number;
}

// ============================================================================
// definePlugin
// ============================================================================

export function definePlugin<T extends KernelEventType>(
  definition: PluginDefinition<T>,
): PluginDefinition<T> {
  return definition;
}

// ============================================================================
// createPluginRunner
// ============================================================================

export function createPluginRunner(config: PluginRunnerConfig): PluginRunner {
  const { plugins, maxRetries = 3 } = config;

  // Pre-index plugins by event type for O(1) lookup
  const handlersByType = new Map<string, PluginDefinition[]>();
  for (const plugin of plugins) {
    for (const eventType of plugin.on) {
      const existing = handlersByType.get(eventType) ?? [];
      existing.push(plugin as PluginDefinition);
      handlersByType.set(eventType, existing);
    }
  }

  return {
    maxRetries,

    async emit(event: KernelEvent): Promise<void> {
      const matching = handlersByType.get(event.type);
      if (!matching || matching.length === 0) return;

      for (const plugin of matching) {
        await plugin.handle(event as any);
      }
    },
  };
}
