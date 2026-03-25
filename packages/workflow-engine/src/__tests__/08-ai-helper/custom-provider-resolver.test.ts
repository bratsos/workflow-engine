import { describe, expect, it, vi } from "vitest";
import { createAIHelper, type ProviderResolver } from "../../ai/ai-helper.js";

describe("custom provider resolver", () => {
  it("accepts providerResolver as 4th argument without error", () => {
    const providerResolver: ProviderResolver = vi.fn().mockReturnValue(null);
    const fakeLogger = {
      logCall: vi.fn(),
      getCalls: vi.fn().mockResolvedValue([]),
    };

    const ai = createAIHelper(
      "test-topic",
      fakeLogger as any,
      undefined,
      providerResolver,
    );
    expect(ai).toBeDefined();
  });

  it("preserves backward compatibility — 3rd param is still logContext", () => {
    const fakeLogger = {
      logCall: vi.fn(),
      getCalls: vi.fn().mockResolvedValue([]),
    };

    const ai = createAIHelper("test-topic", fakeLogger as any);
    expect(ai).toBeDefined();
  });

  it("propagates providerResolver to child helpers", () => {
    const providerResolver: ProviderResolver = vi.fn().mockReturnValue(null);
    const fakeLogger = {
      logCall: vi.fn(),
      getCalls: vi.fn().mockResolvedValue([]),
    };

    const ai = createAIHelper(
      "test-topic",
      fakeLogger as any,
      undefined,
      providerResolver,
    );
    const child = ai.createChild("stage", "extraction");
    expect(child).toBeDefined();
    expect(child.topic).toBe("test-topic.stage.extraction");
    // Verify the resolver is actually propagated (access private field via cast)
    expect((child as any).providerResolver).toBe(providerResolver);
  });
});
