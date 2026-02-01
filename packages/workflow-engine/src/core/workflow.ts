/**
 * Workflow Builder - Fluent API for composing type-safe workflows
 *
 * Workflows are composed of stages that are executed sequentially or in parallel.
 * The builder ensures type safety: output of one stage matches input of next stage.
 *
 * ## Type System Features
 *
 * ### Automatic Context Inference
 * The workflow context type is automatically accumulated as you pipe stages.
 * Use `InferWorkflowContext<typeof workflow>` to extract the context type.
 *
 * ```typescript
 * const workflow = new WorkflowBuilder(...)
 *   .pipe(stage1)
 *   .pipe(stage2)
 *   .build();
 *
 * // Auto-generated type
 * type MyContext = InferWorkflowContext<typeof workflow>;
 * // = { "stage-1": Stage1Output, "stage-2": Stage2Output }
 * ```
 *
 * ### Stage ID Constants
 * Use `workflow.stageIds` for type-safe stage ID references.
 */

import { z } from "zod";
import type { Stage } from "./stage";

// ============================================================================
// Stage Node - Represents a stage in the execution plan
// ============================================================================

export interface StageNode {
  stage: Stage<any, any, any>;
  executionGroup: number; // For parallel execution grouping
}

// ============================================================================
// Workflow - Complete workflow definition
// ============================================================================

