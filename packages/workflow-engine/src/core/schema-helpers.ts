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
 *
 * @deprecated Prefer `ctx.require()` inside a stage's `execute()` — it's
 * typed from the workflow's inferred `TContext` with no generic needed.
 * This standalone helper remains for code that accesses `workflowContext`
 * outside of a stage's `execute()` (e.g. shared utility functions). Removal
 * at 1.0.
 */
export function requireStageOutput<T>(
  workflowContext: Record<string, unknown>,
  stageId: string,
  field?: string,
): T {
  const stageOutput = workflowContext[stageId];

  // NOTE: `=== undefined` (not a falsy check) so legitimate falsy outputs
  // (0, "", false) pass through instead of being treated as missing —
  // matches `ctx.require()`'s semantics.
  if (stageOutput === undefined) {
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
