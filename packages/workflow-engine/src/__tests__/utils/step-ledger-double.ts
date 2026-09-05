/**
 * The one way to build a `StepLedger` test double.
 *
 * Several tests need a ledger that behaves like `InMemoryStepLedger` except
 * for one method — a `claim` that crashes once, a `get` that returns a
 * stale row, a `compareAndSet` that throws. They used to spell that as an
 * object literal forwarding every method by hand, and when the port grew
 * the optional `clearExcept` those literals silently dropped it: the kernel
 * saw a ledger with no partial clear and took its fallback path, so tests
 * meant to cover the real implementation covered the fallback instead, and
 * nothing said so.
 *
 * `wrapStepLedger` forwards from a single list of the port's methods, and
 * that list is checked against `keyof StepLedger` at compile time. Adding a
 * method to the port without adding it here fails the typecheck; every
 * double built through this helper then gets it for free.
 *
 * New `StepLedger` doubles in tests must be built with this rather than as
 * bare object literals — `conventions/step-ledger-double.test.ts` enforces
 * it.
 */

import type { StepLedger } from "../../kernel/ports.js";

/** Every method of the `StepLedger` port, optional ones included. */
export const STEP_LEDGER_METHODS = [
  "claim",
  "get",
  "update",
  "compareAndSet",
  "list",
  "clear",
  "clearExcept",
] as const satisfies readonly (keyof StepLedger)[];

/** Fails to compile while a `StepLedger` method is missing from the list. */
type AssertNever<T extends never> = T;
type _EveryMethodListed = AssertNever<
  Exclude<keyof StepLedger, (typeof STEP_LEDGER_METHODS)[number]>
>;

/**
 * A `StepLedger` that delegates to `inner`, with `overrides` replacing the
 * methods a test wants to bend.
 *
 * An optional method the inner ledger does not implement stays absent, so a
 * test can still model a ledger without one; passing it explicitly in
 * `overrides` adds it, and passing `undefined` removes it.
 */
export function wrapStepLedger(
  inner: StepLedger,
  overrides: Partial<StepLedger> = {},
): StepLedger {
  const wrapper: Record<string, unknown> = {};
  for (const name of STEP_LEDGER_METHODS) {
    if (Object.hasOwn(overrides, name)) {
      const override = overrides[name];
      if (override !== undefined) wrapper[name] = override;
      continue;
    }
    const method = inner[name];
    if (typeof method !== "function") continue;
    wrapper[name] = (...args: unknown[]) =>
      (method as (...a: unknown[]) => unknown).apply(inner, args);
  }
  return wrapper as unknown as StepLedger;
}
