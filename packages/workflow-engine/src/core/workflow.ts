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
import {
  buildDefinitionSnapshot,
  computeDefinitionVersion,
  type DefinitionSnapshot,
} from "./definition-version.js";
import type { NoInputSchema } from "./schema-helpers";
import type { Stage } from "./stage";
import {
  type AsyncBatchStageDefinition,
  defineStage,
  type SyncStageDefinition,
} from "./stage-factory";

// ============================================================================
// Stage Node - Represents a stage in the execution plan
// ============================================================================

export interface StageNode {
  stage: Stage<any, any, any>;
  executionGroup: number; // For parallel execution grouping
}

// ============================================================================
// Parallel Context Merging Helpers
// ============================================================================

/**
 * Merge the outputs of a tuple of parallel stages into a context map keyed by
 * stage id. Uses `Extract` on the discriminated `id` field so each key maps
 * to *its own* stage's output type instead of the union of every parallel
 * stage's output (which is what a naive conditional over `TStages[number]`
 * would produce).
 */
export type MergeParallelContext<
  TStages extends {
    id: string;
    outputSchema: z.ZodTypeAny;
    dependencies?: string[];
  }[],
> = {
  [K in TStages[number]["id"]]: Extract<TStages[number], { id: K }> extends {
    outputSchema: infer O extends z.ZodTypeAny;
  }
    ? z.infer<O>
    : never;
};

/**
 * The merged Zod object schema produced by combining the output schemas of a
 * tuple of parallel stages, keyed by stage id.
 */
export type MergeParallelOutputSchema<
  TStages extends {
    id: string;
    outputSchema: z.ZodTypeAny;
    dependencies?: string[];
  }[],
> = z.ZodObject<{
  [K in TStages[number]["id"]]: Extract<
    TStages[number],
    { id: K }
  >["outputSchema"];
}>;

// ============================================================================
// Config Defaults Extraction
// ============================================================================

/**
 * Extract each top-level field's default value from an object config schema.
 *
 * Delegates to `z.toJSONSchema()` instead of reaching into Zod's internal
 * `_def` representation (whose shape changed between Zod 3 and Zod 4, and
 * previously required a manual `typeof defaultValue === "function"` branch
 * for Zod-3-era function defaults). `z.toJSONSchema()` already resolves
 * `.default()` — including function defaults — to a plain value on each
 * property's `default` key, regardless of whether it's wrapped in
 * `ZodOptional`/`ZodDefault` or in which order.
 *
 * `unrepresentable: "any"` degrades fields Zod can't express in JSON Schema
 * (e.g. `z.date()`, `z.custom()`) to `{}` instead of throwing, so one
 * exotic field doesn't prevent extracting defaults for the rest of the
 * schema.
 */
function extractConfigDefaults(
  configSchema: z.ZodTypeAny,
): Record<string, unknown> {
  if (!(configSchema instanceof z.ZodObject)) {
    return {};
  }

  try {
    const jsonSchema = z.toJSONSchema(configSchema, {
      unrepresentable: "any",
    });

    const defaults: Record<string, unknown> = {};
    for (const [key, fieldSchema] of Object.entries(
      jsonSchema.properties ?? {},
    )) {
      if (
        typeof fieldSchema === "object" &&
        fieldSchema !== null &&
        "default" in fieldSchema
      ) {
        defaults[key] = fieldSchema.default;
      }
    }
    return defaults;
  } catch {
    // A field's schema couldn't be represented even with
    // `unrepresentable: "any"` (e.g. a bigint default) — skip defaults for
    // this stage rather than failing getStageConfigs() for every stage.
    return {};
  }
}

// ============================================================================
// Workflow - Complete workflow definition
// ============================================================================

