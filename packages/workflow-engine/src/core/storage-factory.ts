/**
 * Factory for creating storage provider instances
 *
 * Prisma storage requires a PrismaClient to be passed via options.
 */

import type { StageStorage } from "./storage";
import { InMemoryStageStorage } from "./storage-providers/memory-storage";
import { PrismaStageStorage } from "./storage-providers/prisma-storage";

// Type alias - actual client should be injected from app layer
type PrismaClient = any;

export type StorageProviderType = "prisma" | "memory";

export interface StorageFactoryOptions {
  provider: StorageProviderType;
  workflowRunId: string;
  workflowType: string;
  /** Required when provider is "prisma" */
  prisma?: PrismaClient;
}

/**
 * Create a storage instance based on the provider type
 */
export function createStorage(options: StorageFactoryOptions): StageStorage {
  const { provider, workflowRunId, workflowType, prisma } = options;

  switch (provider) {
    case "prisma":
      if (!prisma) {
        throw new Error(
          "Prisma storage requires a prisma client. " +
            'Pass it via options.prisma or use provider: "memory" for testing.',
        );
      }
      return new PrismaStageStorage(prisma, workflowRunId, workflowType);

    case "memory":
      return new InMemoryStageStorage(workflowRunId, workflowType);

    default:
      throw new Error(`Unknown storage provider: ${provider}`);
  }
}

/**
 * Get default provider from environment or config
 * Falls back to 'prisma' for database-backed persistence
 */
export function getDefaultStorageProvider(): StorageProviderType {
  const provider = process.env.WORKFLOW_STORAGE_PROVIDER as StorageProviderType;

  if (provider && ["prisma", "memory"].includes(provider)) {
    return provider;
  }

  return "prisma";
}
