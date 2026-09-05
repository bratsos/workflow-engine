import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { AIServicesNotConfiguredError } from "../../kernel/errors.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";
import { createMockAIHelperFactory, createTestKernel } from "../utils/index.js";

const valueSchema = z.object({ value: z.string() });

async function executeStage(
  workflowId: string,
  stage: ReturnType<typeof defineStage>,
  services?: NonNullable<Parameters<typeof createTestKernel>[1]>["services"],
) {
  const workflow = new WorkflowBuilder(
    workflowId,
    workflowId,
    "test",
    valueSchema,
    valueSchema,
  )
    .pipe(stage)
    .build();
  const harness = createTestKernel([workflow], { services });
  const created = await harness.kernel.dispatch({
    type: "run.create",
    idempotencyKey: `${workflowId}-run`,
    workflowId,
    input: { value: "input" },
  });
  await harness.kernel.dispatch({
    type: "run.claimPending",
    workerId: "test-worker",
  });
  await harness.kernel.dispatch({
    type: "job.execute",
    workflowRunId: created.workflowRunId,
    workflowId,
    stageId: stage.id,
    config: {},
  });
  return { ...harness, workflowRunId: created.workflowRunId };
}

describe("kernel AI context injection", () => {
  it("lazily injects a topic-scoped helper and records its cost", async () => {
    const aiFactory = createMockAIHelperFactory();
    aiFactory.setTextResponse("hello", {
      text: "world",
      inputTokens: 11,
      outputTokens: 7,
      cost: 0.25,
    });
    const aiLogger = new InMemoryAICallLogger();
    let runId = "";
    const stage = defineStage({
      id: "ai-stage",
      name: "AI Stage",
      schemas: {
        input: valueSchema,
        output: valueSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        const result = await ctx.ai.generateText("gemini-2.5-flash", "hello");
        return { output: { value: `${runId}:${result.text}` } };
      },
    });
    const result = await executeStage("ctx-ai", stage, {
      aiLogger,
      ai: aiFactory,
    });
    runId = result.workflowRunId;

    // The stage has already run; inspect the logger's exact topic and cost.
    const calls = aiLogger.getCallsByTopic(
      `workflow.${result.workflowRunId}.stage.ai-stage`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cost).toBe(0.25);
    expect(aiFactory.getCalls()).toHaveLength(1);
  });

  it("does not require services for stages that do not use AI", async () => {
    const stage = defineStage({
      id: "plain-stage",
      name: "Plain Stage",
      schemas: {
        input: valueSchema,
        output: valueSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    await expect(executeStage("plain", stage)).resolves.toBeDefined();
  });

  it("throws a descriptive error when AI is accessed without services", async () => {
    let caught: unknown;
    const stage = defineStage({
      id: "unconfigured-ai",
      name: "Unconfigured AI",
      schemas: {
        input: valueSchema,
        output: valueSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        try {
          void ctx.ai;
        } catch (error) {
          caught = error;
        }
        return { output: ctx.input };
      },
    });
    await executeStage("unconfigured", stage);
    expect(caught).toBeInstanceOf(AIServicesNotConfiguredError);
  });
});
