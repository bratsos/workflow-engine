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
 * // Use with WorkflowRuntime
 * const runtime = createWorkflowRuntime({
 *   persistence,
 *   jobQueue,
 *   aiLogger,
 *   workflows: [myWorkflow],
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

export { InMemoryWorkflowPersistence } from "./in-memory-persistence.js";
export { InMemoryJobQueue } from "./in-memory-job-queue.js";
export { InMemoryAICallLogger } from "./in-memory-ai-logger.js";
