/**
 * Synchronous Stage Definition Tests
 *
 * Tests for defining and creating synchronous stages using defineStage().
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { StageContext } from "../../core/stage.js";
import { defineStage } from "../../core/stage-factory.js";
import { TestSchemas } from "../utils/index.js";

describe("I want to define synchronous stages", () => {
  describe("basic stage creation", () => {
    it("should create a stage with id, name, and description", () => {
      // Given: defineStage({ id, name, description, ... })
      const stage = defineStage({
        id: "my-stage",
        name: "My Stage",
        description: "This is my stage description",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      // When: I create the stage
      // Then: Stage has correct metadata
      expect(stage.id).toBe("my-stage");
      expect(stage.name).toBe("My Stage");
      expect(stage.description).toBe("This is my stage description");
    });

    it("should require input, output, and config schemas", () => {
      // Given: Schemas for input, output, config
      const inputSchema = z.object({ userId: z.string() });
      const outputSchema = z.object({ user: z.object({ name: z.string() }) });
      const configSchema = z.object({
        maxRetries: z.number().default(3),
      });

      // When: I define a stage
      const stage = defineStage({
        id: "schema-stage",
        name: "Schema Stage",
        schemas: {
          input: inputSchema,
          output: outputSchema,
          config: configSchema,
        },
        async execute(ctx) {
          return { output: { user: { name: `User ${ctx.input.userId}` } } };
        },
      });

      // Then: Schemas are accessible on the stage
      expect(stage.inputSchema).toBeDefined();
      expect(stage.outputSchema).toBeDefined();
      expect(stage.configSchema).toBeDefined();

      // Verify schemas work correctly
      const validInput = { userId: "123" };
      expect(stage.inputSchema.parse(validInput)).toEqual(validInput);

      const validOutput = { user: { name: "Test" } };
      expect(stage.outputSchema.parse(validOutput)).toEqual(validOutput);

      const validConfig = { maxRetries: 5 };
      expect(stage.configSchema.parse(validConfig)).toEqual(validConfig);
    });

    it("should execute and return output", async () => {
      // Given: A stage that transforms input
      const stage = defineStage({
        id: "transform-stage",
        name: "Transform Stage",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ doubled: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { doubled: ctx.input.value * 2 } };
        },
      });

      // When: I execute it with input
      const mockContext: StageContext<
        { value: number },
        Record<string, never>,
        Record<string, unknown>
      > = {
        workflowRunId: "run-1",
        stageRecordId: "stage-record-1",
        stageId: "transform-stage",
        stageName: "Transform Stage",
        stageNumber: 0,
        input: { value: 21 },
        config: {},
        workflowContext: {},
        onProgress: () => {},
        onLog: () => {},
        log: () => {},
        annotate: () => {},
        storage: {
          save: async () => {},
          load: async <T>(): Promise<T> => null as T,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      const result = await stage.execute(mockContext);

      // Then: Returns expected output
      expect("output" in result).toBe(true);
      if ("output" in result) {
        expect(result.output).toEqual({ doubled: 42 });
      }
    });

    it("should have mode set to sync", () => {
      // Given: A stage defined with defineStage (no mode specified)
      const stage = defineStage({
        id: "sync-stage",
        name: "Sync Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      // Then: mode is "sync"
      expect(stage.mode).toBe("sync");
    });
  });

  describe("input schema 'none'", () => {
    it("should allow stages with no direct input", () => {
      // Given: schemas: { input: "none", ... }
      const stage = defineStage({
        id: "no-input-stage",
        name: "No Input Stage",
        schemas: {
          input: "none",
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { result: "computed" } };
        },
      });

      // Then: Stage can be created
      expect(stage).toBeDefined();
      expect(stage.id).toBe("no-input-stage");
    });

    it("should still have access to workflowContext", async () => {
      // Given: Stage with input: "none"
      let capturedContext: Record<string, unknown> | null = null;

      const stage = defineStage({
        id: "context-access-stage",
        name: "Context Access Stage",
        schemas: {
          input: "none",
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          capturedContext = ctx.workflowContext;
          return { output: { result: "done" } };
        },
      });

      // When: Executed with workflowContext populated
      const mockContext: StageContext<
        Record<string, never>,
        Record<string, never>,
        Record<string, unknown>
      > = {
        workflowRunId: "run-1",
        stageRecordId: "stage-record-1",
        stageId: "context-access-stage",
        stageName: "Context Access Stage",
        stageNumber: 0,
        input: {},
        config: {},
        workflowContext: {
          "previous-stage": { someData: "value" },
        },
        onProgress: () => {},
        onLog: () => {},
        log: () => {},
        annotate: () => {},
        storage: {
          save: async () => {},
          load: async <T>(): Promise<T> => null as T,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      await stage.execute(mockContext);

      // Then: Can access previous stage outputs
      expect(capturedContext).toBeDefined();
      expect(capturedContext?.["previous-stage"]).toEqual({
        someData: "value",
      });
    });
  });

  describe("with dependencies", () => {
    it("should declare stage dependencies", () => {
      // Given: dependencies: ["stage-a", "stage-b"]
      const stage = defineStage({
        id: "dependent-stage",
        name: "Dependent Stage",
        dependencies: ["stage-a", "stage-b"],
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      // Then: Stage.dependencies contains those IDs
      expect(stage.dependencies).toBeDefined();
      expect(stage.dependencies).toEqual(["stage-a", "stage-b"]);
    });

    it("should have undefined dependencies when not specified", () => {
      // Given: Stage without dependencies
      const stage = defineStage({
        id: "no-deps-stage",
        name: "No Deps Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      // Then: dependencies is undefined
      expect(stage.dependencies).toBeUndefined();
    });
  });

  describe("cost estimation", () => {
    it("should support optional cost estimation", () => {
      // Given: estimateCost: (input, config) => number
      const stage = defineStage({
        id: "costly-stage",
        name: "Costly Stage",
        schemas: {
          input: z.object({ tokens: z.number() }),
          output: z.object({ result: z.string() }),
          config: z.object({
            pricePerToken: z.number().default(0.001),
          }),
        },
        async execute(ctx) {
          return { output: { result: "done" } };
        },
        estimateCost: (input, config) => {
          return input.tokens * config.pricePerToken;
        },
      });

      // Then: Can estimate cost before execution
      expect(stage.estimateCost).toBeDefined();

      const estimatedCost = stage.estimateCost?.(
        { tokens: 1000 },
        { pricePerToken: 0.002 },
      );
      expect(estimatedCost).toBe(2); // 1000 * 0.002
    });

    it("should have undefined estimateCost when not provided", () => {
      // Given: Stage without cost estimation
      const stage = defineStage({
        id: "free-stage",
        name: "Free Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      // Then: estimateCost is undefined
      expect(stage.estimateCost).toBeUndefined();
    });
  });

  describe("context helpers", () => {
    it("should provide require helper for mandatory dependencies", async () => {
      // Given: Stage that uses ctx.require
      let requiredData: unknown;

      const stage = defineStage({
        id: "require-test",
        name: "Require Test",
        schemas: {
          input: "none",
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          requiredData = ctx.require("previous-stage" as never);
          return { output: { result: "done" } };
        },
      });

      // When: Executed with required stage in context
      const mockContext: StageContext<
        Record<string, never>,
        Record<string, never>,
        Record<string, unknown>
      > = {
        workflowRunId: "run-1",
        stageRecordId: "stage-record-1",
        stageId: "require-test",
        stageName: "Require Test",
        stageNumber: 0,
        input: {},
        config: {},
        workflowContext: {
          "previous-stage": { important: "data" },
        },
        onProgress: () => {},
        onLog: () => {},
        log: () => {},
        annotate: () => {},
        storage: {
          save: async () => {},
          load: async <T>(): Promise<T> => null as T,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      await stage.execute(mockContext);

      // Then: ctx.require returns the data
      expect(requiredData).toEqual({ important: "data" });
    });

    it("should throw helpful error when required stage is missing", async () => {
      // Given: Stage that requires missing dependency
      const stage = defineStage({
        id: "missing-require",
        name: "Missing Require",
        schemas: {
          input: "none",
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.require("nonexistent" as never);
          return { output: { result: "done" } };
        },
      });

      // When: Executed without the required stage
      const mockContext: StageContext<
        Record<string, never>,
        Record<string, never>,
        Record<string, unknown>
      > = {
        workflowRunId: "run-1",
        stageRecordId: "stage-record-1",
        stageId: "missing-require",
        stageName: "Missing Require",
        stageNumber: 0,
        input: {},
        config: {},
        workflowContext: {},
        onProgress: () => {},
        onLog: () => {},
        log: () => {},
        annotate: () => {},
        storage: {
          save: async () => {},
          load: async <T>(): Promise<T> => null as T,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      // Then: Throws with helpful error
      await expect(stage.execute(mockContext)).rejects.toThrow(/nonexistent/);
    });

    it("should provide optional helper for optional dependencies", async () => {
      // Given: Stage that uses ctx.optional
      let optionalData: unknown;

      const stage = defineStage({
        id: "optional-test",
        name: "Optional Test",
        schemas: {
          input: "none",
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          optionalData = ctx.optional("maybe" as never);
          return { output: { result: "done" } };
        },
      });

      // When: Executed without the optional stage
      const mockContext: StageContext<
        Record<string, never>,
        Record<string, never>,
        Record<string, unknown>
      > = {
        workflowRunId: "run-1",
        stageRecordId: "stage-record-1",
        stageId: "optional-test",
        stageName: "Optional Test",
        stageNumber: 0,
        input: {},
        config: {},
        workflowContext: {},
        onProgress: () => {},
        onLog: () => {},
        log: () => {},
        annotate: () => {},
        storage: {
          save: async () => {},
          load: async <T>(): Promise<T> => null as T,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      await stage.execute(mockContext);

      // Then: ctx.optional returns undefined (no throw)
      expect(optionalData).toBeUndefined();
    });
  });

  describe("custom metrics", () => {
    it("should support returning custom metrics", async () => {
      // Given: Stage that returns customMetrics
      const stage = defineStage({
        id: "metrics-stage",
        name: "Metrics Stage",
        schemas: {
          input: z.object({ items: z.array(z.string()) }),
          output: z.object({ processed: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const itemCount = ctx.input.items.length;
          return {
            output: { processed: itemCount },
            customMetrics: {
              itemsProcessed: itemCount,
              avgProcessTime: 50,
            },
          };
        },
      });

      // When: Executed
      const mockContext: StageContext<
        { items: string[] },
        Record<string, never>,
        Record<string, unknown>
      > = {
        workflowRunId: "run-1",
        stageRecordId: "stage-record-1",
        stageId: "metrics-stage",
        stageName: "Metrics Stage",
        stageNumber: 0,
        input: { items: ["a", "b", "c"] },
        config: {},
        workflowContext: {},
        onProgress: () => {},
        onLog: () => {},
        log: () => {},
        annotate: () => {},
        storage: {
          save: async () => {},
          load: async <T>(): Promise<T> => null as T,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      const result = await stage.execute(mockContext);

      // Then: Metrics are included in result
      expect("output" in result).toBe(true);
      if ("output" in result) {
        expect(result.metrics).toBeDefined();
        expect(result.metrics?.itemsProcessed).toBe(3);
        expect(
          (result.metrics as unknown as Record<string, unknown> | undefined)
            ?.avgProcessTime,
        ).toBe(50);
      }
    });
  });

  describe("curried defineStage<TContext>()", () => {
    // The whole point of currying: fix TContext once, and let TId/TInput/
    // TOutput/TConfig all infer from the definition object — no need to
    // spell out all 5 generics positionally (compare to the `defineStage<
    // "process", z.ZodObject<...>, ..., ExtractContext>({...})` pattern
    // used elsewhere, e.g. in 05-data-flow/context-access.test.ts).
    type UpstreamContext = {
      "upstream-stage": { value: string; count: number };
    };

    it("infers TId as a string literal, not widened to `string`", () => {
      // Given: defineStage<TContext>()({ id: "curried-stage", ... })
      const stage = defineStage<UpstreamContext>()({
        id: "curried-stage",
        name: "Curried Stage",
        schemas: {
          input: z.object({}),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { result: "done" } };
        },
      });

      // Then: TId is the literal "curried-stage", not widened to `string`
      // (widening would break WorkflowBuilder's per-stage context keying).
      expectTypeOf(stage.id).toEqualTypeOf<"curried-stage">();
      expectTypeOf(stage.id).not.toEqualTypeOf<string>();
      expect(stage.id).toBe("curried-stage");
    });

    it("types ctx.require() from the supplied TContext generic", async () => {
      // Given: A stage curried with an explicit upstream context type
      let captured: { value: string; count: number } | undefined;

      const stage = defineStage<UpstreamContext>()({
        id: "consumer-stage",
        name: "Consumer Stage",
        schemas: {
          input: z.object({}),
          output: z.object({ echoed: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const upstream = ctx.require("upstream-stage");

          // Then: ctx.require()'s return type comes from UpstreamContext
          // (not `unknown`/`any`) — this is a compile-time-only assertion.
          expectTypeOf(upstream).toEqualTypeOf<{
            value: string;
            count: number;
          }>();

          captured = upstream;
          return { output: { echoed: upstream.value } };
        },
      });

      // When: Executed with the upstream stage's output present
      const mockContext: StageContext<
        Record<string, never>,
        Record<string, never>,
        UpstreamContext
      > = {
        workflowRunId: "run-1",
        stageRecordId: "stage-record-1",
        stageId: "consumer-stage",
        stageName: "Consumer Stage",
        stageNumber: 0,
        input: {},
        config: {},
        workflowContext: { "upstream-stage": { value: "hi", count: 1 } },
        onProgress: () => {},
        onLog: () => {},
        log: () => {},
        annotate: () => {},
        storage: {
          save: async () => {},
          load: async <T>(): Promise<T> => null as T,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      const result = await stage.execute(mockContext);

      // Then: The runtime value matches what the type predicted
      expect(captured).toEqual({ value: "hi", count: 1 });
      expect("output" in result).toBe(true);
      if ("output" in result) {
        expect(result.output).toEqual({ echoed: "hi" });
      }
    });

    it("infers the output type from the output schema", () => {
      // Given: A curried stage with a multi-field output schema
      const stage = defineStage<UpstreamContext>()({
        id: "output-stage",
        name: "Output Stage",
        schemas: {
          input: z.object({}),
          output: z.object({ total: z.number(), label: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { total: 42, label: "answer" } };
        },
      });

      // Then: z.infer<typeof stage.outputSchema> matches the declared shape
      type Output = z.infer<typeof stage.outputSchema>;
      expectTypeOf<Output>().toEqualTypeOf<{
        total: number;
        label: string;
      }>();

      // And: The schema actually validates data of that shape
      expect(stage.outputSchema.parse({ total: 42, label: "answer" })).toEqual({
        total: 42,
        label: "answer",
      });
    });

    it("still works with the default TContext when currying without pinning it", () => {
      // Given: defineStage<TContext>() called with no type argument — the
      // default `Record<string, unknown>` applies, same as calling
      // defineStage({...}) directly.
      const stage = defineStage()({
        id: "no-context-stage",
        name: "No Context Stage",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ doubled: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { doubled: ctx.input.value * 2 } };
        },
      });

      // Then: TId inference and stage construction still work as normal
      expectTypeOf(stage.id).toEqualTypeOf<"no-context-stage">();
      expect(stage.id).toBe("no-context-stage");
      expect(stage.mode).toBe("sync");
    });
  });
});
