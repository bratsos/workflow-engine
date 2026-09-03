import { describe, expect, expectTypeOf, it } from "vitest";
import { getModel, ModelKey } from "../../ai/model-helper.js";

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

  it("parses an unregistered key through the exported zod schema", () => {
    expect(ModelKey.parse("some/model-nobody-registered")).toBe(
      "some/model-nobody-registered",
    );
    expect(ModelKey.safeParse("").success).toBe(false);
  });
});
