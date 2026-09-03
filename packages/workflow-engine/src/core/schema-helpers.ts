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
