/**
 * Prisma-backed storage implementation
 *
 * Stores artifacts in the database using the WorkflowArtifact table
 * Requires a PrismaClient to be injected via constructor.
 */

// Type alias - actual client should be injected from app layer
type PrismaClient = any;

import type { StageStorage } from "../storage";

export class PrismaStageStorage implements StageStorage {
  readonly providerType = "prisma" as const;

  constructor(
    private prisma: PrismaClient,
    private workflowRunId: string,
    private workflowType: string,
  ) {}

  /**
   * Generate storage key with consistent pattern:
   * workflow-v2/{type}/{runId}/{stageId}/{suffix|output.json}
   */
  getStageKey(stageId: string, suffix?: string): string {
    const base = `workflow-v2/${this.workflowType}/${this.workflowRunId}/${stageId}`;
    return suffix ? `${base}/${suffix}` : `${base}/output.json`;
  }

  /**
   * Save data as JSON to database
   */
  async save<T>(key: string, data: T): Promise<void> {
    const json = JSON.stringify(data);
    const size = Buffer.byteLength(json, "utf8");

    // Determine artifact type based on key pattern
    const type = key.includes("/artifacts/") ? "ARTIFACT" : "STAGE_OUTPUT";

    // Extract stageId from key if possible
    // Key format: workflow-v2/{type}/{runId}/{stageId}/...
    const keyParts = key.split("/");
    const stageId = keyParts.length >= 4 ? keyParts[3] : undefined;

    let workflowStageId: string | null = null;
    if (stageId) {
      // Find the WorkflowStage record
      const stage = await this.prisma.workflowStage.findUnique({
        where: {
          workflowRunId_stageId: {
            workflowRunId: this.workflowRunId,
            stageId: stageId,
          },
        },
        select: { id: true },
      });
      workflowStageId = stage?.id ?? null;
    }

    await this.prisma.workflowArtifact.upsert({
      where: {
        workflowRunId_key: {
          workflowRunId: this.workflowRunId,
          key: key,
        },
      },
      update: {
        data: data as unknown,
        size: size,
        type: type,
        workflowStageId: workflowStageId,
      },
      create: {
        workflowRunId: this.workflowRunId,
        workflowStageId: workflowStageId,
        key: key,
        type: type,
        data: data as unknown,
        size: size,
      },
    });
  }

  /**
   * Load and parse JSON from database
   */
  async load<T>(key: string): Promise<T> {
    const artifact = await this.prisma.workflowArtifact.findUnique({
      where: {
        workflowRunId_key: {
          workflowRunId: this.workflowRunId,
          key: key,
        },
      },
    });

    if (!artifact) {
      throw new Error(`Artifact not found: ${key}`);
    }

    return artifact.data as T;
  }

  /**
   * Check if artifact exists in database
   */
  async exists(key: string): Promise<boolean> {
    const artifact = await this.prisma.workflowArtifact.findUnique({
      where: {
        workflowRunId_key: {
          workflowRunId: this.workflowRunId,
          key: key,
        },
      },
      select: { id: true },
    });

    return artifact !== null;
  }

  /**
   * Delete artifact from database
   */
  async delete(key: string): Promise<void> {
    await this.prisma.workflowArtifact.delete({
      where: {
        workflowRunId_key: {
          workflowRunId: this.workflowRunId,
          key: key,
        },
      },
    });
  }

  /**
   * Save stage output with standard key
   */
  async saveStageOutput<T>(stageId: string, output: T): Promise<string> {
    const key = this.getStageKey(stageId);
    await this.save(key, output);
    return key;
  }

  /**
   * Load stage output with standard key
   */
  async loadStageOutput<T>(stageId: string): Promise<T> {
    const key = this.getStageKey(stageId);
    return await this.load<T>(key);
  }

  /**
   * Save arbitrary artifact for a stage
   */
  async saveArtifact<T>(
    stageId: string,
    artifactName: string,
    data: T,
  ): Promise<string> {
    const key = this.getStageKey(stageId, `artifacts/${artifactName}.json`);
    await this.save(key, data);
    return key;
  }

  /**
   * Load arbitrary artifact for a stage
   */
  async loadArtifact<T>(stageId: string, artifactName: string): Promise<T> {
    const key = this.getStageKey(stageId, `artifacts/${artifactName}.json`);
    return await this.load<T>(key);
  }

  /**
   * List all artifacts for a workflow run (for export)
   */
  async listAllArtifacts(): Promise<
    Array<{ key: string; stageId: string; name: string }>
  > {
    const artifacts = await this.prisma.workflowArtifact.findMany({
      where: {
        workflowRunId: this.workflowRunId,
      },
      select: {
        key: true,
        workflowStageId: true,
      },
    });

    return artifacts.map(
      (artifact: { key: string; workflowStageId: string | null }) => {
        // Extract stageId from key: workflow-v2/{type}/{runId}/{stageId}/...
        const keyParts = artifact.key.split("/");
        const stageId = keyParts.length >= 4 ? keyParts[3] : "unknown";

        // Extract name from key (last part)
        const name = keyParts[keyParts.length - 1] || "unknown";

        return {
          key: artifact.key,
          stageId: stageId,
          name: name,
        };
      },
    );
  }
}

/**
 * Factory function to create PrismaStageStorage
 */
export function createPrismaStageStorage(
  prisma: PrismaClient,
  workflowRunId: string,
  workflowType: string,
): PrismaStageStorage {
  return new PrismaStageStorage(prisma, workflowRunId, workflowType);
}
