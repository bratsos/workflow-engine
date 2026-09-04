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
 * } from "../utils";
 * ```
 */

// Re-exported from the public package so tests exercise the same
// implementation consumers get -- do not fork a test-local copy here.
export { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";
export { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
export { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";
// Shared kernel test harness -- the single implementation lives under
// src/testing so consumers get the same one from the public entry.
export {
  type CreateTestHarnessOptions,
  type CreateTestKernelOptions,
  createTestHarness,
  createTestKernel,
  type HarnessRunResult,
  type TickReport,
} from "../../testing/index.js";
// Mock AI helper
export {
  createMockAIHelper,
  createMockAIHelperFactory,
  MockAIHelper,
  type MockAIHelperConfig,
  type MockAIHelperFactory,
  type MockBatchResult,
  type MockEmbedResponse,
  type MockObjectResponse,
  type MockTextResponse,
  type RecordedCall,
} from "./mock-ai-helper.js";
// StepLedger test double
export { wrapStepLedger } from "./step-ledger-double.js";
// Test factories
export {
  createConfigurableStage,
  createErrorStage,
  createFailingSuspendStage,
  createFixedOutputStage,
  // Stage factories
  createPassthroughStage,
  // Workflow factories
  createSequentialWorkflow,
  // Async-batch stage factories
  createSuspendingStage,
  createTestStepApi,
  createTrackedWorkflow,
  createTrackingStage,
  createTransformStage,
  TestConfigSchemas,
  // Schemas
  TestSchemas,
} from "./test-factories.js";
