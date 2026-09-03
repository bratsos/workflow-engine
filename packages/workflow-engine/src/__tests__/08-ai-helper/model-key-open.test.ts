import { describe, expect, expectTypeOf, it } from "vitest";
import { getModel, type ModelKey } from "../../ai/model-helper.js";

describe("open ModelKey", () => {
  it("accepts plain strings while retaining built-in literals", () => {
    expectTypeOf<string>().toMatchTypeOf<ModelKey>();
    expectTypeOf<"gemini-2.5-flash">().toMatchTypeOf<ModelKey>();
  });

  it("still validates unknown keys at runtime", () => {
    expect(() => getModel("nope")).toThrow(
      /Model "nope" not found\. Available models:/,
    );
  });
});
