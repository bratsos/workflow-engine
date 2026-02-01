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
  AICallLogger,
  AICallRecord,
  AIHelperStats,
  ArtifactType,
  CreateAICallInput,
  CreateLogInput,
  CreateRunInput,
  CreateStageInput,
  DequeueResult,
  EnqueueJobInput,
  JobQueue,
  JobRecord,
  JobStatus,
  LogLevel,
  SaveArtifactInput,
  Status,
  UpdateRunInput,
  UpdateStageInput,
  UpsertStageInput,
  WorkflowArtifactRecord,
  WorkflowLogRecord,
  WorkflowPersistence,
  WorkflowRunRecord,
  WorkflowStageRecord,
  WorkflowStageStatus,
  WorkflowStatus,
} from "./interface";

// Export Prisma implementations
export {
  createPrismaAICallLogger,
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
  PrismaAICallLogger,
  PrismaJobQueue,
  PrismaWorkflowPersistence,
} from "./prisma";
