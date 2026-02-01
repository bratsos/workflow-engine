/**
 * Stage ID Utilities - Type-safe stage ID management
 *
 * Provides utilities for creating type-safe stage ID constants and
 * branded types to prevent typos in stage ID references.
 *
 * ## Usage Patterns
 *
 * ### Pattern 1: Create Stage IDs from a Workflow (Recommended)
 *
 * ```typescript
 * import { createStageIds } from "~/lib/workflow-v2/core/stage-ids";
 *
 * export const STAGE_IDS = createStageIds(certificateWorkflow);
 * // = {
 * //   DATA_EXTRACTION: "data-extraction",
 * //   GUIDELINES: "guidelines",
 * //   GENERATOR: "generator",
 * // } as const
 *
 * // Use in stage definitions
 * dependencies: [STAGE_IDS.DATA_EXTRACTION],  // Autocomplete!
 * ```
 *
 * ### Pattern 2: Define Stage IDs First (For Complex Workflows)
 *
 * ```typescript
 * export const CERTIFICATE_STAGES = defineStageIds([
 *   "data-extraction",
 *   "guidelines",
 *   "legal-guidance",
 *   "unified-smart-retrieval",
 *   "analysis-synthesis",
 *   "generator",
 * ] as const);
 *
 * // Type: { DATA_EXTRACTION: "data-extraction", ... }
 * // With validation that stages match workflow definition
 * ```
 *
 * ### Pattern 3: Use with InferWorkflowStageIds
 *
 * ```typescript
 * import type { InferWorkflowStageIds } from "~/lib/workflow-v2/core/workflow";
 *
 * type CertificateStageId = InferWorkflowStageIds<typeof certificateWorkflow>;
 * // = "data-extraction" | "guidelines" | "generator" | ...
 *
 * function requireStage(stageId: CertificateStageId) { ... }
 * ```
 */

import type { Workflow } from "./workflow";

// ============================================================================
// Stage ID Helpers
// ============================================================================

/**
 * Convert a kebab-case stage ID to SCREAMING_SNAKE_CASE
 *
 * @example
 * toConstantCase("data-extraction") // "DATA_EXTRACTION"
 * toConstantCase("unified-smart-retrieval") // "UNIFIED_SMART_RETRIEVAL"
 */
function toConstantCase(stageId: string): string {
  return stageId.toUpperCase().replace(/-/g, "_");
}

/**
 * Create a type-safe stage ID constants object from a workflow
 *
 * Extracts all stage IDs from a workflow and creates a frozen object
 * with SCREAMING_SNAKE_CASE keys for autocomplete and type safety.
 *
 * @example
 * ```typescript
 * import { certificateWorkflow } from "./certificate-workflow";
 *
 * export const STAGE_IDS = createStageIds(certificateWorkflow);
 * // = {
 * //   DATA_EXTRACTION: "data-extraction",
 * //   GUIDELINES: "guidelines",
 * //   LEGAL_GUIDANCE: "legal-guidance",
 * //   GENERATOR: "generator",
 * // } as const
 *
 * // Use in code with autocomplete:
 * const data = ctx.require(STAGE_IDS.DATA_EXTRACTION);
 * ```
 */
export function createStageIds<W extends Workflow<any, any, any>>(
  workflow: W,
): StageIdConstants<W> {
  const stageIds = workflow.getStageIds();
  const result: Record<string, string> = {};

  for (const id of stageIds) {
    const key = toConstantCase(id);
    result[key] = id;
  }

  return Object.freeze(result) as StageIdConstants<W>;
}

/**
 * Define stage IDs from a tuple of string literals
 *
 * Use this when you want to define stage IDs before building the workflow,
 * or when you need to share stage IDs across multiple files.
 *
 * @example
 * ```typescript
 * // Define stage IDs first
 * export const CERTIFICATE_STAGES = defineStageIds([
 *   "data-extraction",
 *   "guidelines",
 *   "legal-guidance",
 *   "generator",
 * ] as const);
 *
 * // Use in stage definitions
 * dependencies: [CERTIFICATE_STAGES.DATA_EXTRACTION],
 *
 * // Type-safe access
 * type StageId = typeof CERTIFICATE_STAGES[keyof typeof CERTIFICATE_STAGES];
 * // = "data-extraction" | "guidelines" | ...
 * ```
 */
