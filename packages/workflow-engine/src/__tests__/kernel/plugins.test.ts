/**
 * Kernel Tests: Plugin Runner
 *
 * Tests for the plugin runner EventSink implementation that routes
 * outbox events to typed plugin handlers.
 */

import { describe, expect, it, vi } from "vitest";
import type { KernelEvent } from "../../kernel/events.js";
import { createPluginRunner, definePlugin } from "../../kernel/plugins.js";

describe("kernel: plugin runner", () => {
  it("routes events to matching handlers", async () => {
    const handler = vi.fn();
    const plugin = definePlugin({
      id: "test-plugin",
      name: "Test Plugin",
      on: ["workflow:completed"],
      handle: handler,
    });

    const runner = createPluginRunner({ plugins: [plugin] });

    const event: KernelEvent = {
      type: "workflow:completed",
      timestamp: new Date(),
      workflowRunId: "run-1",
    };

    await runner.emit(event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("skips non-matching handlers", async () => {
    const handler = vi.fn();
    const plugin = definePlugin({
      id: "test-plugin",
      name: "Test Plugin",
      on: ["workflow:completed"],
      handle: handler,
    });

    const runner = createPluginRunner({ plugins: [plugin] });

    const event: KernelEvent = {
      type: "workflow:created",
      timestamp: new Date(),
      workflowRunId: "run-1",
      workflowId: "wf-1",
    };

    await runner.emit(event);
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls multiple plugins for the same event type", async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    const plugin1 = definePlugin({
      id: "plugin-1",
      name: "Plugin 1",
      on: ["workflow:completed"],
      handle: handler1,
    });
    const plugin2 = definePlugin({
      id: "plugin-2",
      name: "Plugin 2",
      on: ["workflow:completed"],
      handle: handler2,
    });

    const runner = createPluginRunner({ plugins: [plugin1, plugin2] });

    const event: KernelEvent = {
      type: "workflow:completed",
      timestamp: new Date(),
      workflowRunId: "run-1",
    };

    await runner.emit(event);
    expect(handler1).toHaveBeenCalledWith(event);
    expect(handler2).toHaveBeenCalledWith(event);
  });

  it("throws when a handler throws", async () => {
    const plugin = definePlugin({
      id: "failing-plugin",
      name: "Failing Plugin",
      on: ["workflow:completed"],
      handle: async () => {
        throw new Error("plugin exploded");
      },
    });

    const runner = createPluginRunner({ plugins: [plugin] });

    const event: KernelEvent = {
      type: "workflow:completed",
      timestamp: new Date(),
      workflowRunId: "run-1",
    };

    await expect(runner.emit(event)).rejects.toThrow("plugin exploded");
  });

  it("is a no-op when no plugins match", async () => {
    const runner = createPluginRunner({ plugins: [] });

    const event: KernelEvent = {
      type: "workflow:completed",
      timestamp: new Date(),
      workflowRunId: "run-1",
    };

    // Should not throw
    await runner.emit(event);
  });

  it("plugin subscribes to multiple event types", async () => {
    const handler = vi.fn();
    const plugin = definePlugin({
      id: "multi-plugin",
      name: "Multi Plugin",
      on: ["workflow:completed", "workflow:failed"],
      handle: handler,
    });

    const runner = createPluginRunner({ plugins: [plugin] });

    await runner.emit({
      type: "workflow:completed",
      timestamp: new Date(),
      workflowRunId: "run-1",
    });
    await runner.emit({
      type: "workflow:failed",
      timestamp: new Date(),
      workflowRunId: "run-2",
      error: "boom",
    });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("exposes maxRetries from config", () => {
    const runner = createPluginRunner({ plugins: [], maxRetries: 5 });
    expect(runner.maxRetries).toBe(5);
  });

  it("defaults maxRetries to 3", () => {
    const runner = createPluginRunner({ plugins: [] });
    expect(runner.maxRetries).toBe(3);
  });
});
