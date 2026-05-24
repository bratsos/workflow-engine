/**
 * Tests for the @bratsos/workflow-engine/conventions module.
 *
 * Locks in the public contract that the migration guide and reference
 * docs depend on: well-known key strings, stability markers, and the
 * shape of `typedKey()`. Failures here mean a consumer's code or the
 * documented conventions catalog have drifted.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  Approval,
  Decision,
  Revision,
  Trigger,
  type TypedKey,
  typedKey,
} from "../../conventions/index.js";

describe("conventions: typedKey() helper", () => {
  it("returns the right shape for a minimal call", () => {
    const k = typedKey<string>("acme.thing");
    expect(k.key).toBe("acme.thing");
    expect(k.stability).toBe("experimental");
    expect(k.description).toBeUndefined();
  });

  it("respects explicit stability and description", () => {
    const k = typedKey<number>("acme.confidence", {
      stability: "stable",
      description: "How confident the agent was, 0–1.",
    });
    expect(k.key).toBe("acme.confidence");
    expect(k.stability).toBe("stable");
    expect(k.description).toBe("How confident the agent was, 0–1.");
  });

  it("accepts the three stability levels", () => {
    expect(typedKey<string>("a", { stability: "stable" }).stability).toBe(
      "stable",
    );
    expect(typedKey<string>("a", { stability: "experimental" }).stability).toBe(
      "experimental",
    );
    expect(typedKey<string>("a", { stability: "deprecated" }).stability).toBe(
      "deprecated",
    );
  });

  it("type-checks the value parameter via TypedKey<T>", () => {
    // Compile-time assertions — value-type linkage is the whole point of
    // typedKey<T>(). These fail at typecheck if the inference breaks.
    const stringKey = typedKey<string>("x.string");
    const numberKey = typedKey<number>("x.number");
    const arrayKey = typedKey<string[]>("x.array");

    expectTypeOf(stringKey).toEqualTypeOf<TypedKey<string>>();
    expectTypeOf(numberKey).toEqualTypeOf<TypedKey<number>>();
    expectTypeOf(arrayKey).toEqualTypeOf<TypedKey<string[]>>();
  });
});

describe("conventions: Trigger namespace", () => {
  it("exports the documented keys with the documented string values", () => {
    expect(Trigger.source.key).toBe("trigger.source");
    expect(Trigger.parentRunId.key).toBe("trigger.parent_run_id");
    expect(Trigger.reason.key).toBe("trigger.reason");
    expect(Trigger.actorKind.key).toBe("trigger.actor.kind");
    expect(Trigger.actorId.key).toBe("trigger.actor.id");
  });

  it("marks all Trigger keys as stable", () => {
    expect(Trigger.source.stability).toBe("stable");
    expect(Trigger.parentRunId.stability).toBe("stable");
    expect(Trigger.reason.stability).toBe("stable");
    expect(Trigger.actorKind.stability).toBe("stable");
    expect(Trigger.actorId.stability).toBe("stable");
  });

  it("includes IDE-hover descriptions", () => {
    expect(Trigger.source.description).toBeTruthy();
    expect(Trigger.parentRunId.description).toBeTruthy();
    expect(Trigger.reason.description).toBeTruthy();
  });
});

describe("conventions: Decision namespace", () => {
  it("exports the documented keys with the documented string values", () => {
    expect(Decision.outcome.key).toBe("decision.outcome");
    expect(Decision.rationale.key).toBe("decision.rationale");
    expect(Decision.confidence.key).toBe("decision.confidence");
    expect(Decision.alternatives.key).toBe("decision.alternatives");
    expect(Decision.usedFallback.key).toBe("decision.used_fallback");
  });

  it("marks stable Decision keys as stable and experimental ones as experimental", () => {
    // Stable contract (no rename or value-type change without major bump):
    expect(Decision.outcome.stability).toBe("stable");
    expect(Decision.rationale.stability).toBe("stable");
    expect(Decision.confidence.stability).toBe("stable");
    expect(Decision.alternatives.stability).toBe("stable");
    // Still experimental in 0.8:
    expect(Decision.usedFallback.stability).toBe("experimental");
  });

  it("locks the value-type contracts via expectTypeOf", () => {
    // These are the type guarantees the migration doc advertises.
    expectTypeOf(Decision.outcome).toEqualTypeOf<TypedKey<unknown>>();
    expectTypeOf(Decision.rationale).toEqualTypeOf<TypedKey<string>>();
    expectTypeOf(Decision.confidence).toEqualTypeOf<TypedKey<number>>();
    expectTypeOf(Decision.alternatives).toEqualTypeOf<TypedKey<unknown[]>>();
    expectTypeOf(Decision.usedFallback).toEqualTypeOf<TypedKey<boolean>>();
  });
});

describe("conventions: Approval namespace", () => {
  it("exports the documented keys with the documented string values", () => {
    expect(Approval.approvers.key).toBe("approval.approvers");
    expect(Approval.timestamp.key).toBe("approval.timestamp");
    expect(Approval.policyVersion.key).toBe("approval.policy.version");
  });

  it("uses an array type for the plural `approvers` field (OTel pluralization rule)", () => {
    // This is the load-bearing claim that solves the "what if multiple
    // approvers" question without ever predicting the payload shape.
    expectTypeOf(Approval.approvers).toEqualTypeOf<TypedKey<string[]>>();
    expectTypeOf(Approval.timestamp).toEqualTypeOf<TypedKey<string>>();
    expectTypeOf(Approval.policyVersion).toEqualTypeOf<TypedKey<string>>();
  });

  it("marks Approval keys by stability level", () => {
    expect(Approval.approvers.stability).toBe("stable");
    expect(Approval.timestamp.stability).toBe("stable");
    expect(Approval.policyVersion.stability).toBe("experimental");
  });
});

describe("conventions: Revision namespace", () => {
  it("exports the documented keys with the documented string values", () => {
    expect(Revision.previousRunId.key).toBe("revision.previous_run_id");
    expect(Revision.reason.key).toBe("revision.reason");
  });

  it("marks Revision keys as stable", () => {
    expect(Revision.previousRunId.stability).toBe("stable");
    expect(Revision.reason.stability).toBe("stable");
  });
});

describe("conventions: compile-time value-type enforcement", () => {
  // These tests run at typecheck-time. A `@ts-expect-error` on a line
  // that does NOT error fails tsc with "unused @ts-expect-error" —
  // so removing one of the type guarantees here will break the build.
  //
  // The shape mirrors how `ctx.annotate` accepts a TypedKey: the value
  // parameter must match T. We test against a stand-in function with
  // the same generic signature instead of constructing a real
  // StageContext.

  function fakeAnnotate<T>(_key: TypedKey<T>, _value: T): void {
    // intentionally empty — typecheck-only
  }

  it("accepts correctly-typed values for TypedKey<T>", () => {
    fakeAnnotate(Decision.confidence, 0.42);
    fakeAnnotate(Decision.rationale, "AI confidence below threshold");
    fakeAnnotate(Decision.usedFallback, true);
    fakeAnnotate(Approval.approvers, ["alice", "bob"]);
    fakeAnnotate(Trigger.source, "webhook:zendesk");
    expect(true).toBe(true); // runtime no-op; the assertion lives in types
  });

  it("rejects wrong-typed values at compile time", () => {
    // @ts-expect-error — confidence is TypedKey<number>, not string
    fakeAnnotate(Decision.confidence, "high");

    // @ts-expect-error — rationale is TypedKey<string>, not number
    fakeAnnotate(Decision.rationale, 42);

    // @ts-expect-error — usedFallback is TypedKey<boolean>, not string
    fakeAnnotate(Decision.usedFallback, "yes");

    // @ts-expect-error — approvers is TypedKey<string[]>, not string
    fakeAnnotate(Approval.approvers, "alice");

    // @ts-expect-error — actorKind is TypedKey<string>, not boolean
    fakeAnnotate(Trigger.actorKind, true);

    expect(true).toBe(true);
  });

  it("treats Decision.outcome as TypedKey<unknown> so any value is accepted", () => {
    // `outcome` is intentionally `unknown` because the chosen answer is
    // domain-specific. This must NOT regress to a narrower type.
    fakeAnnotate(Decision.outcome, "low");
    fakeAnnotate(Decision.outcome, 42);
    fakeAnnotate(Decision.outcome, { custom: "shape" });
    fakeAnnotate(Decision.outcome, ["multi", "value"]);
    expect(true).toBe(true);
  });

  it("does not allow TypedKey<string> to be assigned to TypedKey<number>", () => {
    // Variance check: TypedKey<T> must NOT be bivariant in T, otherwise
    // the value-type guarantee becomes meaningless.
    expectTypeOf<TypedKey<string>>().not.toMatchTypeOf<TypedKey<number>>();
    expectTypeOf<TypedKey<number>>().not.toMatchTypeOf<TypedKey<string>>();
  });
});

describe("conventions: cross-namespace invariants", () => {
  it("uses lowercase-dot-namespacing for every key", () => {
    const allKeys = [
      ...Object.values(Trigger).map((k) => k.key),
      ...Object.values(Decision).map((k) => k.key),
      ...Object.values(Approval).map((k) => k.key),
      ...Object.values(Revision).map((k) => k.key),
    ];

    for (const key of allKeys) {
      // Must be lowercase, dot-delimited, allowed underscores within segments.
      expect(key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });

  it("does not collide with the legacy.metadata.* shim namespace", () => {
    const allKeys = [
      ...Object.values(Trigger).map((k) => k.key),
      ...Object.values(Decision).map((k) => k.key),
      ...Object.values(Approval).map((k) => k.key),
      ...Object.values(Revision).map((k) => k.key),
    ];
    for (const key of allKeys) {
      expect(key.startsWith("legacy.metadata.")).toBe(false);
    }
  });

  it("has no duplicate key strings across namespaces", () => {
    const allKeys = [
      ...Object.values(Trigger).map((k) => k.key),
      ...Object.values(Decision).map((k) => k.key),
      ...Object.values(Approval).map((k) => k.key),
      ...Object.values(Revision).map((k) => k.key),
    ];
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });
});
