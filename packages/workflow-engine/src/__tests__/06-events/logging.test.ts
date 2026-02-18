/**
 * Logging Tests (Kernel)
 *
 * In the kernel architecture, logging via ctx.onLog() writes directly to
 * persistence (createLog) rather than emitting events through the outbox.
 * These tests are skipped because logging is now handled by persistence
 * and/or plugins rather than the kernel event sink.
 */

import { describe, it } from "vitest";

describe("I want to log from stages", () => {
  describe("basic logging", () => {
    it.skip("TODO: logging handled by persistence.createLog, not kernel eventSink", () => {});
    it.skip("TODO: log event structure is persistence-specific, not kernel eventSink", () => {});
  });

  describe("log levels", () => {
    it.skip("TODO: log levels are persisted via persistence.createLog, not kernel eventSink", () => {});
    it.skip("TODO: INFO level tagging handled by persistence, not kernel eventSink", () => {});
    it.skip("TODO: WARN level tagging handled by persistence, not kernel eventSink", () => {});
    it.skip("TODO: ERROR level tagging handled by persistence, not kernel eventSink", () => {});
  });

  describe("log metadata", () => {
    it.skip("TODO: log metadata handled by persistence.createLog, not kernel eventSink", () => {});
    it.skip("TODO: logs without metadata handled by persistence, not kernel eventSink", () => {});
    it.skip("TODO: nested metadata handled by persistence, not kernel eventSink", () => {});
    it.skip("TODO: error code metadata handled by persistence, not kernel eventSink", () => {});
  });

  describe("multiple logs from stages", () => {
    it.skip("TODO: multiple logs from single stage handled by persistence, not kernel eventSink", () => {});
    it.skip("TODO: logs across multiple stages handled by persistence, not kernel eventSink", () => {});
  });
});
