/**
 * Testing Utilities for @bratsos/workflow-engine
 *
 * This module provides in-memory implementations of all persistence interfaces,
 * making it easy to test workflows without a database.
 *
 * @example
 * ```typescript
 * import {
 *   InMemoryWorkflowPersistence,
 *   InMemoryJobQueue,
 *   InMemoryAICallLogger,
 * } from '@bratsos/workflow-engine/testing';
 *
 * // Create in-memory instances for testing
 * const persistence = new InMemoryWorkflowPersistence();
 * const jobQueue = new InMemoryJobQueue();
 * const aiLogger = new InMemoryAICallLogger();
 *
 * // Use with kernel
 * const kernel = createKernel({
 *   persistence,
 *   jobTransport: jobQueue,
 *   blobStore: new InMemoryBlobStore(),
 *   eventSink: new CollectingEventSink(),
 *   registry: { getWorkflow: (id) => workflows.get(id) },
 * });
 *
 * // Reset between tests
 * beforeEach(() => {
 *   persistence.clear();
 *   jobQueue.clear();
 *   aiLogger.clear();
 * });
 * ```
 */

export type {
  CreateMockAIHelperFactoryOptions,
  MockAIHelperConfig,
  MockAIHelperFactory,
  MockBatchResult,
  MockCallDescriptor,
  MockCallMatcher,
  MockEmbedResponse,
  MockObjectResponse,
  MockOneShotFailure,
  MockTextResponse,
  RecordedCall,
} from "../__tests__/utils/mock-ai-helper.js";
export {
  createMockAIHelper,
  createMockAIHelperFactory,
  MockAIHelper,
} from "../__tests__/utils/mock-ai-helper.js";
export {
  type CreateTestHarnessOptions,
  createTestHarness,
  type HarnessRunResult,
  type TickReport,
} from "./create-test-harness.js";
export {
  type CreateTestKernelOptions,
  createTestKernel,
} from "./create-test-kernel.js";
export { InMemoryAICallLogger } from "./in-memory-ai-logger.js";
export { InMemoryJobQueue } from "./in-memory-job-queue.js";
export { InMemoryWorkflowPersistence } from "./in-memory-persistence.js";
export { InMemoryStepLedger } from "./in-memory-step-ledger.js";
export type {
  AILoggerFactory,
  ConformanceTestApi,
  JobQueueFactory,
  PersistenceFactory,
} from "./persistence-conformance.js";
export {
  aiCallLoggerConformanceSuite,
  jobQueueConformanceSuite,
  persistenceConformanceSuite,
} from "./persistence-conformance.js";
// Shadowing: check a candidate pipeline against runs that already exist.
export {
  assertShadowCompatible,
  type ShadowIssue,
  type ShadowIssueCode,
  type ShadowReport,
  type ShadowRunResult,
  type ShadowRunsOptions,
  type ShadowVersionResult,
  type ShadowVersionsOptions,
  type ShadowVersionsReport,
  shadowRuns,
  shadowVersions,
} from "./shadow-runs.js";
