import { describe, expect, it } from "vitest";

import { inspectPackageJson, transformSource } from "../../cli/codemod";

describe("workflow-engine-codemod safe rewrites", () => {
  it("renames experimental_output only in generateText object arguments", () => {
    const result = transformSource(
      `
const changed = ai.generateText("model", "prompt", { experimental_output: schema });
const unchanged = { experimental_output: schema };
const indirect = ai.generateText("model", "prompt", options);
`,
      { from: "0.11", fileName: "example.ts" },
    );

    expect(result.transformedSource).toContain(
      'ai.generateText("model", "prompt", { output: schema })',
    );
    expect(result.transformedSource).toContain(
      "const unchanged = { experimental_output: schema }",
    );
    expect(result.edits.map((edit) => edit.rule)).toEqual([1]);
  });

  it("renames onStepFinish for the three supported generation calls", () => {
    const result = transformSource(
      `
ai.generateText("model", "prompt", { onStepFinish: handler });
ai.generateObject("model", { onStepFinish: handler });
ai.streamText("model", { onStepFinish: handler });
const unrelated = { onStepFinish: handler };
`,
      { from: "0.11" },
    );

    expect(result.transformedSource.match(/onStepEnd/g)).toHaveLength(3);
    expect(result.transformedSource).toContain(
      "const unrelated = { onStepFinish: handler }",
    );
    expect(result.edits.filter((edit) => edit.rule === 2)).toHaveLength(3);
  });

  it("renames streamText system only in its second object argument", () => {
    const result = transformSource(
      `
ai.streamText("model", { system: "instructions" });
ai.streamText({ system: "not an options object" }, prompt);
await ai.batch("model").submit([{ system: "batch request" }]);
`,
      { from: "0.11" },
    );

    expect(result.transformedSource).toContain(
      'ai.streamText("model", { instructions: "instructions" })',
    );
    expect(result.transformedSource).toContain(
      'ai.streamText({ system: "not an options object" }, prompt)',
    );
    expect(result.transformedSource).toContain(
      'submit([{ system: "batch request" }])',
    );
    expect(result.edits.map((edit) => edit.rule)).toEqual([3]);
  });

  it("does not rename quoted properties or indirect generation options", () => {
    const result = transformSource(
      `
const options = { experimental_output: schema, onStepFinish: handler };
ai.generateText("model", "prompt", options);
ai.generateText("model", "prompt", { "experimental_output": schema });
`,
      { from: "0.11" },
    );

    expect(result.edits).toHaveLength(0);
    expect(result.transformedSource).toBe(result.source);
  });

  it("only reports 0.12-to-0.13 findings when requested", () => {
    const source = `
const batch = ai.batch("model");
batch.getStatus(id);
`;

    expect(transformSource(source, { from: "0.11" }).findings).toHaveLength(1);
    expect(transformSource(source, { from: "0.12" }).edits).toHaveLength(0);
    expect(transformSource(source, { from: "0.12" }).findings).toHaveLength(1);
  });
});

describe("workflow-engine-codemod report-only findings", () => {
  it("reports every removed named provider import from both package entries", () => {
    const result = transformSource(
      `
import {
  GoogleBatchProvider as Provider,
  type BatchStatus,
} from "@bratsos/workflow-engine";
import { AnthropicBatchRequest } from "@bratsos/workflow-engine/client";
import { AIBatch } from "@bratsos/workflow-engine";
`,
      { from: "0.12" },
    );

    expect(result.findings).toHaveLength(3);
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "removed in 0.13; drive batches through ai.batch()",
      "removed in 0.13; drive batches through ai.batch()",
      "removed in 0.13; drive batches through ai.batch()",
    ]);
    expect(result.findings.every((finding) => finding.rule === 4)).toBe(true);
  });

  it("reports getStatus and getResults for batch handles and literal names", () => {
    const result = transformSource(
      `
const handle = await ai.batch("model");
handle.getStatus(id);
handle.getResults(id);
batch.getStatus(id);
provider.getResults(id);
handle.getStatus(id, state.metadata);
handle.getResults(id, state.metadata);
other.getStatus(id);
`,
      { from: "0.12" },
    );

    expect(result.findings.map((finding) => finding.rule)).toEqual([
      5, 6, 5, 6,
    ]);
    expect(result.findings[0]?.message).toContain(
      "getStatus(id, state.metadata)",
    );
    expect(result.findings[1]?.message).toContain("schemas");
  });

  it("tracks assignment statements as well as declarations for batch handles", () => {
    const result = transformSource(
      `
let handle;
handle = client.batch("model");
handle.getStatus(id);
const wrapped = (await client.batch("model"));
wrapped.getResults(id);
`,
      { from: "0.12" },
    );

    expect(result.findings.map((finding) => finding.rule)).toEqual([5, 6]);
  });

  it("reports deprecated batch pricing properties in object literals", () => {
    const result = transformSource(
      `
const model = { batchDiscountPercent: 50 };
interface Config { batchDiscountPercent: number }
const quoted = { "batchDiscountPercent": 50 };
`,
      { from: "0.12" },
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rule).toBe(7);
    expect(result.findings[0]?.message).toContain("batchInputCostPerMillion");
  });

  it("reports apiKey only when batchId is in the same object literal", () => {
    const result = transformSource(
      `
const state = { apiKey: key, batchId: id };
const separate = { apiKey: key, metadata: { batchId: id } };
const nested = { batchId: id, metadata: { apiKey: key } };
`,
      { from: "0.12" },
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rule).toBe(8);
    expect(result.findings[0]?.message).toContain("BatchOptions.apiKey");
  });

  it("skips generated source files before parsing or reporting", () => {
    const result = transformSource(
      `// generated file
// AUTO-GENERATED by workflow-engine-sync
const model = { batchDiscountPercent: 50 };
ai.generateText("model", "prompt", { experimental_output: schema });
`,
      { from: "0.11" },
    );

    expect(result.skipped).toBe(true);
    expect(result.edits).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
    expect(result.transformedSource).toBe(result.source);
  });
});

describe("workflow-engine-codemod package.json checks", () => {
  it("distinguishes declared-and-imported from declared-but-never-imported", () => {
    const result = inspectPackageJson(
      `{
  "dependencies": {
    "@anthropic-ai/sdk": "^1.0.0",
    "@google/genai": "^1.0.0",
    "openai": "^1.0.0"
  }
}`,
      [
        {
          fileName: "src/anthropic.ts",
          source: 'import Anthropic from "@anthropic-ai/sdk";\nvoid Anthropic;',
        },
        {
          fileName: "src/other.ts",
          source: 'const client = await import("openai");\nvoid client;',
        },
      ],
      "package.json",
    );

    expect(result.parseErrors).toHaveLength(0);
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0]?.suggestion).toContain("declared and imported");
    expect(result.findings[1]?.suggestion).toContain(
      "declared but never imported",
    );
    expect(result.findings[2]?.suggestion).toContain("declared and imported");
  });

  it("recognizes require and export imports while ignoring unrelated strings", () => {
    const result = inspectPackageJson(
      '{ "devDependencies": { "openai": "^1.0.0" } }',
      [
        {
          fileName: "src/client.ts",
          source:
            'const sdk = require("openai");\nconst text = "openai";\nvoid sdk;\n',
        },
      ],
    );

    expect(result.findings[0]?.suggestion).toContain("declared and imported");
  });
});
