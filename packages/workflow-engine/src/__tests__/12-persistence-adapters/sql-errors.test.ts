import { describe, expect, it } from "vitest";
import {
  isSerializationFailure,
  isUniqueViolation,
  sqlStateOf,
} from "../../persistence/prisma/sql-errors.js";

// The shapes the same Postgres failure takes on each driver. Prisma 6 and 7
// are also driven for real in prisma-postgres-conformance.test.ts; Prisma 8
// and node-postgres have no Postgres suite here, so their shapes are pinned.
describe("sqlStateOf", () => {
  it.each([
    ["Prisma 8 query error", { sqlState: "40001" }],
    ["Prisma 6 raw SQL", { code: "P2010", meta: { code: "40001" } }],
    [
      "Prisma 7 raw SQL",
      {
        code: "P2010",
        meta: {
          driverAdapterError: {
            cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
          },
        },
      },
    ],
    ["node-postgres", { code: "40001" }],
    ["Prisma model API write conflict", { code: "P2034" }],
  ])("finds a serialization failure on %s", (_driver, error) => {
    expect(sqlStateOf(error)).toBe("40001");
    expect(isSerializationFailure(error)).toBe(true);
    expect(isUniqueViolation(error)).toBe(false);
  });

  it.each([
    ["Prisma 8 query error", { sqlState: "23505", constraint: "k" }],
    ["Prisma 6 raw SQL", { code: "P2010", meta: { code: "23505" } }],
    [
      "Prisma 7 raw SQL",
      {
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "23505" } } },
      },
    ],
    ["node-postgres", { code: "23505" }],
    ["Prisma model API", { code: "P2002", meta: { target: ["key"] } }],
  ])("finds a unique violation on %s", (_driver, error) => {
    expect(sqlStateOf(error)).toBe("23505");
    expect(isUniqueViolation(error)).toBe(true);
    expect(isSerializationFailure(error)).toBe(false);
  });

  it("does not take a Prisma error code for a SQLSTATE", () => {
    expect(sqlStateOf({ code: "P2010" })).toBeUndefined();
    expect(sqlStateOf({ code: "P2025" })).toBeUndefined();
  });

  it("returns nothing for values that carry no code", () => {
    for (const value of [undefined, null, "40001", 40001, new Error("x"), {}]) {
      expect(sqlStateOf(value)).toBeUndefined();
    }
  });
});
