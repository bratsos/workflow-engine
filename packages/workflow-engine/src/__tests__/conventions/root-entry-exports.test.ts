import { describe, expect, it } from "vitest";
import * as root from "../../index.js";

describe("root entry exports", () => {
  it("exports the Prisma step ledger factory next to the other createPrisma* helpers", () => {
    expect(typeof root.createPrismaStepLedger).toBe("function");
    expect(typeof root.createPrismaWorkflowPersistence).toBe("function");
    expect(typeof root.createPrismaAICallLogger).toBe("function");
    expect(typeof root.NoObjectGeneratedError).toBe("function");
  });
});
