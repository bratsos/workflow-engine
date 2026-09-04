/**
 * A test double that quietly drops a port method is how a bug hides.
 *
 * The hand-written `StepLedger` literals in the durable tests forwarded
 * every method except the one the port had just gained, so those tests
 * exercised the kernel's fallback rather than the implementation they were
 * written for, and stayed green while doing it. These two tests keep that
 * from recurring: the first pins what `wrapStepLedger` forwards, the second
 * refuses a new hand-written literal anywhere in the suite.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StepLedger } from "../../kernel/ports.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import {
  STEP_LEDGER_METHODS,
  wrapStepLedger,
} from "../utils/step-ledger-double.js";

const TESTS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("StepLedger test doubles", () => {
  it("forwards every method of the port, optional ones included", async () => {
    const inner = new InMemoryStepLedger();
    const wrapper = wrapStepLedger(inner);

    // `STEP_LEDGER_METHODS` is checked against `keyof StepLedger` at
    // compile time, so this is the runtime half: everything on the list is
    // actually wired through.
    for (const name of STEP_LEDGER_METHODS) {
      expect(
        typeof (wrapper as unknown as Record<string, unknown>)[name],
        `wrapStepLedger dropped ${name}`,
      ).toBe("function");
    }

    // Forwarding is real, not just present.
    await wrapper.claim({
      stageRecordId: "stage-1",
      stepId: "keep",
      seq: 0,
      kind: "run",
      status: "running",
      attempt: 1,
      leaseExpiresAt: null,
      deadlineAt: null,
      externalKey: null,
      result: null,
      error: null,
    });
    expect(await inner.get("stage-1", "keep")).not.toBeNull();
    await wrapper.clearExcept?.("stage-1", ["keep"]);
    expect(await inner.list("stage-1")).toHaveLength(1);
  });

  it("keeps an optional method absent when the inner ledger has none", () => {
    const bare: StepLedger = {
      claim: async () => {
        throw new Error("unused");
      },
      get: async () => null,
      update: async () => {
        throw new Error("unused");
      },
      compareAndSet: async () => ({ applied: false, record: null }),
      list: async () => [],
      clear: async () => {},
    };

    // A ledger with no partial clear is a case the kernel must still
    // handle, so the helper must be able to model it...
    expect(wrapStepLedger(bare).clearExcept).toBeUndefined();
    // ...and an override still adds or removes it deliberately.
    expect(
      wrapStepLedger(bare, { clearExcept: async () => {} }).clearExcept,
    ).toBeTypeOf("function");
    expect(
      wrapStepLedger(new InMemoryStepLedger(), { clearExcept: undefined })
        .clearExcept,
    ).toBeUndefined();
  });

  it("is the only way a test builds one", () => {
    const literals: string[] = [];
    for (const file of testFiles(TESTS_DIR)) {
      if (file.endsWith("step-ledger-double.test.ts")) continue;
      const source = readFileSync(file, "utf8");
      // A `clear:` property in a test is the tell of a hand-forwarded
      // ledger literal — the shape that drops whatever the port gains
      // next. Nothing else in the suite has a reason to write one.
      //
      // Unless the literal is annotated `Required<StepLedger>`, which is
      // the one shape that cannot drop a method: the compiler rejects it
      // for the same omission this rule is looking for. A test of the
      // forwarding itself needs such a literal — it has to record which
      // method was called, so there is nothing to forward it to.
      const lines = source.split("\n");
      const offenders = lines.filter((line, index) => {
        if (!/^\s*clear:/.test(line)) return false;
        for (let i = index; i >= 0; i--) {
          if (!/[={]\s*$|=\s*\{/.test(lines[i] ?? "")) continue;
          return !/Required<StepLedger>/.test(lines[i] ?? "");
        }
        return true;
      });
      if (offenders.length > 0) {
        literals.push(file.slice(TESTS_DIR.length + 1));
      }
    }
    expect(
      literals,
      "build StepLedger doubles with wrapStepLedger() from utils/step-ledger-double.ts",
    ).toEqual([]);
  });
});
