/**
 * routing-executor.test.ts
 *
 * Unit tests for createRoutingExecutor. Proves that:
 *  1. Stages whose IDs are in remoteStageIds are routed to the remote executor.
 *  2. All other stages are routed to the local executor.
 *  3. When `local` is omitted, a non-remote stage still runs successfully via
 *     the default LocalExecutor (and the remote spy is NOT called).
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { createRoutingExecutor } from "../../kernel/executor/routing-executor.js";
import type {
  ActivityExecutor,
  ActivityRunInput,
  ActivityRunResult,
  ExecutorDeps,
} from "../../kernel/ports.js";
import { FakeClock, InMemoryBlobStore } from "../../kernel/testing/index.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

const STUB_RESULT: ActivityRunResult = {
  result: {
    output: { value: "stub" },
    metrics: { startTime: 0, endTime: 1, duration: 1 },
  },
  progress: [],
  annotations: [],
  logs: [],
};

function makeSpyExecutor(
  result: ActivityRunResult = STUB_RESULT,
): ActivityExecutor & {
  calls: ActivityRunInput[];
} {
  const calls: ActivityRunInput[] = [];
  return {
    calls,
    run: vi.fn(
      async (
        input: ActivityRunInput,
        _deps: ExecutorDeps,
      ): Promise<ActivityRunResult> => {
        calls.push(input);
        return result;
      },
    ),
  };
}

/** Minimal ActivityRunInput stub — only stageId is load-bearing for routing. */
function makeInput(stageId: string): ActivityRunInput {
  const minimalStageDef = defineStage({
    id: stageId,
    name: stageId,
    schemas: {
      input: z.object({}),
      output: z.object({ value: z.string() }),
      config: z.object({}),
    },
    async execute() {
      return { output: { value: "local-result" } };
    },
  });

  return {
    stageDef: minimalStageDef,
    workflowId: "wf-test",
    workflowRunId: "run-1",
    workflowType: "wf-test",
    stageId,
    stageName: stageId,
    stageNumber: 0,
    stageRecordId: "rec-1",
    attempt: 1,
    rawInput: {},
    config: {},
    workflowContext: {},
  };
}

function makeDeps(): ExecutorDeps {
  return {
    persistence: new InMemoryWorkflowPersistence(),
    blobStore: new InMemoryBlobStore(),
    clock: new FakeClock(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRoutingExecutor", () => {
  describe("with explicit remote + local spies", () => {
    it("routes stageId 'heavy' to the remote spy only", async () => {
      const remoteResult: ActivityRunResult = {
        ...STUB_RESULT,
        result: {
          output: { value: "remote" },
          metrics: { startTime: 0, endTime: 2, duration: 2 },
        },
      };
      const remote = makeSpyExecutor(remoteResult);
      const local = makeSpyExecutor();

      const executor = createRoutingExecutor({
        remote,
        local,
        remoteStageIds: ["heavy"],
      });

      const result = await executor.run(makeInput("heavy"), makeDeps());

      // Only remote was called
      expect((remote.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        1,
      );
      expect((local.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0,
      );

      // Result is the remote executor's result
      expect(result).toBe(remoteResult);
    });

    it("routes stageId 'core' to the local spy only", async () => {
      const localResult: ActivityRunResult = {
        ...STUB_RESULT,
        result: {
          output: { value: "local" },
          metrics: { startTime: 0, endTime: 3, duration: 3 },
        },
      };
      const remote = makeSpyExecutor();
      const local = makeSpyExecutor(localResult);

      const executor = createRoutingExecutor({
        remote,
        local,
        remoteStageIds: ["heavy"],
      });

      const result = await executor.run(makeInput("core"), makeDeps());

      // Only local was called
      expect((remote.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0,
      );
      expect((local.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        1,
      );

      // Result is the local executor's result
      expect(result).toBe(localResult);
    });

    it("passes input and deps straight through to the delegate", async () => {
      const remote = makeSpyExecutor();
      const local = makeSpyExecutor();
      const deps = makeDeps();
      const input = makeInput("heavy");

      const executor = createRoutingExecutor({
        remote,
        local,
        remoteStageIds: ["heavy"],
      });

      await executor.run(input, deps);

      const call = (remote.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(input);
      expect(call[1]).toBe(deps);
    });
  });

  describe("when local is omitted (defaults to LocalExecutor)", () => {
    it("runs a non-remote stage without throwing, and remote spy is NOT called", async () => {
      const remote = makeSpyExecutor();

      // defineStage with a real execute so LocalExecutor can actually run it
      const localOnlyStage = defineStage({
        id: "inline",
        name: "Inline Stage",
        schemas: {
          input: z.object({}),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { value: "inline-ok" } };
        },
      });

      const input: ActivityRunInput = {
        stageDef: localOnlyStage,
        workflowId: "wf-default-local",
        workflowRunId: "run-default",
        workflowType: "wf-default-local",
        stageId: "inline",
        stageName: "Inline Stage",
        stageNumber: 0,
        stageRecordId: "rec-default",
        attempt: 1,
        rawInput: {},
        config: {},
        workflowContext: {},
      };

      const executor = createRoutingExecutor({
        remote,
        // local intentionally omitted
        remoteStageIds: ["heavy"],
      });

      const result = await executor.run(input, makeDeps());

      // Remote was not called
      expect((remote.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0,
      );

      // LocalExecutor ran successfully and returned the stage's actual output
      expect(result.error).toBeUndefined();
      expect((result.result?.output as { value: string }).value).toBe(
        "inline-ok",
      );
    });
  });
});
