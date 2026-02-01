/**
 * In-memory storage implementation for testing
 *
 * Stores artifacts in memory using a static Map for cross-instance access
 */

import type { StageStorage } from "../storage";

export class InMemoryStageStorage implements StageStorage {
  readonly providerType = "memory" as const;

  // Static storage for all workflow runs (for testing across instances)
  private static globalStorage = new Map<string, Map<string, unknown>>();

  private storage: Map<string, unknown>;

  constructor(
    private workflowRunId: string,
    private workflowType: string,
  ) {
    // Get or create storage for this workflow run
    if (!InMemoryStageStorage.globalStorage.has(workflowRunId)) {
      InMemoryStageStorage.globalStorage.set(workflowRunId, new Map());
    }
    const storage = InMemoryStageStorage.globalStorage.get(workflowRunId);
    if (!storage) {
      throw new Error(
        `Failed to initialize storage for workflow run ${workflowRunId}`,
      );
    }
    this.storage = storage;
  }

  /**
   * Generate storage key with consistent pattern:
   * workflow-v2/{type}/{runId}/{stageId}/{suffix|output.json}
   */
  getStageKey(stageId: string, suffix?: string): string {
    const base = `workflow-v2/${this.workflowType}/${this.workflowRunId}/${stageId}`;
    return suffix ? `${base}/${suffix}` : `${base}/output.json`;
  }

  /**
   * Save data to memory (deep clone to prevent mutations)
   */
  async save<T>(key: string, data: T): Promise<void> {
    // Deep clone to prevent mutations
    this.storage.set(key, JSON.parse(JSON.stringify(data)));
  }

  /**
   * Load data from memory (deep clone to prevent mutations)
   */
  async load<T>(key: string): Promise<T> {
    if (!this.storage.has(key)) {
      throw new Error(`Artifact not found: ${key}`);
    }
    // Deep clone to prevent mutations
    return JSON.parse(JSON.stringify(this.storage.get(key))) as T;
  }

  /**
   * Check if key exists in memory
   */
  async exists(key: string): Promise<boolean> {
    return this.storage.has(key);
  }

  /**
   * Delete data from memory
   */
  async delete(key: string): Promise<void> {
    this.storage.delete(key);
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
   * List all artifacts for a workflow run
   */
  async listAllArtifacts(): Promise<
    Array<{ key: string; stageId: string; name: string }>
  > {
    const artifacts: Array<{ key: string; stageId: string; name: string }> = [];

    for (const key of this.storage.keys()) {
      // Extract stageId from key: workflow-v2/{type}/{runId}/{stageId}/...
      const keyParts = key.split("/");
      const stageId = keyParts.length >= 4 ? keyParts[3] : "unknown";

      // Extract name from key (last part)
      const name = keyParts[keyParts.length - 1] || "unknown";

      artifacts.push({
        key: key,
        stageId: stageId,
        name: name,
      });
    }

    return artifacts;
  }

  /**
   * Testing helper: Clear all storage or specific workflow run
   */
  static clear(workflowRunId?: string): void {
    if (workflowRunId) {
      InMemoryStageStorage.globalStorage.delete(workflowRunId);
    } else {
      InMemoryStageStorage.globalStorage.clear();
    }
  }

  /**
   * Testing helper: Get all data for a workflow run
   */
  static getAll(workflowRunId: string): Map<string, unknown> {
    return InMemoryStageStorage.globalStorage.get(workflowRunId) || new Map();
  }
}
