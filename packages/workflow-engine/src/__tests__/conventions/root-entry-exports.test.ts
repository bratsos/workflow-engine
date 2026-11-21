import { describe, expect, it } from "vitest";
import * as root from "../../index.js";

describe("root entry exports", () => {
  it("exports the Prisma step ledger factory next to the other createPrisma* helpers", () => {
    expect(typeof root.createPrismaStepLedger).toBe("function");
    expect(typeof root.createPrismaWorkflowPersistence).toBe("function");
    expect(typeof root.createPrismaAICallLogger).toBe("function");
    expect(typeof root.NoObjectGeneratedError).toBe("function");
  });

  it("exports the step errors a stage body can meet", () => {
    expect(typeof root.StepTimeoutError).toBe("function");
    expect(typeof root.StepNotReplaySafeError).toBe("function");
    expect(typeof root.StepLeaseLostError).toBe("function");
  });

  it("exports NonRetryableError and a cross-bundle check for it", () => {
    const error = new root.NonRetryableError("card revoked", {
      cause: new Error("402"),
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NonRetryableError");
    expect(root.isNonRetryableError(error)).toBe(true);
    // A copy from another bundle carries the same registered brand.
    const brand = Object.getOwnPropertySymbols(error)[0]!;
    expect(root.isNonRetryableError({ [brand]: true })).toBe(true);
    expect(root.isNonRetryableError(new Error("NonRetryableError: x"))).toBe(
      false,
    );
  });
});
