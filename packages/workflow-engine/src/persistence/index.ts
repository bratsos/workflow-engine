/**
 * Persistence Interfaces and Types
 *
 * This module exports the interfaces that abstract database operations.
 * For production use, import the Prisma implementations and create instances
 * with a PrismaClient.
 *
 * @example
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 * import {
 *   WorkflowPersistence,
 *   PrismaWorkflowPersistence,
 *   createPrismaAICallLogger,
 *   createPrismaJobQueue
 * } from '@bratsos/workflow-engine';
 *
 * const prisma = new PrismaClient();
 * const persistence = new PrismaWorkflowPersistence(prisma);
 * const aiLogger = createPrismaAICallLogger(prisma);
 * const jobQueue = createPrismaJobQueue(prisma);
 * ```
 */

// Export interfaces and types
export type {
  WorkflowPersistence,
  AICallLogger,
  JobQueue,
  WorkflowRunRecord,
  WorkflowStageRecord,
  WorkflowLogRecord,
  WorkflowArtifactRecord,
  AICallRecord,
  JobRecord,
  Status,
  WorkflowStatus,
  WorkflowStageStatus,
  JobStatus,
  LogLevel,
  ArtifactType,
  CreateRunInput,
  UpdateRunInput,
  CreateStageInput,
  UpdateStageInput,
  UpsertStageInput,
  CreateLogInput,
  SaveArtifactInput,
  CreateAICallInput,
  EnqueueJobInput,
  DequeueResult,
  AIHelperStats,
} from "./interface";

// Export Prisma implementations
export {
  PrismaWorkflowPersistence,
  PrismaAICallLogger,
  PrismaJobQueue,
  createPrismaWorkflowPersistence,
  createPrismaAICallLogger,
  createPrismaJobQueue,
} from "./prisma";
