import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import {
  defineWorkflow,
  type InferWorkflowContext,
  type InferWorkflowOutput,
} from "../../core/workflow.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

const In = z.object({ repo: z.string() });
const ChapterIndex = z.object({ chapters: z.array(z.string()) });
const Extract = z.object({ count: z.number() });
const Cfg = z.object({});

describe("builder-first typed workflows (types)", () => {
  it("types ctx.require from earlier stages and rejects unknown dependencies", () => {
    const builder = defineWorkflow("repository", { input: In })
      .stage("chapter-index", {
        schemas: { input: In, output: ChapterIndex, config: Cfg },
        async execute(ctx) {
          expectTypeOf(ctx.input).toEqualTypeOf<{ repo: string }>();
          // Nothing has been added to the context yet.
          // @ts-expect-error — no earlier stage exists
          ctx.require("chapter-index");
          return { output: { chapters: [ctx.input.repo] } };
        },
      })
      .stage("unified-extract", {
        dependencies: ["chapter-index"],
        schemas: { input: "none", output: Extract, config: Cfg },
        async execute(ctx) {
          const idx = ctx.require("chapter-index");
          expectTypeOf(idx).toEqualTypeOf<z.infer<typeof ChapterIndex>>();
          expectTypeOf(ctx.optional("chapter-index")).toEqualTypeOf<
            z.infer<typeof ChapterIndex> | undefined
          >();
          // @ts-expect-error — a stage cannot require a later stage
          ctx.require("summary");
          return { output: { count: idx.chapters.length } };
        },
      });

    // The type error is also a runtime error.
    expect(() =>
      builder.stage("summary", {
        // @ts-expect-error — "nope" is not an earlier stage id
        dependencies: ["nope"],
        schemas: { input: "none", output: z.string(), config: Cfg },
        async execute() {
          return { output: "done" };
        },
      }),
    ).toThrow(/missing dependencies: nope/);
  });

  it("rejects a stage id used twice", () => {
    const first = defineWorkflow("dupes", { input: In }).stage("a", {
      schemas: { input: In, output: ChapterIndex, config: Cfg },
      async execute() {
        return { output: { chapters: [] } };
      },
    });

    expect(() =>
      // @ts-expect-error — "a" is already a stage id
      first.stage("a", {
        schemas: { input: "none", output: Extract, config: Cfg },
        async execute() {
          return { output: { count: 0 } };
        },
      }),
    ).toThrow(/already in workflow/);

    const prebuilt = defineStage({
      id: "a",
      name: "A again",
      schemas: { input: In, output: Extract, config: Cfg },
      async execute() {
        return { output: { count: 0 } };
      },
    });
    // @ts-expect-error — a prebuilt stage with a duplicate id is rejected too
    expect(() => first.stage(prebuilt)).toThrow(/already in workflow/);
  });

  it("makes every parallel-group output available after the group", () => {
    const workflow = defineWorkflow("fan-out", { input: In })
      .stage("chapter-index", {
        schemas: { input: In, output: ChapterIndex, config: Cfg },
        async execute() {
          return { output: { chapters: [] } };
        },
      })
      .parallel((group) =>
        group
          .stage("left", {
            dependencies: ["chapter-index"],
            schemas: { input: "none", output: Extract, config: Cfg },
            async execute(ctx) {
              // @ts-expect-error — members cannot see each other
              ctx.require("right");
              return {
                output: { count: ctx.require("chapter-index").chapters.length },
              };
            },
          })
          .stage("right", {
            schemas: { input: "none", output: z.string(), config: Cfg },
            async execute() {
              return { output: "r" };
            },
          }),
      )
      .stage("join", {
        dependencies: ["left", "right"],
        schemas: { input: "none", output: z.number(), config: Cfg },
        async execute(ctx) {
          expectTypeOf(ctx.require("left")).toEqualTypeOf<{ count: number }>();
          expectTypeOf(ctx.require("right")).toEqualTypeOf<string>();
          return { output: ctx.require("left").count };
        },
      })
      .build();

    type Ctx = InferWorkflowContext<typeof workflow>;
    expectTypeOf<Ctx["chapter-index"]>().toEqualTypeOf<
      z.infer<typeof ChapterIndex>
    >();
    expectTypeOf<Ctx["left"]>().toEqualTypeOf<{ count: number }>();
    expectTypeOf<Ctx["right"]>().toEqualTypeOf<string>();
    expectTypeOf<Ctx["join"]>().toEqualTypeOf<number>();
    expectTypeOf<
      InferWorkflowOutput<typeof workflow>
    >().toEqualTypeOf<number>();
  });

  it("mixes prebuilt stages with inline definitions", () => {
    const prebuilt = defineStage({
      id: "prebuilt",
      name: "Prebuilt",
      schemas: { input: In, output: ChapterIndex, config: Cfg },
      async execute() {
        return { output: { chapters: [] } };
      },
    });

    const piped = defineStage({
      id: "piped",
      name: "Piped",
      schemas: { input: "none", output: z.boolean(), config: Cfg },
      async execute() {
        return { output: true };
      },
    });

    defineWorkflow("mixed", { input: In })
      .stage(prebuilt)
      .stage("inline", {
        dependencies: ["prebuilt"],
        schemas: { input: "none", output: Extract, config: Cfg },
        async execute(ctx) {
          expectTypeOf(ctx.require("prebuilt")).toEqualTypeOf<
            z.infer<typeof ChapterIndex>
          >();
          return { output: { count: 0 } };
        },
      })
      .pipe(piped)
      .stage("last", {
        dependencies: ["piped", "inline"],
        schemas: { input: "none", output: z.string(), config: Cfg },
        async execute(ctx) {
          expectTypeOf(ctx.require("piped")).toEqualTypeOf<boolean>();
          return { output: "" };
        },
      });
  });

  it("types async-batch definitions and their checkCompletion", () => {
    defineWorkflow("batchy", { input: In }).stage("batch", {
      mode: "async-batch",
      schemas: {
        input: In,
        output: Extract,
        config: z.object({ n: z.number() }),
      },
      async execute() {
        return { suspended: true as const, state: { batchId: "b1" } };
      },
      async checkCompletion(state, ctx) {
        expectTypeOf(state.batchId).toEqualTypeOf<string>();
        expectTypeOf(ctx.config).toEqualTypeOf<{ n: number }>();
        return { ready: true, output: { count: ctx.config.n } };
      },
    });
  });
});

