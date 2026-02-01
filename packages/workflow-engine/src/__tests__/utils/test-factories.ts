/**
 * Test Factories
 *
 * Utilities for quickly creating test stages and workflows.
 * These factories reduce boilerplate in tests while maintaining full type safety.
 */

import { z } from "zod";
import {
  defineStage,
  defineAsyncBatchStage,
} from "../../core/stage-factory.js";
import { WorkflowBuilder, Workflow } from "../../core/workflow.js";
import type { Stage } from "../../core/stage.js";
import type {
  SimpleStageResult,
  SimpleSuspendedResult,
} from "../../core/stage-factory.js";
import type { CompletionCheckResult } from "../../core/types.js";

// ============================================================================
// Simple Stage Factories
// ============================================================================

/**
 * Create a simple passthrough stage that echoes its input
 */
export function createPassthroughStage<T extends z.ZodTypeAny>(
  id: string,
  schema: T,
  options?: {
    name?: string;
    description?: string;
    dependencies?: string[];
  },
) {
  return defineStage({
    id,
    name: options?.name ?? `Stage ${id}`,
    description: options?.description,
    dependencies: options?.dependencies,
    schemas: {
      input: schema,
      output: schema,
      config: z.object({}),
    },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
}

/**
 * Create a stage that transforms its input
 */
export function createTransformStage<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(
  id: string,
  inputSchema: TInput,
  outputSchema: TOutput,
  transform: (input: z.infer<TInput>) => z.infer<TOutput>,
  options?: {
    name?: string;
    description?: string;
    dependencies?: string[];
  },
) {
  return defineStage({
    id,
    name: options?.name ?? `Stage ${id}`,
    description: options?.description,
    dependencies: options?.dependencies,
    schemas: {
      input: inputSchema,
      output: outputSchema,
      config: z.object({}),
    },
    async execute(ctx) {
      return { output: transform(ctx.input) };
    },
  });
}

/**
 * Create a stage that returns a fixed output
 */
export function createFixedOutputStage<TOutput extends z.ZodTypeAny>(
  id: string,
  outputSchema: TOutput,
  output: z.infer<TOutput>,
  options?: {
    name?: string;
    description?: string;
    dependencies?: string[];
  },
) {
  return defineStage({
    id,
    name: options?.name ?? `Stage ${id}`,
    description: options?.description,
    dependencies: options?.dependencies,
    schemas: {
      input: "none",
      output: outputSchema,
      config: z.object({}),
    },
    async execute() {
      return { output };
    },
  });
}

/**
 * Create a stage that tracks execution for testing
 */
export function createTrackingStage<T extends z.ZodTypeAny>(
  id: string,
  schema: T,
  tracker: {
    executions: Array<{
      stageId: string;
      input: unknown;
      timestamp: number;
    }>;
  },
  options?: {
    name?: string;
    description?: string;
    dependencies?: string[];
    delayMs?: number;
  },
) {
  return defineStage({
    id,
    name: options?.name ?? `Stage ${id}`,
    description: options?.description,
    dependencies: options?.dependencies,
    schemas: {
      input: schema,
      output: schema,
      config: z.object({}),
    },
    async execute(ctx) {
      tracker.executions.push({
        stageId: id,
        input: ctx.input,
        timestamp: Date.now(),
      });

      if (options?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }

      return { output: ctx.input };
    },
  });
}

/**
 * Create a stage that throws an error
 */
export function createErrorStage(
  id: string,
  errorMessage: string,
  options?: {
    name?: string;
    description?: string;
    dependencies?: string[];
  },
) {
  return defineStage({
    id,
    name: options?.name ?? `Stage ${id}`,
    description: options?.description,
    dependencies: options?.dependencies,
    schemas: {
      input: z.object({}).passthrough(),
      output: z.object({}),
      config: z.object({}),
    },
    async execute() {
      throw new Error(errorMessage);
    },
  });
}

/**
 * Create a stage with configurable behavior
 */
export function createConfigurableStage<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
  TConfig extends z.ZodTypeAny,
>(
  id: string,
  schemas: {
    input: TInput;
    output: TOutput;
    config: TConfig;
  },
  execute: (
    input: z.infer<TInput>,
    config: z.infer<TConfig>,
  ) => Promise<z.infer<TOutput>>,
  options?: {
    name?: string;
    description?: string;
    dependencies?: string[];
  },
) {
  return defineStage({
    id,
    name: options?.name ?? `Stage ${id}`,
    description: options?.description,
    dependencies: options?.dependencies,
    schemas,
    async execute(ctx) {
      const result = await execute(ctx.input, ctx.config);
      return { output: result };
    },
  });
}

// ============================================================================
// Async-Batch Stage Factories
// ============================================================================

/**
 * Create an async-batch stage that suspends then completes
 */
export function createSuspendingStage<TOutput extends z.ZodTypeAny>(
  id: string,
  outputSchema: TOutput,
  options: {
    name?: string;
    description?: string;
    dependencies?: string[];
    batchId?: string;
    pollInterval?: number;
    maxWaitTime?: number;
    /** Called when resuming to get the final output */
    getOutput: () => z.infer<TOutput>;
    /** Called to check if batch is complete */
    isComplete?: () => boolean;
  },
) {
  const batchId = options.batchId ?? `batch-${id}`;
  let completionCount = 0;

  return defineAsyncBatchStage({
    id,
    name: options.name ?? `Stage ${id}`,
    description: options.description,
    dependencies: options.dependencies,
    mode: "async-batch",
    schemas: {
      input: z.object({}).passthrough(),
      output: outputSchema,
      config: z.object({}),
    },
    async execute(ctx) {
      // If resuming, return the output
      if (ctx.resumeState) {
        return { output: options.getOutput() };
      }

      // First run - suspend
      const now = new Date();
      const pollInterval = options.pollInterval ?? 1000;
      const maxWaitTime = options.maxWaitTime ?? 60000;

      return {
        suspended: true,
        state: {
          batchId,
          submittedAt: now.toISOString(),
          pollInterval,
          maxWaitTime,
        },
        pollConfig: {
          pollInterval,
          maxWaitTime,
          nextPollAt: new Date(now.getTime() + pollInterval),
        },
      } as SimpleSuspendedResult;
    },
    async checkCompletion(suspendedState, ctx) {
      completionCount++;
      const isComplete = options.isComplete?.() ?? completionCount > 1;

      if (isComplete) {
        return {
          ready: true,
          output: options.getOutput(),
        };
      }

      return {
        ready: false,
        nextCheckIn: options.pollInterval ?? 1000,
      };
    },
  });
}

/**
 * Create an async-batch stage that fails
 */
export function createFailingSuspendStage(
  id: string,
  options: {
    name?: string;
    description?: string;
    dependencies?: string[];
    errorMessage?: string;
    failAfterChecks?: number;
  },
) {
  let checkCount = 0;
  const failAfter = options.failAfterChecks ?? 1;

  return defineAsyncBatchStage({
    id,
    name: options.name ?? `Stage ${id}`,
    description: options.description,
    dependencies: options.dependencies,
    mode: "async-batch",
    schemas: {
      input: z.object({}).passthrough(),
      output: z.object({}),
      config: z.object({}),
    },
    async execute(ctx) {
      if (ctx.resumeState) {
        throw new Error(options.errorMessage ?? "Batch job failed");
      }

      const now = new Date();
      return {
        suspended: true,
        state: {
          batchId: `batch-${id}`,
          submittedAt: now.toISOString(),
          pollInterval: 1000,
          maxWaitTime: 60000,
        },
        pollConfig: {
          pollInterval: 1000,
          maxWaitTime: 60000,
          nextPollAt: new Date(now.getTime() + 1000),
        },
      } as SimpleSuspendedResult;
    },
    async checkCompletion() {
      checkCount++;
      if (checkCount >= failAfter) {
        return {
          ready: true,
          error: options.errorMessage ?? "Batch job failed",
        };
      }
      return { ready: false, nextCheckIn: 1000 };
    },
  });
}

// ============================================================================
// Workflow Factories
// ============================================================================

/**
 * Create a simple sequential workflow with passthrough stages
 */
export function createSequentialWorkflow(
  id: string,
  stageCount: number,
  options?: {
    name?: string;
    description?: string;
  },
): Workflow<
  z.ZodObject<{ value: z.ZodString }>,
  z.ZodObject<{ value: z.ZodString }>
> {
  const schema = z.object({ value: z.string() });

  let builder = new WorkflowBuilder(
    id,
    options?.name ?? `Workflow ${id}`,
    options?.description ?? "Test workflow",
    schema,
    schema,
  );

  for (let i = 1; i <= stageCount; i++) {
    builder = builder.pipe(
      createPassthroughStage(`stage-${i}`, schema),
    ) as typeof builder;
  }

  return builder.build();
}

/**
 * Create a workflow with a tracker for execution order testing
 */
export function createTrackedWorkflow(
  id: string,
  stageIds: string[],
  tracker: {
    executions: Array<{
      stageId: string;
      input: unknown;
      timestamp: number;
    }>;
  },
  options?: {
    name?: string;
    description?: string;
    stageDelays?: Record<string, number>;
  },
): Workflow<
  z.ZodObject<{ value: z.ZodString }>,
  z.ZodObject<{ value: z.ZodString }>
> {
  const schema = z.object({ value: z.string() });

  let builder = new WorkflowBuilder(
    id,
    options?.name ?? `Workflow ${id}`,
    options?.description ?? "Test workflow",
    schema,
    schema,
  );

  for (const stageId of stageIds) {
    builder = builder.pipe(
      createTrackingStage(stageId, schema, tracker, {
        delayMs: options?.stageDelays?.[stageId],
      }),
    ) as typeof builder;
  }

  return builder.build();
}

// ============================================================================
// Common Test Schemas
// ============================================================================

export const TestSchemas = {
  empty: z.object({}),
  string: z.object({ value: z.string() }),
  number: z.object({ value: z.number() }),
  boolean: z.object({ value: z.boolean() }),
  array: z.object({ items: z.array(z.string()) }),
  nested: z.object({
    data: z.object({
      id: z.string(),
      values: z.array(z.number()),
    }),
  }),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().optional(),
  }),
  document: z.object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    tags: z.array(z.string()).optional(),
  }),
};

// ============================================================================
// Config Schema Factories
// ============================================================================

export const TestConfigSchemas = {
  empty: z.object({}),
  withModel: z.object({
    model: z.string().default("test-model"),
    temperature: z.number().default(0.7),
  }),
  withConcurrency: z.object({
    concurrency: z.number().default(5),
    delayMs: z.number().default(0),
  }),
  full: z.object({
    model: z.string().default("test-model"),
    temperature: z.number().default(0.7),
    concurrency: z.number().default(5),
    delayMs: z.number().default(0),
    maxRetries: z.number().default(3),
    verbose: z.boolean().default(false),
  }),
};
