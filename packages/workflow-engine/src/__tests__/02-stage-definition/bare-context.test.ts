/**
 * A stage that never touches `ctx.step` or `ctx.ai` runs on a hand-built
 * context that carries neither (custom hosts, unit tests calling
 * `stage.execute(ctx)` directly). The wrapper's pending-control-flow and
 * in-flight probes must not dereference an absent `step`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";

describe("stage wrapper on a bare context", () => {
  it("executes a stage whose context has no step, ai or aiLogger", async () => {
    const stage = defineStage({
      id: "plain",
      name: "Plain",
      schemas: {
        input: z.object({ value: z.number() }),
        output: z.object({ doubled: z.number() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: { doubled: ctx.input.value * 2 } };
      },
    });

    const logs: string[] = [];
    const bareContext = {
      workflowRunId: "run-1",
      workflowId: "wf",
      workflowType: "test",
      stageId: "plain",
      stageName: "Plain",
      stageNumber: 1,
      input: { value: 21 },
      config: {},
      workflowContext: {},
      require: () => {
        throw new Error("not used");
      },
      log: (_level: string, message: string) => {
        logs.push(message);
      },
      onLog: () => {},
      onProgress: () => {},
      storage: {
        save: async () => {},
        load: async () => null,
        delete: async () => {},
      },
    };

    const result = await stage.execute(bareContext as never);

    expect(result).toMatchObject({ output: { doubled: 42 } });
    expect(logs).toEqual([]);
  });

  it("still lets a thrown stage error propagate on a bare context", async () => {
    const stage = defineStage({
      id: "boom",
      name: "Boom",
      schemas: {
        input: z.object({}),
        output: z.object({}),
        config: z.object({}),
      },
      async execute() {
        throw new Error("stage failed");
      },
    });

    await expect(
      stage.execute({
        workflowRunId: "run-1",
        stageId: "boom",
        stageName: "Boom",
        input: {},
        config: {},
        workflowContext: {},
        log: () => {},
        onProgress: () => {},
      } as never),
    ).rejects.toThrow("stage failed");
  });
});
