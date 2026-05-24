# `@bratsos/workflow-engine/conventions`

Well-known annotation keys for the workflow engine. Inspired by OpenTelemetry semantic conventions: structure lives in dot-namespaced keys, value types are linked to keys via TypeScript phantom-type inference.

The engine itself does not import this module. Conventions are **opinions**; the engine is **plumbing**. Consumers opt in by importing typed keys for compile-time autocomplete and value-type checking; anything outside the published set still works as a free-form string key.

## Usage

```ts
import { Trigger, Decision } from "@bratsos/workflow-engine/conventions";

// Type-checked: value must match the TypedKey<T> parameter.
ctx.annotate(Decision.outcome, "low");
ctx.annotate(Decision.confidence, 0.42);
ctx.annotate(Decision.confidence, "high"); // ❌ TS error

// Custom org-defined keys keep working with the string form:
ctx.annotate("acme.compliance.signoff", "alice@acme.com");
```

## Naming rules

- **Lowercase, dot-delimited segments.** Underscores are allowed within a segment.
- **Three-segment structure preferred**: `namespace.noun.qualifier`.
  - `trigger.source`, `decision.rationale`, `approval.policy.version`.
- **Pluralization rule** (from OTel): if a key can hold multiple entities, the name is **plural** and the value type is **always an array**, even with one item.
  - `approval.approvers: string[]` — never `approval.approver: string | string[]`.
- **Custom keys must be org-prefixed**: `acme.compliance.signoff`, not `compliance.signoff`. This keeps the engine's namespace clean and avoids accidental collisions.

## Value types

For well-known keys, prefer **scalars** (`string`, `number`, `boolean`) or **scalar arrays**. These are queryable, indexable, and cross-DB-friendly.

For rich blobs (full model responses, debug traces, large structured artifacts), use the separate `payload` slot on `ctx.annotate`:

```ts
ctx.annotate({
  attributes: {
    "decision.outcome": "low",
    "decision.confidence": 0.42,
  },
  payload: {
    fullModelResponse: { /* large object */ },
    debugTrace: [/* ... */],
  },
});
```

The `payload` slot is not queryable by key prefix, but it's a clean place to attach evidence without polluting the indexed value column.

## Stability policy

Each typed key carries a `stability` marker:

- `stable` — committed for the major version. Will not be renamed or have its value type changed.
- `experimental` — usable, but the shape may change in a future minor release.
- `deprecated` — kept working, marked `@deprecated` in JSDoc; will be removed in a future major version.

**Once a key is `stable`, it is immutable.** Renames and value-type changes ship as **new keys**; the old key gets a `@deprecated` JSDoc tag and a pointer to the replacement.

We deliberately do **not** copy OpenTelemetry's `OTEL_SEMCONV_STABILITY_OPT_IN` env-var dance — it's universally disliked in the OTel ecosystem. Versioning is handled through semver and JSDoc.

## Extending

If your organization needs a stable internal convention, define your own typed keys in your own codebase:

```ts
// your-org/src/conventions.ts
import { typedKey } from "@bratsos/workflow-engine/conventions";

export const Compliance = {
  signoff: typedKey<string>("acme.compliance.signoff"),
  reviewLevel: typedKey<"low" | "medium" | "high">("acme.compliance.review_level"),
};
```

Same TypedKey contract, same value-type inference, same `ctx.annotate(key, value)` ergonomics. No need to fork the conventions module.

## Adding to the engine's published set

If a convention is broadly useful across consumers (think: `trigger.*`, `decision.*`), open a PR proposing it for `@bratsos/workflow-engine/conventions`. Criteria:

- Solves a real, recurring use case (one consumer's quirk doesn't qualify).
- Doesn't overlap with an existing key.
- Has a clear value type and pluralization decision.
- Includes a one-line description suitable for IDE hover.

New keys start as `experimental` and graduate to `stable` after a minor-version cycle.
