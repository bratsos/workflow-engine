/**
 * Schema Helpers and Utilities
 *
 * Provides common schemas and utilities for building type-safe workflows.
 * Reduces boilerplate and enforces best practices.
 */

import { z } from "zod";

/**
 * Constant for stages that don't need sequential input
 * Use when a stage receives data from workflowContext instead of the input parameter
 *
 * @example
 * export const myStage: Stage<
 *   typeof NoInputSchema,  // Explicit: this stage uses workflowContext
 *   typeof OutputSchema,
 *   typeof ConfigSchema
 * > = {
 *   inputSchema: NoInputSchema,
 *   // ...
 * };
 */
export const NoInputSchema = z.object({});
export type NoInput = z.infer<typeof NoInputSchema>;

/**
 * Access previous stage output with guaranteed type safety
 *
 * Requires that the stage output exists, throws clear error if missing.
 * Use this for required dependencies on previous stages.
 *
 * @param workflowContext - The workflow context containing all previous stage outputs
 * @param stageId - ID of the stage to access
 * @param field - Optional: specific field to extract from stage output
 * @returns The stage output (or field within it)
 * @throws Error if stage or field is missing
 *
 * @example
 * // Get entire stage output
 * const extractedData = requireStageOutput<ExtractedData>(
 *   context.workflowContext,
 *   "data-extraction"
 * );
 *
 * // Get specific field
 * const guidelines = requireStageOutput<Guideline[]>(
 *   context.workflowContext,
 *   "guidelines",
 *   "guidelines"
 * );
 */
export function requireStageOutput<T>(
  workflowContext: Record<string, unknown>,
  stageId: string,
  field?: string,
): T {
  const stageOutput = workflowContext[stageId];

  if (!stageOutput) {
    throw new Error(
      `Missing output from required stage: ${stageId}. ` +
        `Check that this stage has been executed before the current stage. ` +
        `Available stages: ${Object.keys(workflowContext).join(", ")}`,
    );
  }

  if (field) {
    if (typeof stageOutput !== "object" || stageOutput === null) {
      throw new Error(
        `Stage ${stageId} output is not an object, cannot access field '${field}'. ` +
          `Received: ${typeof stageOutput}`,
      );
    }
    if (!(field in stageOutput)) {
      const availableFields = Object.keys(stageOutput);
      throw new Error(
        `Missing required field '${field}' in ${stageId} output. ` +
          `Available fields: ${availableFields.join(", ")}`,
      );
    }
    return (stageOutput as any)[field];
  }

  return stageOutput as T;
}

/**
 * Access previous stage output optionally
 *
 * Returns undefined if the stage output doesn't exist.
 * Use this for optional dependencies on previous stages.
 *
 * @param workflowContext - The workflow context containing all previous stage outputs
 * @param stageId - ID of the stage to access
 * @param field - Optional: specific field to extract from stage output
 * @returns The stage output (or field within it), or undefined if not present
 *
 * @example
 * const optionalData = getStageOutput<OptionalData>(
 *   context.workflowContext,
 *   "optional-stage"
 * );
 *
 * if (optionalData) {
 *   // Use the data
 * }
 */
export function getStageOutput<T>(
  workflowContext: Record<string, unknown>,
  stageId: string,
  field?: string,
): T | undefined {
  const stageOutput = workflowContext[stageId];

  if (!stageOutput) {
    return undefined;
  }

  if (field) {
    if (typeof stageOutput !== "object" || stageOutput === null) {
      return undefined;
    }
    return (stageOutput as any)[field];
  }

  return stageOutput as T;
}