/** Options carried from the builder onto a built {@link Workflow}. */
export interface WorkflowDefinitionOptions {
  /**
   * An explicit definition version, declared with
   * `defineWorkflow(...).version("2")`. When set it replaces the derived
   * structural hash, so the pipeline's compatibility contract becomes
   * whatever the author says it is. The engine still records the derived
   * structure alongside it and refuses to re-register the same explicit
   * version with a different structure.
   */
  readonly version?: string;
}

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
    private readonly options?: WorkflowDefinitionOptions,
  ) {}

  private cachedSnapshot?: DefinitionSnapshot;
  private cachedVersion?: string;

  /**
   * The structural contract this definition presents to runs pinned to it:
   * stage ids, execution groups, definition order, dependencies, modes and
   * the normalised JSON Schema of every schema involved. See
   * `core/definition-version.ts` for what is deliberately excluded.
   */
  getDefinitionSnapshot(): DefinitionSnapshot {
    if (!this.cachedSnapshot) {
      this.cachedSnapshot = buildDefinitionSnapshot(this);
    }
    return this.cachedSnapshot;
  }

  /**
   * The version a run created against this definition is pinned to.
   *
   * Derived from {@link getDefinitionSnapshot} unless the builder declared
   * one with `.version(...)`, in which case that string is used verbatim
   * (Conductor-style manual versioning). Editing a stage body, a stage
   * name or a comment does not change a derived version; adding,
   * removing, reordering or re-typing a stage does.
   */
  get definitionVersion(): string {
    if (this.options?.version !== undefined) return this.options.version;
    if (this.cachedVersion === undefined) {
      this.cachedVersion = computeDefinitionVersion(this);
    }
    return this.cachedVersion;
  }

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

      configs[stage.id] = {
        schema: stage.configSchema,
        defaults: extractConfigDefaults(stage.configSchema),
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
// Builder-first stage definitions
// ============================================================================

/**
 * Resolve the input schema type for a `"none"` input the same way
 * `defineStage` does.
 */
type ResolveInput<TInput extends z.ZodTypeAny | "none"> = TInput extends "none"
  ? typeof NoInputSchema
  : TInput;

/**
 * Evaluates to `unknown` (the identity for intersection) when `TId` is not
 * yet a stage id in `TContext`, and to `never` when it is — so
 * `id: TId & UniqueStageId<TId, TContext>` rejects a duplicate id at the
 * call site while still letting TypeScript infer `TId` as a literal.
 */
type UniqueStageId<
  TId extends string,
  TContext extends Record<string, unknown>,
> = TId extends keyof TContext ? never : unknown;

/** The keys of `T` that are not optional. */
type RequiredContextKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * Guard for the prebuilt-stage overloads (`.stage(prebuilt)` / `.pipe()`):
 * a stage that declares a context must only require keys earlier stages
 * already produce, with assignable values. Intersected with the parameter
 * type the same way {@link UniqueStageId} is, so a mismatch shows up as a
 * missing `__error` property naming the problem instead of a type error
 * deep inside the stage's own generics.
 *
 * A stage built without an explicit `TContext` has the open
 * `Record<string, unknown>` and is accepted anywhere, as before.
 */
type StageContextSatisfied<
  TStageContext extends Record<string, unknown>,
  TContext extends Record<string, unknown>,
> = string extends keyof TStageContext
  ? unknown
  : keyof TStageContext extends never
    ? unknown
    : [Exclude<RequiredContextKeys<TStageContext>, keyof TContext>] extends [
          never,
        ]
      ? TContext extends TStageContext
        ? unknown
        : {
            __error: "stage requires context values that earlier stages do not produce with a compatible type";
          }
      : {
          __error: `stage requires context keys not produced by earlier stages: ${Exclude<
            RequiredContextKeys<TStageContext>,
            keyof TContext
          > &
            string}`;
        };

/**
 * Fields the builder supplies or constrains on top of `defineStage`'s
 * definition shape: `id` comes from the first argument, `name` defaults to
 * the id, and `dependencies` may only name stages already in the workflow.
 */
interface BuilderStageMeta<TContext extends Record<string, unknown>> {
  /** Human-readable name. Defaults to the stage id. */
  name?: string;
  /** Stage ids this stage depends on. Only earlier stage ids are accepted. */
  dependencies?: Array<keyof TContext & string>;
}

/**
 * A stage definition as accepted by {@link WorkflowBuilder.stage}: the same
 * shape `defineStage` takes (sync or async-batch), minus `id`, with `name`
 * optional, `dependencies` restricted to earlier stage ids, and `TContext`
 * fixed to the context accumulated so far — so `ctx.require()` and
 * `ctx.optional()` are typed without a cast.
 */
export type BuilderStageDefinition<
  TId extends string,
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown>,
> =
  | (Omit<
      SyncStageDefinition<TInput, TOutput, TConfig, TContext, TId>,
      "id" | "name" | "dependencies"
    > &
      BuilderStageMeta<TContext>)
  | (Omit<
      AsyncBatchStageDefinition<TInput, TOutput, TConfig, TContext, TId>,
      "id" | "name" | "dependencies"
    > &
      BuilderStageMeta<TContext>);

function buildInlineStage<
  TId extends string,
  TInput extends z.ZodTypeAny | "none",
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
  TContext extends Record<string, unknown>,
>(
  id: TId,
  definition: BuilderStageDefinition<TId, TInput, TOutput, TConfig, TContext>,
): Stage<ResolveInput<TInput>, TOutput, TConfig, TContext, TId> {
  const full = {
    ...definition,
    id,
    name: definition.name ?? id,
    dependencies: definition.dependencies as string[] | undefined,
  } as
    | SyncStageDefinition<TInput, TOutput, TConfig, TContext, TId>
    | AsyncBatchStageDefinition<TInput, TOutput, TConfig, TContext, TId>;
  return defineStage<TContext>()(full);
}

function isStage(value: unknown): value is Stage<any, any, any, any, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    "outputSchema" in value &&
    "execute" in value
  );
}

