/**
 * Config Presets Tests
 *
 * Tests for config preset schemas and combinator functions.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AIConfigSchema,
  ConcurrencyConfigSchema,
  DebugConfigSchema,
  EmptyConfigSchema,
  FeatureFlagsConfigSchema,
  MinimalAIConfigSchema,
  withAIConfig,
  withConcurrency,
  withDebug,
  withFeatureFlags,
  withFullConfig,
  withStandardConfig,
} from "../../core/config-presets.js";

describe("I want to use config presets for my stages", () => {
  describe("AIConfigSchema", () => {
    it("should provide defaults", () => {
      // Given: Empty input
      // When: I parse
      const result = AIConfigSchema.parse({});

      // Then: Defaults are applied
      expect(result.model).toBe("gemini-2.5-flash");
      expect(result.temperature).toBe(0.7);
      expect(result.maxTokens).toBeUndefined();
    });

    it("should accept custom values", () => {
      // Given: Custom config (using valid model from registry)
      const input = {
        model: "gemini-2.5-flash", // Only valid model in default registry
        temperature: 0.3,
        maxTokens: 1000,
      };

      // When: I parse
      const result = AIConfigSchema.parse(input);

      // Then: Custom values are used
      expect(result.model).toBe("gemini-2.5-flash");
      expect(result.temperature).toBe(0.3);
      expect(result.maxTokens).toBe(1000);
    });

    it("should validate temperature range", () => {
      // When/Then: Temperature below 0 fails
      expect(() => AIConfigSchema.parse({ temperature: -1 })).toThrow();

      // When/Then: Temperature above 2 fails
      expect(() => AIConfigSchema.parse({ temperature: 3 })).toThrow();

      // Edge cases should pass
      expect(AIConfigSchema.parse({ temperature: 0 }).temperature).toBe(0);
      expect(AIConfigSchema.parse({ temperature: 2 }).temperature).toBe(2);
    });

    it("should validate maxTokens is positive", () => {
      // When/Then: Zero or negative maxTokens fails
      expect(() => AIConfigSchema.parse({ maxTokens: 0 })).toThrow();
      expect(() => AIConfigSchema.parse({ maxTokens: -100 })).toThrow();

      // Positive passes
      expect(AIConfigSchema.parse({ maxTokens: 100 }).maxTokens).toBe(100);
    });
  });

  describe("ConcurrencyConfigSchema", () => {
    it("should provide defaults", () => {
      // When: I parse empty input
      const result = ConcurrencyConfigSchema.parse({});

      // Then: Defaults are applied
      expect(result.concurrency).toBe(5);
      expect(result.delayMs).toBe(0);
      expect(result.maxRetries).toBe(3);
    });

    it("should accept custom values", () => {
      // Given: Custom config
      const input = {
        concurrency: 10,
        delayMs: 100,
        maxRetries: 5,
      };

      // When: I parse
      const result = ConcurrencyConfigSchema.parse(input);

      // Then: Custom values are used
      expect(result.concurrency).toBe(10);
      expect(result.delayMs).toBe(100);
      expect(result.maxRetries).toBe(5);
    });

    it("should validate concurrency is positive", () => {
      // When/Then: Zero or negative concurrency fails
      expect(() => ConcurrencyConfigSchema.parse({ concurrency: 0 })).toThrow();
      expect(() =>
        ConcurrencyConfigSchema.parse({ concurrency: -5 }),
      ).toThrow();
    });

    it("should validate delayMs is non-negative", () => {
      // When/Then: Negative delayMs fails
      expect(() => ConcurrencyConfigSchema.parse({ delayMs: -1 })).toThrow();

      // Zero is allowed
      expect(ConcurrencyConfigSchema.parse({ delayMs: 0 }).delayMs).toBe(0);
    });
  });

  describe("FeatureFlagsConfigSchema", () => {
    it("should provide empty default", () => {
      // When: I parse empty input
      const result = FeatureFlagsConfigSchema.parse({});

      // Then: Default is empty object
      expect(result.featureFlags).toEqual({});
    });

    it("should accept feature flags", () => {
      // Given: Feature flags
      const input = {
        featureFlags: {
          newFeature: true,
          oldFeature: false,
          experimentalMode: true,
        },
      };

      // When: I parse
      const result = FeatureFlagsConfigSchema.parse(input);

      // Then: Feature flags are set
      expect(result.featureFlags).toEqual({
        newFeature: true,
        oldFeature: false,
        experimentalMode: true,
      });
    });
  });

  describe("DebugConfigSchema", () => {
    it("should provide defaults", () => {
      // When: I parse empty input
      const result = DebugConfigSchema.parse({});

      // Then: Defaults are false
      expect(result.verbose).toBe(false);
      expect(result.dryRun).toBe(false);
    });

    it("should accept custom values", () => {
      // Given: Debug enabled
      const input = {
        verbose: true,
        dryRun: true,
      };

      // When: I parse
      const result = DebugConfigSchema.parse(input);

      // Then: Values are set
      expect(result.verbose).toBe(true);
      expect(result.dryRun).toBe(true);
    });
  });

  describe("withAIConfig", () => {
    it("should merge AI config with custom schema", () => {
      // Given: A custom schema
      const customSchema = z.object({
        customField: z.string(),
        customNumber: z.number().default(42),
      });

      // When: I apply withAIConfig
      const merged = withAIConfig(customSchema);

      // Then: Merged schema has all fields
      const result = merged.parse({ customField: "test" });
      expect(result.customField).toBe("test");
      expect(result.customNumber).toBe(42);
      expect(result.model).toBe("gemini-2.5-flash");
      expect(result.temperature).toBe(0.7);
    });

    it("should allow overriding AI defaults", () => {
      // Given: A merged schema
      const merged = withAIConfig(z.object({ name: z.string() }));

      // When: I parse with custom AI values (using valid model)
      const result = merged.parse({
        name: "test",
        model: "gemini-2.5-flash", // Only valid model in default registry
        temperature: 0.5,
      });

      // Then: Custom values are used
      expect(result.model).toBe("gemini-2.5-flash");
      expect(result.temperature).toBe(0.5);
    });
  });

  describe("withConcurrency", () => {
    it("should merge concurrency config with custom schema", () => {
      // Given: A custom schema
      const customSchema = z.object({
        items: z.array(z.string()),
      });

      // When: I apply withConcurrency
      const merged = withConcurrency(customSchema);

      // Then: Merged schema has all fields
      const result = merged.parse({ items: ["a", "b"] });
      expect(result.items).toEqual(["a", "b"]);
      expect(result.concurrency).toBe(5);
      expect(result.delayMs).toBe(0);
      expect(result.maxRetries).toBe(3);
    });
  });

  describe("withFeatureFlags", () => {
    it("should merge feature flags with custom schema", () => {
      // Given: A custom schema
      const customSchema = z.object({
        setting: z.boolean(),
      });

      // When: I apply withFeatureFlags
      const merged = withFeatureFlags(customSchema);

      // Then: Merged schema has all fields
      const result = merged.parse({
        setting: true,
        featureFlags: { beta: true },
      });
      expect(result.setting).toBe(true);
      expect(result.featureFlags).toEqual({ beta: true });
    });
  });

  describe("withDebug", () => {
    it("should merge debug config with custom schema", () => {
      // Given: A custom schema
      const customSchema = z.object({
        processType: z.string(),
      });

      // When: I apply withDebug
      const merged = withDebug(customSchema);

      // Then: Merged schema has all fields
      const result = merged.parse({ processType: "analysis", verbose: true });
      expect(result.processType).toBe("analysis");
      expect(result.verbose).toBe(true);
      expect(result.dryRun).toBe(false);
    });
  });

  describe("withStandardConfig", () => {
    it("should combine AI + Concurrency + FeatureFlags", () => {
      // Given: A custom schema
      const customSchema = z.object({
        customOption: z.boolean().default(true),
      });

      // When: I apply withStandardConfig
      const merged = withStandardConfig(customSchema);

      // Then: Has all standard config fields
      const result = merged.parse({});
      expect(result.customOption).toBe(true);
      // AI config
      expect(result.model).toBe("gemini-2.5-flash");
      expect(result.temperature).toBe(0.7);
      // Concurrency config
      expect(result.concurrency).toBe(5);
      expect(result.delayMs).toBe(0);
      expect(result.maxRetries).toBe(3);
      // Feature flags
      expect(result.featureFlags).toEqual({});
    });
  });

  describe("withFullConfig", () => {
    it("should combine all config types", () => {
      // Given: A custom schema
      const customSchema = z.object({
        specificField: z.number().default(100),
      });

      // When: I apply withFullConfig
      const merged = withFullConfig(customSchema);

      // Then: Has all config fields
      const result = merged.parse({ verbose: true });
      // Custom
      expect(result.specificField).toBe(100);
      // AI config
      expect(result.model).toBe("gemini-2.5-flash");
      // Concurrency config
      expect(result.concurrency).toBe(5);
      // Feature flags
      expect(result.featureFlags).toEqual({});
      // Debug config
      expect(result.verbose).toBe(true);
      expect(result.dryRun).toBe(false);
    });
  });

  describe("EmptyConfigSchema", () => {
    it("should parse empty object", () => {
      // When: I parse empty input
      const result = EmptyConfigSchema.parse({});

      // Then: Returns empty object
      expect(result).toEqual({});
    });
  });

  describe("MinimalAIConfigSchema", () => {
    it("should have only model and temperature", () => {
      // When: I parse empty input
      const result = MinimalAIConfigSchema.parse({});

      // Then: Has model and temperature, but not maxTokens
      expect(result.model).toBe("gemini-2.5-flash");
      expect(result.temperature).toBe(0.7);
      expect(Object.keys(result)).toEqual(["model", "temperature"]);
    });
  });

  describe("chaining combinators", () => {
    it("should support chaining multiple combinators", () => {
      // Given: A custom schema with multiple combinators
      const customSchema = z.object({
        myField: z.string(),
      });

      // When: I chain combinators manually
      const merged = customSchema
        .merge(AIConfigSchema)
        .merge(DebugConfigSchema);

      // Then: Has fields from both
      const result = merged.parse({ myField: "test" });
      expect(result.myField).toBe("test");
      expect(result.model).toBe("gemini-2.5-flash");
      expect(result.verbose).toBe(false);
    });
  });
});