export function defineStageIds<const T extends readonly string[]>(
  stageIds: T,
): DefineStageIdsResult<T> {
  const result: Record<string, string> = {};

  for (const id of stageIds) {
    const key = toConstantCase(id);
    result[key] = id;
  }

  return Object.freeze(result) as DefineStageIdsResult<T>;
}

/**
 * Validate that a stage ID exists in a workflow
 *
 * Use this for runtime validation when the stage ID comes from user input.
 *
 * @example
 * ```typescript
 * const stageId = request.params.stageId;
 *
 * if (!isValidStageId(certificateWorkflow, stageId)) {
 *   throw new Error(`Invalid stage ID: ${stageId}`);
 * }
 * ```
 */
export function isValidStageId<W extends Workflow<any, any, any>>(
  workflow: W,
  stageId: string,
): stageId is WorkflowStageId<W> {
  return workflow.hasStage(stageId);
}

/**
 * Assert that a stage ID exists in a workflow
 *
 * Throws an error with helpful message if the stage ID is invalid.
 *
 * @example
 * ```typescript
 * assertValidStageId(certificateWorkflow, stageId);
 * // Now TypeScript knows stageId is a valid stage ID
 * ```
 */
export function assertValidStageId<W extends Workflow<any, any, any>>(
  workflow: W,
  stageId: string,
): asserts stageId is WorkflowStageId<W> {
  if (!workflow.hasStage(stageId)) {
    const validIds = workflow.getStageIds();
    throw new Error(
      `Invalid stage ID: "${stageId}". ` +
        `Valid stage IDs for workflow "${workflow.id}": ${validIds.join(", ")}`,
    );
  }
}

// ============================================================================
// Type Utilities
// ============================================================================

/**
 * Extract stage IDs as a string union from a Workflow type
 *
 * @example
 * ```typescript
 * type StageId = WorkflowStageId<typeof certificateWorkflow>;
 * // = "data-extraction" | "guidelines" | "generator" | ...
 * ```
 */
export type WorkflowStageId<W extends Workflow<any, any, any>> =
  W extends Workflow<any, any, infer C> ? keyof C & string : never;

/**
 * Result type for createStageIds function
 *
 * Maps each stage ID to a SCREAMING_SNAKE_CASE key.
 */
type StageIdConstants<W extends Workflow<any, any, any>> = {
  readonly [K in WorkflowStageId<W> as Uppercase<
    K extends string ? ReplaceHyphens<K> : never
  >]: K;
};

/**
 * Result type for defineStageIds function
 */
type DefineStageIdsResult<T extends readonly string[]> = {
  readonly [K in T[number] as Uppercase<
    K extends string ? ReplaceHyphens<K> : never
  >]: K;
};

/**
 * Helper type to replace hyphens with underscores
 */
type ReplaceHyphens<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Head}_${ReplaceHyphens<Tail>}`
  : S;

// ============================================================================
// Stage ID Validation Types
// ============================================================================

/**
 * Validate that stage IDs match a workflow's expected stages
 *
 * Use this to ensure stage ID constants are in sync with the workflow.
 *
 * @example
 * ```typescript
 * // This will cause a compile error if stage IDs don't match
 * const STAGE_IDS: ValidateStageIds<
 *   typeof certificateWorkflow,
 *   typeof CERTIFICATE_STAGES
 * > = CERTIFICATE_STAGES;
 * ```
 */
export type ValidateStageIds<
  W extends Workflow<any, any, any>,
  T extends Record<string, string>,
> = {
  [K in keyof T]: T[K] extends WorkflowStageId<W>
    ? T[K]
    : `Error: "${T[K] & string}" is not a valid stage ID in workflow`;
};