/**
 * Collects the members of one parallel execution group. Obtained through
 * {@link WorkflowBuilder.parallel}'s callback form; every member sees the
 * context accumulated *before* the group (members cannot depend on each
 * other), and all member outputs become available after it.
 */
export class ParallelGroupBuilder<
  TContext extends Record<string, unknown>,
  TSchemas extends Record<string, z.ZodTypeAny> = {},
> {
  /** @internal */
  readonly members: Stage<any, any, any, any, string>[] = [];

  /**
   * Add an inline stage definition to the group. Same shape as
   * {@link WorkflowBuilder.stage}.
   */
  stage<
    TId extends string,
    TInput extends z.ZodTypeAny | "none",
    TOutput extends z.ZodTypeAny,
    TConfig extends z.ZodTypeAny,
  >(
    id: TId & UniqueStageId<TId, TContext & TSchemas>,
    definition: BuilderStageDefinition<TId, TInput, TOutput, TConfig, TContext>,
  ): ParallelGroupBuilder<TContext, TSchemas & { [K in TId]: TOutput }>;
  /** Add a stage built with `defineStage` to the group. */
  stage<
    TStageInput extends z.ZodTypeAny,
    TStageOutput extends z.ZodTypeAny,
    TStageConfig extends z.ZodTypeAny,
    TStageContext extends Record<string, unknown>,
    TStageId extends string,
  >(
    stage: Stage<
      TStageInput,
      TStageOutput,
      TStageConfig,
      TStageContext,
      TStageId
    > &
      UniqueStageId<TStageId, TContext & TSchemas>,
  ): ParallelGroupBuilder<
    TContext,
    TSchemas & { [K in TStageId]: TStageOutput }
  >;
  stage(
    idOrStage: string | Stage<any, any, any, any, string>,
    definition?: any,
  ) {
    const stage = isStage(idOrStage)
      ? idOrStage
      : buildInlineStage(idOrStage, definition);
    this.members.push(stage);
    return this as unknown as ParallelGroupBuilder<TContext, any>;
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
  private explicitVersion?: string;

  /**
   * Declare an explicit definition version instead of letting the engine
   * derive one from the pipeline's structure.
   *
   * Use this when you want to control forking by hand — a run created
   * after this call is pinned to `version`, and only a host whose build
   * declares the same version claims it. The version must be unique per
   * workflow id: re-registering it with a different structure is rejected
   * at `run.create`.
   *
   * @example
   * ```typescript
   * const workflow = defineWorkflow("invoice")
   *   .pipe(extract)
   *   .pipe(summarise)
   *   .version("2026-09-04.1")
   *   .build();
   * ```
   */
  version(version: string): this {
    if (version.trim().length === 0) {
      throw new Error(
        `Workflow "${this.id}": an explicit definition version must not be empty.`,
      );
    }
    this.explicitVersion = version;
    return this;
  }

  /**
   * Low-level constructor. Prefer {@link defineWorkflow}, which takes the
   * same values by name and defaults the ones that are optional.
   *
   * @param id - Workflow ID
   * @param name - Human-readable name
   * @param description - Human-readable description
   * @param inputSchema - Zod schema for the workflow's input
   * @param currentOutputSchema - Output schema of a zero-stage workflow. It
   *   is replaced by the last stage's `outputSchema` as soon as one is added.
   */
  constructor(
    private id: string,
    private name: string,
    private description: string,
    private inputSchema: TInput,
    private currentOutputSchema: TCurrentOutput,
  ) {}

  private assertUniqueStageId(stageId: string): void {
    if (this.stages.some((node) => node.stage.id === stageId)) {
      throw new Error(
        `Stage "${stageId}" is already in workflow "${this.id}". Stage ids must be unique.`,
      );
    }
  }

  private assertDependencies(
    stage: { id: string; dependencies?: string[] },
    where: string,
  ): void {
    if (!stage.dependencies) return;
    const existingStageIds = this.stages.map((s) => s.stage.id);
    const missingDeps = stage.dependencies.filter(
      (dep) => !existingStageIds.includes(dep),
    );
    if (missingDeps.length > 0) {
      throw new Error(
        `Stage "${stage.id}"${where} has missing dependencies: ${missingDeps.join(", ")}. ` +
          `These stages must be added to the workflow before ${
            where ? "this parallel group" : `"${stage.id}"`
          }. ` +
          `Current stages: ${
            existingStageIds.length === 0
              ? "(none)"
              : existingStageIds.join(", ")
          }`,
      );
    }
  }

  /**
   * Define and add a stage in one call.
   *
   * The definition is the same shape `defineStage` accepts (sync or
   * async-batch), but its `TContext` is the context accumulated by the
   * builder so far: `ctx.require("earlier-stage")` returns that stage's
   * output type, and `dependencies` only accepts earlier stage ids. Reusing
   * an id already in the workflow is a type error.
   *
   * @example
   * ```typescript
   * const workflow = defineWorkflow("repository")
   *   .stage("chapter-index", {
   *     schemas: { input: In, output: ChapterIndex, config: z.object({}) },
   *     async execute(ctx) { return { output: { chapters: [] } }; },
   *   })
   *   .stage("unified-extract", {
   *     dependencies: ["chapter-index"],
   *     schemas: { input: "none", output: Extract, config: z.object({}) },
   *     async execute(ctx) {
   *       const idx = ctx.require("chapter-index"); // typed
   *       return { output: { count: idx.chapters.length } };
   *     },
   *   })
   *   .build();
   * ```
   */
  stage<
    TId extends string,
    TStageInput extends z.ZodTypeAny | "none",
    TStageOutput extends z.ZodTypeAny,
    TStageConfig extends z.ZodTypeAny,
  >(
    id: TId & UniqueStageId<TId, TContext>,
    definition: BuilderStageDefinition<
      TId,
      TStageInput,
      TStageOutput,
      TStageConfig,
      TContext
    >,
  ): WorkflowBuilder<
    TInput,
    TStageOutput,
    TContext & { [K in TId]: z.infer<TStageOutput> }
  >;
  /**
   * Add a stage built with `defineStage`. Its id and output type are read
   * from the stage's generics, exactly like {@link WorkflowBuilder.pipe},
   * plus a duplicate-id check.
   */
  stage<
    TStageInput extends z.ZodTypeAny,
    TStageOutput extends z.ZodTypeAny,
    TStageConfig extends z.ZodTypeAny,
    TStageContext extends Record<string, unknown>,
    TStageId extends string,
  >(
    stage: Stage<
      TStageInput,
      TStageOutput,
      TStageConfig,
      TStageContext,
      TStageId
    > &
      UniqueStageId<TStageId, TContext> &
      StageContextSatisfied<TStageContext, TContext>,
  ): WorkflowBuilder<
    TInput,
    TStageOutput,
    TContext & { [K in TStageId]: z.infer<TStageOutput> }
  >;
  stage(
    idOrStage: string | Stage<any, any, any, any, string>,
    definition?: any,
  ): WorkflowBuilder<TInput, any, any> {
    const stage = isStage(idOrStage)
      ? idOrStage
      : buildInlineStage(idOrStage, definition);
    this.assertUniqueStageId(stage.id);
    return this.pipe(stage);
  }

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
    TStageId extends string = string,
  >(
    stage: Stage<
      TStageInput,
      TStageOutput,
      TStageConfig,
      TStageContext,
      TStageId
    > &
      StageContextSatisfied<TStageContext, TContext>,
  ): WorkflowBuilder<
    TInput,
    TStageOutput,
    TContext & { [K in TStageId]: z.infer<TStageOutput> }
  > {
    this.assertDependencies(stage, "");

    this.currentExecutionGroup++;

    this.stages.push({
      stage: stage as Stage<any, any, any, any>,
      executionGroup: this.currentExecutionGroup,
    });

    // Return builder with new output type and accumulated context
    const builder = this as unknown as WorkflowBuilder<
      TInput,
      TStageOutput,
      TContext & { [K in TStageId]: z.infer<TStageOutput> }
    >;
    (builder as any).currentOutputSchema = stage.outputSchema;

    return builder;
  }

  /**
   * Add multiple stages that execute in parallel.
   *
   * Two forms:
   *
   * - `parallel([stageA, stageB])` — stages built with `defineStage`.
   * - `parallel((group) => group.stage("a", {...}).stage("b", {...}))` —
   *   inline definitions with the same typed context as
   *   {@link WorkflowBuilder.stage}. Members see the context accumulated
   *   *before* the group.
   *
   * All stages receive the same input (current output). Their outputs are
   * merged into an object keyed by stage ID, which becomes the current
   * output, and each output is accumulated in the context under its id.
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
    MergeParallelOutputSchema<TStages>,
    TContext & MergeParallelContext<TStages>
  >;
  parallel<TSchemas extends Record<string, z.ZodTypeAny>>(
    build: (
      group: ParallelGroupBuilder<TContext, {}>,
    ) => ParallelGroupBuilder<TContext, TSchemas>,
  ): WorkflowBuilder<
    TInput,
    z.ZodObject<TSchemas>,
    TContext & { [K in keyof TSchemas]: z.infer<TSchemas[K]> }
  >;
  parallel(
    stagesOrBuild:
      | { id: string; outputSchema: z.ZodTypeAny; dependencies?: string[] }[]
      | ((
          group: ParallelGroupBuilder<TContext, {}>,
        ) => ParallelGroupBuilder<TContext, any>),
  ): WorkflowBuilder<TInput, any, any> {
    const stages =
      typeof stagesOrBuild === "function"
        ? stagesOrBuild(new ParallelGroupBuilder<TContext>()).members
        : stagesOrBuild;

    if (typeof stagesOrBuild === "function") {
      const seen = new Set<string>();
      for (const stage of stages) {
        this.assertUniqueStageId(stage.id);
        if (seen.has(stage.id)) {
          throw new Error(
            `Stage "${stage.id}" appears twice in one parallel group. Stage ids must be unique.`,
          );
        }
        seen.add(stage.id);
      }
    }

    // Validate dependencies for all parallel stages
    for (const stage of stages) {
      this.assertDependencies(stage, " (in parallel group)");
    }

    this.currentExecutionGroup++;

    // Add all stages to same execution group
    for (const stage of stages) {
      this.stages.push({
        stage: stage as Stage<any, any, any, any>,
        executionGroup: this.currentExecutionGroup,
      });
    }

    // Create merged output schema keyed by stage ID
    const mergedSchema = z.object(
      stages.reduce(
        (acc, stage) => {
          acc[stage.id] = stage.outputSchema;
          return acc;
        },
        {} as Record<string, z.ZodTypeAny>,
      ),
    );

    const builder = this as unknown as WorkflowBuilder<TInput, any, any>;
    (builder as any).currentOutputSchema = mergedSchema;

    return builder;
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
      undefined as TContext | undefined,
      this.explicitVersion !== undefined
        ? { version: this.explicitVersion }
        : undefined,
    );
  }
}

// ============================================================================
// defineWorkflow
// ============================================================================

/**
 * Options accepted by {@link defineWorkflow}'s object form.
 */
export interface DefineWorkflowOptions<TInput extends z.ZodTypeAny> {
  id: string;
  name: string;
  description?: string;
  input: TInput;
}

/**
 * Options accepted by {@link defineWorkflow}'s `(id, options?)` form.
 */
export interface WorkflowOptions<TInput extends z.ZodTypeAny> {
  /** Human-readable name. Defaults to the id. */
  name?: string;
  description?: string;
  /** Zod schema for the workflow's input. Defaults to `z.unknown()`. */
  input?: TInput;
}

/**
 * Create a {@link WorkflowBuilder}.
 *
 * The workflow's output schema is always the last stage's `outputSchema`
 * (or the merged object of the last parallel group); there is no separate
 * output option.
 *
 * @example
 * ```typescript
 * // id + options
 * const workflow = defineWorkflow("my-workflow", { input: InputSchema })
 *   .stage("first", { schemas: { ... }, execute })
 *   .build();
 *
 * // options object
 * const workflow = defineWorkflow({
 *   id: "my-workflow",
 *   name: "My Workflow",
 *   input: InputSchema,
 * })
 *   .pipe(stage1)
 *   .pipe(stage2)
 *   .build();
 * ```
 */
export function defineWorkflow<TInput extends z.ZodTypeAny = z.ZodUnknown>(
  id: string,
  options?: WorkflowOptions<TInput>,
): WorkflowBuilder<TInput, TInput>;
export function defineWorkflow<TInput extends z.ZodTypeAny>(
  options: DefineWorkflowOptions<TInput>,
): WorkflowBuilder<TInput, TInput>;
export function defineWorkflow(
  idOrOptions: string | DefineWorkflowOptions<z.ZodTypeAny>,
  options: WorkflowOptions<z.ZodTypeAny> = {},
): WorkflowBuilder<z.ZodTypeAny, z.ZodTypeAny> {
  if (typeof idOrOptions === "string") {
    const input = options.input ?? z.unknown();
    return new WorkflowBuilder(
      idOrOptions,
      options.name ?? idOrOptions,
      options.description ?? "",
      input,
      input,
    );
  }
  return new WorkflowBuilder(
    idOrOptions.id,
    idOrOptions.name,
    idOrOptions.description ?? "",
    idOrOptions.input,
    idOrOptions.input,
  );
}

// ============================================================================
// Type Inference Utilities (Supplementary to Code Generator)
// ============================================================================

/**
 * These inference utilities are useful for:
 * - Deriving a workflow's context type without hand-writing it
 * - Dynamic workflows where the context shape isn't known ahead of time
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
 *   "my-stage-id",
 *   "none",
 *   typeof OutputSchema,
 *   typeof ConfigSchema,
 *   MyWorkflowContext
 * >({ ... });
 * ```
 */
export type InferWorkflowContext<W> =
  W extends Workflow<any, any, infer C> ? C : never;

/**
 * Extract the input type from a Workflow instance
 *
 * @example
 * ```typescript
 * type Input = InferWorkflowInput<typeof myWorkflow>;
 * ```
 */
export type InferWorkflowInput<W> =
  W extends Workflow<infer I, any, any> ? z.infer<I> : never;

/**
 * Extract the output type from a Workflow instance
 *
 * @example
 * ```typescript
 * type Output = InferWorkflowOutput<typeof myWorkflow>;
 * ```
 */
export type InferWorkflowOutput<W> =
  W extends Workflow<any, infer O, any> ? z.infer<O> : never;

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
export type InferWorkflowStageIds<W> =
  W extends Workflow<any, any, infer C> ? keyof C & string : never;

/**
 * Get the output type for a specific stage ID from a Workflow
 *
 * @example
 * ```typescript
 * type DataOutput = InferStageOutputById<typeof workflow, "data-extraction">;
 * ```
 */
export type InferStageOutputById<W, K extends string> =
  W extends Workflow<any, any, infer C>
    ? K extends keyof C
      ? C[K]
      : never
    : never;
