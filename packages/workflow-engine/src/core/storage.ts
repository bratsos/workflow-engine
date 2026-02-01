/**
 * Storage abstraction for stage artifacts and outputs
 *
 * Modified to support Prisma/Memory storage only (R2 removed)
 */

export interface StageStorage {
  /**
   * Save data to storage
   */
  save<T>(key: string, data: T): Promise<void>;

  /**
   * Load data from storage
   */
  load<T>(key: string): Promise<T>;

  /**
   * Check if key exists in storage
   */
  exists(key: string): Promise<boolean>;

  /**
   * Delete data from storage
   */
  delete(key: string): Promise<void>;

  /**
   * Generate a storage key for a stage
   */
  getStageKey(stageId: string, suffix?: string): string;

  /**
   * Save stage output with standard key
   */
  saveStageOutput<T>(stageId: string, output: T): Promise<string>;

  /**
   * Load stage output with standard key
   */
  loadStageOutput<T>(stageId: string): Promise<T>;

  /**
   * Save arbitrary artifact for a stage
   */
  saveArtifact<T>(
    stageId: string,
    artifactName: string,
    data: T,
  ): Promise<string>;

  /**
   * Load arbitrary artifact for a stage
   */
  loadArtifact<T>(stageId: string, artifactName: string): Promise<T>;

  /**
   * List all artifacts for a workflow run (for export)
   */
  listAllArtifacts(): Promise<
    Array<{ key: string; stageId: string; name: string }>
  >;

  /**
   * Provider metadata
   */
  readonly providerType: "prisma" | "memory";
}
