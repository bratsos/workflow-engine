import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DERIVED_VERSION_PREFIX,
  diffDefinitionSnapshots,
  hashDefinitionSnapshot,
} from "../../core/definition-version.js";
import { defineStage } from "../../core/stage-factory.js";
import { defineWorkflow } from "../../core/workflow.js";

const passthroughSchemas = {
  input: z.object({ val: z.string() }),
  output: z.object({ val: z.string() }),
  config: z.object({}),
};

function makeStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: passthroughSchemas,
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
}

function wf(id = "wf") {
  return defineWorkflow(id, { input: z.object({ val: z.string() }) });
}

describe("definition version: what it identifies", () => {
  it("is a derived hash and is stable across repeated reads", () => {
    const workflow = wf().pipe(makeStage("a")).build();

    expect(workflow.definitionVersion.startsWith(DERIVED_VERSION_PREFIX)).toBe(
      true,
    );
    expect(workflow.definitionVersion).toBe(workflow.definitionVersion);
  });

  it("is the same for two separately built but structurally identical pipelines", () => {
    const one = wf().pipe(makeStage("a")).build();
    const two = wf().pipe(makeStage("a")).build();

    expect(one.definitionVersion).toBe(two.definitionVersion);
  });

  it("does not change when only a stage's execute body changes", () => {
    const before = defineStage({
      id: "a",
      name: "A",
      schemas: passthroughSchemas,
      async execute(ctx) {
        return { output: { val: `${ctx.input.val}-one` } };
      },
    });
    const after = defineStage({
      id: "a",
      name: "A",
      schemas: passthroughSchemas,
      async execute(ctx) {
        return {
          output: { val: `${ctx.input.val}-two-and-completely-different` },
        };
      },
    });

    expect(wf().pipe(before).build().definitionVersion).toBe(
      wf().pipe(after).build().definitionVersion,
    );
  });

  it("does not change when only a stage's name or description changes", () => {
    const before = defineStage({
      id: "a",
      name: "Original name",
      description: "Original description",
      schemas: passthroughSchemas,
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const after = defineStage({
      id: "a",
      name: "Renamed",
      description: "Reworded",
      schemas: passthroughSchemas,
      async execute(ctx) {
        return { output: ctx.input };
      },
    });

    expect(wf().pipe(before).build().definitionVersion).toBe(
      wf().pipe(after).build().definitionVersion,
    );
  });

  it("changes when a stage is added", () => {
    const one = wf().pipe(makeStage("a")).build();
    const two = wf().pipe(makeStage("a")).pipe(makeStage("b")).build();

    expect(one.definitionVersion).not.toBe(two.definitionVersion);
  });

  it("changes when two stages are reordered", () => {
    const one = wf().pipe(makeStage("a")).pipe(makeStage("b")).build();
    const two = wf().pipe(makeStage("b")).pipe(makeStage("a")).build();

    expect(one.definitionVersion).not.toBe(two.definitionVersion);
  });

  it("changes when a stage's output schema gains a required field", () => {
    const narrow = makeStage("a");
    const wide = defineStage({
      id: "a",
      name: "Stage a",
      schemas: {
        input: z.object({ val: z.string() }),
        output: z.object({ val: z.string(), extra: z.number() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: { val: ctx.input.val, extra: 1 } };
      },
    });

    expect(wf().pipe(narrow).build().definitionVersion).not.toBe(
      wf().pipe(wide).build().definitionVersion,
    );
  });

  it("changes when two sequential stages become one parallel group", () => {
    const sequential = wf().pipe(makeStage("a")).pipe(makeStage("b")).build();
    const parallel = wf()
      .parallel([makeStage("a"), makeStage("b")])
      .build();

    expect(sequential.definitionVersion).not.toBe(parallel.definitionVersion);
  });

  it("equals the hash of its own snapshot", () => {
    const workflow = wf().pipe(makeStage("a")).build();

    expect(hashDefinitionSnapshot(workflow.getDefinitionSnapshot())).toBe(
      workflow.definitionVersion,
    );
  });
});

describe("definition version: explicit versions", () => {
  it("uses the declared version verbatim", () => {
    const workflow = wf().pipe(makeStage("a")).version("2").build();

    expect(workflow.definitionVersion).toBe("2");
  });

  it("replaces the derived version, so structurally different pipelines can share one", () => {
    const one = wf().pipe(makeStage("a")).version("2").build();
    const two = wf()
      .pipe(makeStage("a"))
      .pipe(makeStage("b"))
      .version("2")
      .build();

    expect(one.definitionVersion).toBe("2");
    expect(two.definitionVersion).toBe("2");
  });

  it("rejects an empty explicit version", () => {
    expect(() => wf().pipe(makeStage("a")).version("")).toThrow();
  });
});

describe("diffDefinitionSnapshots", () => {
  it("reports nothing for identical snapshots", () => {
    const workflow = wf().pipe(makeStage("a")).build();

    expect(
      diffDefinitionSnapshots(
        workflow.getDefinitionSnapshot(),
        workflow.getDefinitionSnapshot(),
      ),
    ).toEqual([]);
  });

  it("reports STAGE_REMOVED naming the stage that disappeared", () => {
    const pinned = wf()
      .pipe(makeStage("a"))
      .pipe(makeStage("b"))
      .build()
      .getDefinitionSnapshot();
    const candidate = wf().pipe(makeStage("a")).build().getDefinitionSnapshot();

    const drifts = diffDefinitionSnapshots(pinned, candidate);

    expect(drifts).toHaveLength(1);
    expect(drifts[0].code).toBe("STAGE_REMOVED");
    expect(drifts[0].stageId).toBe("b");
  });

  it("reports STAGE_ADDED naming the stage that appeared", () => {
    const pinned = wf().pipe(makeStage("a")).build().getDefinitionSnapshot();
    const candidate = wf()
      .pipe(makeStage("a"))
      .pipe(makeStage("b"))
      .build()
      .getDefinitionSnapshot();

    const drifts = diffDefinitionSnapshots(pinned, candidate);

    expect(drifts).toHaveLength(1);
    expect(drifts[0].code).toBe("STAGE_ADDED");
    expect(drifts[0].stageId).toBe("b");
  });

  it("reports EXECUTION_GROUP_CHANGED with the group numbers on both sides", () => {
    const pinned = wf()
      .pipe(makeStage("a"))
      .pipe(makeStage("b"))
      .build()
      .getDefinitionSnapshot();
    const candidate = wf()
      .parallel([makeStage("a"), makeStage("b")])
      .build()
      .getDefinitionSnapshot();

    const drift = diffDefinitionSnapshots(pinned, candidate).find(
      (d) => d.code === "EXECUTION_GROUP_CHANGED" && d.stageId === "b",
    );

    expect(drift).toBeDefined();
    expect(drift?.before).toBe(2);
    expect(drift?.after).toBe(1);
  });

  it("names which schema changed in a STAGE_SCHEMA_CHANGED message", () => {
    const before = defineStage({
      id: "a",
      name: "A",
      schemas: {
        input: z.object({ val: z.string() }),
        output: z.object({ val: z.string() }),
        config: z.object({ retries: z.number() }),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const after = defineStage({
      id: "a",
      name: "A",
      schemas: {
        input: z.object({ val: z.string() }),
        output: z.object({ val: z.string() }),
        config: z.object({ retries: z.number(), timeoutMs: z.number() }),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });

    const drift = diffDefinitionSnapshots(
      wf().pipe(before).build().getDefinitionSnapshot(),
      wf().pipe(after).build().getDefinitionSnapshot(),
    ).find((d) => d.code === "STAGE_SCHEMA_CHANGED");

    expect(drift).toBeDefined();
    expect(drift?.stageId).toBe("a");
    expect(drift?.message).toContain("config");
  });
});
