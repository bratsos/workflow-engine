/**
 * defineWorkflow() Tests
 *
 * Behavioral coverage for `defineWorkflow()`, the options-object
 * alternative to `new WorkflowBuilder(...)`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { defineWorkflow } from "../../core/workflow.js";
import { createTestKernel } from "../utils/index.js";

describe("defineWorkflow() options-object API", () => {
  it("builds an equivalent workflow to `new WorkflowBuilder(...)`", () => {
    const schema = z.object({ value: z.string() });
    const stage = defineStage({
      id: "echo",
      name: "Echo",
      schemas: { input: schema, output: schema, config: z.object({}) },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });

    const workflow = defineWorkflow({
      id: "define-workflow-test",
      name: "Define Workflow Test",
      description: "Built via defineWorkflow()",
      input: schema,
    })
      .pipe(stage)
      .build();

    expect(workflow.id).toBe("define-workflow-test");
    expect(workflow.name).toBe("Define Workflow Test");
    expect(workflow.description).toBe("Built via defineWorkflow()");
    expect(workflow.hasStage("echo")).toBe(true);
    // The final output schema comes from the last piped stage, not the
    // (omitted) `output` option.
    expect(workflow.outputSchema).toBe(stage.outputSchema);
  });

  it("works end-to-end through the kernel", async () => {
    const schema = z.object({ value: z.number() });
    const doubleStage = defineStage({
      id: "double",
      name: "Double",
      schemas: {
        input: schema,
        output: z.object({ result: z.number() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: { result: ctx.input.value * 2 } };
      },
    });

    const workflow = defineWorkflow({
      id: "define-workflow-kernel",
      name: "Define Workflow Kernel Test",
      input: schema,
    })
      .pipe(doubleStage)
      .build();

    const { kernel } = createTestKernel([workflow]);

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "define-workflow-kernel",
      input: { value: 21 },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

    const jobResult = await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "define-workflow-kernel",
      stageId: "double",
      config: {},
    });

    expect(jobResult.outcome).toBe("completed");
    expect(jobResult.output).toEqual({ result: 42 });
  });
});