export class Workflow<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = {},
> {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly description: string,
    public readonly inputSchema: TInput,
    public readonly outputSchema: TOutput,
    private readonly stages: StageNode[],
    public readonly contextType?: TContext, // Type-only, for inference
  ) {}

  /**
   * Get execution plan as groups of stages
   * Stages in the same group can be executed in parallel
   */
  getExecutionPlan(): StageNode[][] {
    const groups = new Map<number, StageNode[]>();

    for (const node of this.stages) {
      const group = groups.get(node.executionGroup) || [];
      group.push(node);
      groups.set(node.executionGroup, group);
    }

    // Return groups in order
    const sortedGroups = Array.from(groups.keys()).sort((a, b) => a - b);
    return sortedGroups.map((groupNum) => {
      const group = groups.get(groupNum);
      if (!group) throw new Error(`Group ${groupNum} not found`);
      return group;
    });
  }

  /**
   * Get a specific stage by ID
   */
  getStage(stageId: string): Stage<any, any, any> | undefined {
    const node = this.stages.find((n) => n.stage.id === stageId);
    return node?.stage;
  }

  /**
   * Get all stages in order
   */
  getAllStages(): StageNode[] {
    return [...this.stages];
  }

  /**
   * Get a visual representation of the workflow execution order
   */
  getExecutionOrder(): string {
    const executionPlan = this.getExecutionPlan();
    const lines: string[] = [];

    lines.push(`Workflow: ${this.name} (${this.id})`);
    lines.push(`Total stages: ${this.stages.length}`);
    lines.push(`Execution groups: ${executionPlan.length}`);
    lines.push("");
    lines.push("Execution Order:");
    lines.push("================");

    for (let i = 0; i < executionPlan.length; i++) {
      const group = executionPlan[i];
      const groupNumber = i + 1;

      if (group.length === 1) {
        // Sequential stage
        const stage = group[0].stage;
        lines.push(`${groupNumber}. ${stage.name} (${stage.id})`);
        if (stage.description) {
          lines.push(`   ${stage.description}`);
        }
      } else {
        // Parallel stages
        lines.push(`${groupNumber}. [PARALLEL]`);
        for (const node of group) {
          const stage = node.stage;
          lines.push(`   - ${stage.name} (${stage.id})`);
          if (stage.description) {
            lines.push(`     ${stage.description}`);
          }
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Get all stage IDs in execution order
   *
   * @returns Array of stage IDs
   *
   * @example
   * ```typescript
   * const ids = workflow.getStageIds();
   * // ["data-extraction", "guidelines", "generator"]
   * ```
   */
  getStageIds(): string[] {
    return this.stages.map((node) => node.stage.id);
  }

  /**
   * Check if a stage ID exists in this workflow
   *
   * @param stageId - The stage ID to check
   * @returns true if the stage exists
   */
  hasStage(stageId: string): boolean {
    return this.stages.some((node) => node.stage.id === stageId);
  }

  /**
   * Validate workflow configuration before execution
   * Checks that all stage configs match their schemas
   *
   * @param config - Configuration object with keys matching stage IDs
   * @returns Validation result with any errors
   */
  validateConfig(config: Record<string, unknown>): {
    valid: boolean;
    errors: Array<{ stageId: string; error: string }>;
  } {
    const errors: Array<{ stageId: string; error: string }> = [];

    for (const node of this.stages) {
      const stage = node.stage;
      const stageConfig = config[stage.id] || {};

      try {
        stage.configSchema.parse(stageConfig);
      } catch (error) {
        if (error instanceof z.ZodError) {
          const errorMessages = error.issues
            .map((e: z.ZodIssue) => `${e.path.join(".")}: ${e.message}`)
            .join("; ");
          errors.push({
            stageId: stage.id,
            error: `Config validation failed: ${errorMessages}`,
          });
        } else {
          errors.push({
            stageId: stage.id,
            error: String(error),
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Estimate total cost for the workflow
   */
  estimateCost(
    input: z.infer<TInput>,
    config: Record<string, unknown>,
  ): number {
    let totalCost = 0;
    const currentInput = input;

    for (const node of this.stages) {
      if (node.stage.estimateCost) {
        const stageConfig = config[node.stage.id] || {};
        totalCost += node.stage.estimateCost(currentInput, stageConfig);
      }
      // Note: We can't accurately propagate input for estimation without execution
      // This is a rough estimate only
    }

    return totalCost;
  }

  /**
   * Get configuration schemas for all stages in this workflow
   * Returns a map of stageId → { schema, defaults, name, description }
   */
  getStageConfigs(): Record<
    string,
    {
      schema: z.ZodTypeAny;
      defaults: Record<string, unknown>;
      name: string;
      description?: string;
    }
  > {
    const configs: Record<
      string,
      {
        schema: z.ZodTypeAny;
        defaults: Record<string, unknown>;
        name: string;
        description?: string;
      }
    > = {};

    for (const node of this.stages) {
      const stage = node.stage;

      // Extract defaults from schema
      const defaults: Record<string, unknown> = {};

      if (stage.configSchema instanceof z.ZodObject) {
        const shape = stage.configSchema.shape as Record<string, z.ZodTypeAny>;
        for (const [key, fieldSchema] of Object.entries(shape)) {
          let unwrapped = fieldSchema;

          // Unwrap ZodOptional if present
          if (unwrapped instanceof z.ZodOptional) {
            unwrapped = (unwrapped._def as any).innerType;
          }

          // Check for ZodDefault
          if (unwrapped instanceof z.ZodDefault) {
            const defaultValueFn = (unwrapped._def as any).defaultValue;
            defaults[key] =
              typeof defaultValueFn === "function"
                ? defaultValueFn()
                : defaultValueFn;
          }
        }
      }

      configs[stage.id] = {
        schema: stage.configSchema,
        defaults,
        name: stage.name,
        description: stage.description,
      };
    }

    return configs;
  }

  /**
   * Generate default configuration object for all stages
   * Automatically discovers all stage configs - add/remove stages and this updates automatically
   */
  getDefaultConfig(): Record<string, Record<string, unknown>> {
    const stageConfigs = this.getStageConfigs();
    const config: Record<string, Record<string, unknown>> = {};

    for (const [stageId, meta] of Object.entries(stageConfigs)) {
      config[stageId] = meta.defaults;
    }

    return config;
  }
  /**
   * Get all stages in a specific execution group
   */
  getStagesInExecutionGroup(groupIndex: number): Stage<any, any, any>[] {
    return this.stages
      .filter((node) => node.executionGroup === groupIndex)
      .map((node) => node.stage);
  }

  /**
   * Get the sequential index of a stage (0-based)
   */
  getStageIndex(stageId: string): number {
    return this.stages.findIndex((node) => node.stage.id === stageId);
  }

  /**
   * Get the execution group index for a stage
   */
  getExecutionGroupIndex(stageId: string): number {
    const node = this.stages.find((node) => node.stage.id === stageId);
    if (!node) throw new Error(`Stage ${stageId} not found in workflow`);
    return node.executionGroup;
  }

  /**
   * Get the ID of the stage immediately preceding the given stage
   */
  getPreviousStageId(stageId: string): string | undefined {
    const index = this.getStageIndex(stageId);
    if (index <= 0) return undefined;
    return this.stages[index - 1].stage.id;
  }
}

// ============================================================================
// Workflow Builder - Fluent API with Context Accumulation
// ============================================================================

export class WorkflowBuilder<
  TInput extends z.ZodTypeAny,
  TCurrentOutput extends z.ZodTypeAny,
  TContext extends Record<string, unknown> = {},
> {
  private stages: StageNode[] = [];
  private currentExecutionGroup = 0;

  constructor(
    private id: string,
    private name: string,
    private description: string,
    private inputSchema: TInput,
    private currentOutputSchema: TCurrentOutput,
  ) {}

  /**
   * Add a stage to the workflow (sequential execution)
   *
   * Automatically accumulates the stage's output in the context under its stage ID.
   * This provides type-safe access to all previous stage outputs.
   *
   * Note: This accepts any stage regardless of strict input type matching.
   * This is necessary because stages using passthrough() can accept objects
   * with additional fields beyond what's declared in their input schema.
   * Runtime validation via Zod ensures type safety at execution time.
   *
   * Validates that all declared dependencies exist in the workflow.
   */
  pipe<
    TStageInput extends z.ZodTypeAny,
    TStageOutput extends z.ZodTypeAny,
    TStageConfig extends z.ZodTypeAny,
    TStageContext extends Record<string, unknown>,
  >(
    stage: Stage<TStageInput, TStageOutput, TStageConfig, TStageContext>,
  ): WorkflowBuilder<
    TInput,
    TStageOutput,
    TContext & { [x: string]: z.infer<TStageOutput> }
  > {
    // Validate stage dependencies
    if (stage.dependencies) {
      const existingStageIds = this.stages.map((s) => s.stage.id);
      const missingDeps = stage.dependencies.filter(
        (dep) => !existingStageIds.includes(dep),
      );

      if (missingDeps.length > 0) {
        throw new Error(
          `Stage "${stage.id}" has missing dependencies: ${missingDeps.join(", ")}. ` +
            `These stages must be added to the workflow before "${stage.id}". ` +
            `Current stages: ${
              existingStageIds.length === 0
                ? "(none)"
                : existingStageIds.join(", ")
            }`,
        );
      }
    }

    this.currentExecutionGroup++;

    this.stages.push({
      stage: stage as Stage<any, any, any, any>,
      executionGroup: this.currentExecutionGroup,
    });

    // Return builder with new output type and accumulated context
    const builder = this as unknown as WorkflowBuilder<
      TInput,
      TStageOutput,
      TContext & { [x: string]: z.infer<TStageOutput> }
    >;
    (builder as any).currentOutputSchema = stage.outputSchema;

    return builder;
  }

  /**
   * Add a stage with strict input type checking
   *
   * Note: pipeStrict() and pipeLoose() have been removed as they were
   * just aliases for pipe(). Use pipe() for all stage chaining.
   */

  /**
   * Add multiple stages that execute in parallel
   *
   * All stages receive the same input (current output)
   * Their outputs are merged into an object by index AND accumulated in context by stage ID.
   *
   * Note: This accepts stages regardless of strict input type matching.
   * This is necessary because stages using passthrough() can accept objects
   * with additional fields. Runtime validation via Zod ensures type safety.
   *
   * Validates that all declared dependencies exist in the workflow.
   */
  parallel<
    TStages extends {
      id: string;
      outputSchema: z.ZodTypeAny;
      dependencies?: string[];
    }[],
  >(
    stages: [...TStages],
  ): WorkflowBuilder<
    TInput,
    z.ZodTypeAny,
    TContext & {
      [K in TStages[number]["id"]]: TStages[number] extends {
        outputSchema: infer O;
      }
        ? O extends z.ZodTypeAny
          ? z.infer<O>
          : never
        : never;
    }
  > {
    // Validate dependencies for all parallel stages
    const existingStageIds = this.stages.map((s) => s.stage.id);

    for (const stage of stages) {
      if (stage.dependencies) {
        const missingDeps = stage.dependencies.filter(
          (dep) => !existingStageIds.includes(dep),
        );

        if (missingDeps.length > 0) {
          throw new Error(
            `Stage "${stage.id}" (in parallel group) has missing dependencies: ${missingDeps.join(
              ", ",
            )}. ` +
              `These stages must be added to the workflow before this parallel group. ` +
              `Current stages: ${
                existingStageIds.length === 0
                  ? "(none)"
                  : existingStageIds.join(", ")
              }`,
          );
        }
      }
    }

    this.currentExecutionGroup++;

    // Add all stages to same execution group
    for (const stage of stages) {
      this.stages.push({
        stage: stage as Stage<any, any, any, any>,
        executionGroup: this.currentExecutionGroup,
      });
    }

    // Create merged output schema
    const mergedSchema = z.object(
      stages.reduce(
        (acc, stage, index) => {
          acc[index] = stage.outputSchema;
          return acc;
        },
        {} as Record<number, z.ZodTypeAny>,
      ),
    ) as any;

    const builder = this as unknown as WorkflowBuilder<
      TInput,
      any,
      TContext & {
        [K in TStages[number]["id"]]: TStages[number] extends Stage<
          any,
          infer O,
          any
        >
          ? z.infer<O>
          : never;
      }
    >;
    builder.currentOutputSchema = mergedSchema;

    return builder as any;
  }

  /**
   * Build the final workflow
   */
  build(): Workflow<TInput, TCurrentOutput, TContext> {
    return new Workflow(
      this.id,
      this.name,
      this.description,
      this.inputSchema,
      this.currentOutputSchema,
      this.stages,
    );
  }

  /**
   * Get current stage count
   */
  getStageCount(): number {
    return this.stages.length;
  }

  /**
   * Get execution group count
   */
  getExecutionGroupCount(): number {
    return this.currentExecutionGroup;
  }
}

// ============================================================================
// Type Inference Utilities (Supplementary to Code Generator)
// ============================================================================

/**
 * NOTE: For most use cases, prefer using the generated types from `__generated__.ts`
 * which are created by running `pnpm generate:workflow-types`.
 *
 * These inference utilities are useful for:
 * - Quick prototyping before running the generator
 * - Dynamic workflows not covered by the generator
 * - Type assertions in tests
 */

/**
 * Extract the workflow context type from a Workflow instance
 *
 * The workflow context type is automatically accumulated as stages are piped.
 * Each stage's output is added to the context under its stage ID.
 *
 * @example
 * ```typescript
 * const workflow = new WorkflowBuilder(...)
 *   .pipe(dataExtractionStage)  // id: "data-extraction"
 *   .pipe(guidelinesStage)       // id: "guidelines"
 *   .build();
 *
 * // Extract context type automatically
 * type MyWorkflowContext = InferWorkflowContext<typeof workflow>;
 * // = {
 * //   "data-extraction": DataExtractionOutput;
 * //   "guidelines": GuidelinesOutput;
 * // }
 *
 * // Use in stage definitions
 * export const myStage = defineStage<
 *   "none",
 *   typeof OutputSchema,
 *   typeof ConfigSchema,
 *   MyWorkflowContext
 * >({ ... });
 * ```
 */
export type InferWorkflowContext<W> = W extends Workflow<any, any, infer C>
  ? C
  : never;

/**
 * Extract the input type from a Workflow instance
 *
 * @example
 * ```typescript
 * type Input = InferWorkflowInput<typeof myWorkflow>;
 * ```
 */
export type InferWorkflowInput<W> = W extends Workflow<infer I, any, any>
  ? z.infer<I>
  : never;

/**
 * Extract the output type from a Workflow instance
 *
 * @example
 * ```typescript
 * type Output = InferWorkflowOutput<typeof myWorkflow>;
 * ```
 */
export type InferWorkflowOutput<W> = W extends Workflow<any, infer O, any>
  ? z.infer<O>
  : never;

/**
 * Extract stage IDs as a union type from a Workflow instance
 *
 * Useful for creating type-safe stage ID references.
 *
 * @example
 * ```typescript
 * type StageId = InferWorkflowStageIds<typeof myWorkflow>;
 * // = "data-extraction" | "guidelines" | "generator"
 *
 * function getStageOutput(stageId: StageId) { ... }
 * ```
 */
export type InferWorkflowStageIds<W> = W extends Workflow<any, any, infer C>
  ? keyof C & string
  : never;

/**
 * Get the output type for a specific stage ID from a Workflow
 *
 * @example
 * ```typescript
 * type DataOutput = InferStageOutputById<typeof workflow, "data-extraction">;
 * ```
 */
export type InferStageOutputById<W, K extends string> = W extends Workflow<
  any,
  any,
  infer C
>
  ? K extends keyof C
    ? C[K]
    : never
  : never;
