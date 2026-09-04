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

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import {
  aiCallLoggerConformanceSuite,
  jobQueueConformanceSuite,
  persistenceConformanceSuite,
  stepLedgerConformanceSuite,
} from "../../testing/persistence-conformance.js";

const api = { describe, it, expect, beforeEach };

persistenceConformanceSuite(
  "InMemoryWorkflowPersistence",
  () => new InMemoryWorkflowPersistence(),
  api,
);

aiCallLoggerConformanceSuite(
  "InMemoryAICallLogger",
  () => new InMemoryAICallLogger(),
  api,
);

jobQueueConformanceSuite("InMemoryJobQueue", () => new InMemoryJobQueue(), api);

stepLedgerConformanceSuite(
  "InMemoryStepLedger",
  () => new InMemoryStepLedger(),
  api,
);
