/**
 * Test Utilities Index
 *
 * Re-exports all test utilities for convenient importing in tests.
 *
 * @example
 * ```typescript
 * import {
 *   InMemoryWorkflowPersistence,
 *   InMemoryJobQueue,
 *   InMemoryAICallLogger,
 *   createMockAIHelper,
 *   createPassthroughStage,
 *   createEventCollector,
 * } from "../utils";
 * ```
 */

// In-memory persistence implementations
export { InMemoryWorkflowPersistence } from "./in-memory-persistence.js";
export { InMemoryJobQueue } from "./in-memory-job-queue.js";
export { InMemoryAICallLogger } from "./in-memory-ai-logger.js";

// Mock AI helper
export {
  MockAIHelper,
  createMockAIHelper,
  type MockTextResponse,
  type MockObjectResponse,
  type MockEmbedResponse,
  type MockBatchResult,
  type MockAIHelperConfig,
  type RecordedCall,
} from "./mock-ai-helper.js";

// Test factories
export {
  // Stage factories
  createPassthroughStage,
  createTransformStage,
  createFixedOutputStage,
  createTrackingStage,
  createErrorStage,
  createConfigurableStage,
  // Async-batch stage factories
  createSuspendingStage,
  createFailingSuspendStage,
  // Workflow factories
  createSequentialWorkflow,
  createTrackedWorkflow,
  // Schemas
  TestSchemas,
  TestConfigSchemas,
} from "./test-factories.js";

// Event helpers
export {
  createEventCollector,
  waitForEvent,
  waitForEvents,
  assertEventSequence,
  assertExactEventSequence,
  assertEventsExist,
  createMockEventBus,
  type CollectedEvent,
  type EventCollector,
  type MockEventBus,
} from "./event-helpers.js";