describe("builder-first typed workflows (runtime)", () => {
  it("runs a three-stage builder workflow with a durable wait to COMPLETED", async () => {
    let polls = 0;
    const workflow = defineWorkflow("builder-run", {
      name: "Builder Run",
      input: In,
    })
      .stage("chapter-index", {
        schemas: { input: In, output: ChapterIndex, config: Cfg },
        async execute(ctx) {
          return {
            output: {
              chapters: [`${ctx.input.repo}/a`, `${ctx.input.repo}/b`],
            },
          };
        },
      })
      .stage("unified-extract", {
        dependencies: ["chapter-index"],
        schemas: { input: "none", output: Extract, config: Cfg },
        async execute(ctx) {
          const ready = await ctx.step.waitFor("external", {
            poll: async () => ({ ready: ++polls >= 2 }),
            ready: (value) => value.ready,
            every: "1s",
            timeout: "1m",
          });
          expect(ready.ready).toBe(true);
          return {
            output: { count: ctx.require("chapter-index").chapters.length },
          };
        },
      })
      .stage("summary", {
        dependencies: ["unified-extract"],
        schemas: { input: "none", output: z.string(), config: Cfg },
        async execute(ctx) {
          return { output: `${ctx.require("unified-extract").count} chapters` };
        },
      })
      .build();

    expect(workflow.getStageIds()).toEqual([
      "chapter-index",
      "unified-extract",
      "summary",
    ]);
    expect(workflow.getStage("chapter-index")?.name).toBe("chapter-index");

    const { kernel, persistence, clock, flush } = createTestKernel([workflow], {
      stepLedger: new InMemoryStepLedger(),
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "builder-run",
      workflowId: workflow.id,
      input: { repo: "r" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w" });

    const exec = async (stageId: string) =>
      kernel.dispatch({
        type: "job.execute",
        workflowRunId: created.workflowRunId,
        workflowId: workflow.id,
        stageId,
        config: {},
      });

    expect((await exec("chapter-index")).outcome).toBe("completed");
    await kernel.dispatch({
      type: "run.transition",
      workflowRunId: created.workflowRunId,
    });

    expect((await exec("unified-extract")).outcome).toBe("suspended");
    clock.advance(1_000);
    const poll = await kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll.resumed).toBe(1);
    await kernel.dispatch({
      type: "run.transition",
      workflowRunId: created.workflowRunId,
    });

    expect((await exec("summary")).output).toBe("2 chapters");
    await kernel.dispatch({
      type: "run.transition",
      workflowRunId: created.workflowRunId,
    });
    await flush();

    expect((await persistence.getRun(created.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });

  it("rejects duplicate ids and unknown dependencies at runtime", () => {
    const builder = defineWorkflow("runtime-checks").stage("a", {
      schemas: { input: "none", output: z.string(), config: Cfg },
      async execute() {
        return { output: "" };
      },
    });
    expect(() =>
      (builder as any).stage("a", {
        schemas: { input: "none", output: z.string(), config: Cfg },
        async execute() {
          return { output: "" };
        },
      }),
    ).toThrow(/already in workflow/);
    expect(() =>
      (builder as any).stage("b", {
        dependencies: ["missing"],
        schemas: { input: "none", output: z.string(), config: Cfg },
        async execute() {
          return { output: "" };
        },
      }),
    ).toThrow(/missing dependencies: missing/);
  });
  describe("prebuilt stages are checked against the accumulated context", () => {
    const Needs = defineStage<{ "chapter-index": { chapters: string[] } }>()({
      id: "needs-index",
      name: "Needs Index",
      schemas: { input: "none", output: z.string(), config: Cfg },
      async execute(ctx) {
        return { output: `${ctx.require("chapter-index").chapters.length}` };
      },
    });

    const indexStage = defineStage({
      id: "chapter-index",
      name: "Chapter Index",
      schemas: { input: "none", output: ChapterIndex, config: Cfg },
      async execute() {
        return { output: { chapters: ["one"] } };
      },
    });

    it("accepts a prebuilt stage whose context keys are already produced", () => {
      const workflow = defineWorkflow("prebuilt-ok")
        .stage(indexStage)
        .stage(Needs)
        .build();
      expect(workflow.getStage("needs-index")).toBeDefined();
    });

    it("rejects a prebuilt stage requiring a key no earlier stage produces", () => {
      const builder = defineWorkflow("prebuilt-missing");
      // @ts-expect-error — "chapter-index" is not in the accumulated context
      builder.stage(Needs);
      // @ts-expect-error — .pipe() is checked identically
      builder.pipe(Needs);
    });

    it("rejects a prebuilt stage whose context value type is incompatible", () => {
      const wrongShape = defineStage<{
        "chapter-index": { chapters: number };
      }>()({
        id: "wrong-shape",
        name: "Wrong Shape",
        schemas: { input: "none", output: z.string(), config: Cfg },
        async execute(ctx) {
          return { output: `${ctx.require("chapter-index").chapters}` };
        },
      });
      const builder = defineWorkflow("prebuilt-mismatch").stage(indexStage);
      // @ts-expect-error — chapters is string[] here, not number
      builder.stage(wrongShape);
    });
  });
});
