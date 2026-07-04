/**
 * Adapter Conformance Tests
 *
 * These tests verify that the in-memory implementations follow the
 * persistence contract shared with third-party adapters. The actual
 * suite factories live in `src/testing/persistence-conformance.ts` (also
 * exported from `@bratsos/workflow-engine/testing`) so a custom
 * `WorkflowPersistence` / `JobQueue` / `AICallLogger` implementation can
 * run the exact same spec.
 *
 * Currently tests:
 * - WorkflowPersistence interface
 * - AICallLogger interface
 * - JobQueue interface
 */

import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";
import {
  aiCallLoggerConformanceSuite,
  jobQueueConformanceSuite,
  persistenceConformanceSuite,
} from "../../testing/persistence-conformance.js";

persistenceConformanceSuite(
  "InMemoryWorkflowPersistence",
  () => new InMemoryWorkflowPersistence(),
);

aiCallLoggerConformanceSuite(
  "InMemoryAICallLogger",
  () => new InMemoryAICallLogger(),
);

jobQueueConformanceSuite("InMemoryJobQueue", () => new InMemoryJobQueue());
