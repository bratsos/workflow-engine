# Annotations — first-class provenance

**Available from v0.8.0.** First-class API for attaching typed key-value facts to runs and stages, so future agents can read a run's history coherently. Inspired by OpenTelemetry semantic conventions.

## When to use

- **Trigger context** at `run.create`: who/what initiated the run, parent runs, source system.
- **Decision records** inside a stage: outcomes, rationales, evidence, alternatives.
- **Approvals and reviews**: post-hoc human sign-off, plugin-attributed events.
- **Anything you'd later want to query by stable key.**

## When *not* to use

- **Time-ordered narrative logs**: use `ctx.log(...)`. Annotations are key-addressable; logs are time-ordered.
- **State transitions**: the kernel emits `stage:started`/`completed`/`failed` events automatically. Don't duplicate them.
- **Large rich blobs**: put queryable scalars in `attributes`, attach the blob via the `payload` slot.

## Three call forms

```ts
// 1. TypedKey form — value type checked against the convention
import { Decision } from "@bratsos/workflow-engine/conventions";

ctx.annotate(Decision.outcome, "low");
ctx.annotate(Decision.confidence, 0.42);
ctx.annotate(Decision.confidence, "high"); // ❌ TS error — expected number

// 2. String key form — escape hatch for custom org keys
ctx.annotate("acme.compliance.signoff", "alice@acme.com");

// 3. Batch form — shared envelope for many attributes
ctx.annotate({
  actor: { kind: "agent", id: "triage-v3", version: "3.0.1" },
  attributes: {
    "decision.outcome": "low",
    "decision.rationale": "AI confidence below threshold",
    "decision.confidence": 0.42,
    "decision.alternatives": ["low", "medium", "high"],
    "decision.used_fallback": true,
  },
  payload: { fullModelResponse: { /* opt-in rich blob */ } },
  idempotencyKey: "decision-stage-1-attempt-0",
});
```

All three return `void` — writes are buffered and flushed atomically with the stage outcome. `undefined` values are dropped silently (OTel pattern: `ctx.annotate("x.id", maybeId)` is safe without guards).

## At run creation

```ts
await kernel.dispatch({
  type: "run.create",
  workflowId: "ticket-triage",
  input: { ticket },
  annotations: [
    {
      actor: { kind: "system", id: "zendesk-integration" },
      attributes: {
        "trigger.source": "webhook:zendesk",
        "trigger.parent_run_id": previousRunId,
        "trigger.reason": "auto-triage on ticket create",
      },
    },
  ],
});
```

Annotations land in the same transaction as `createRun`. If creation fails, no annotations persist.

## External attach (plugins, post-hoc reviews)

```ts
await kernel.annotations.attach(workflowRunId, {
  actor: { kind: "user", id: "alice@acme.com" },
  attributes: { "review.disposition": "approved-anyway" },
  scope: "run",       // default
  idempotencyKey: "review-2026-05-24-alice",
});
```

Single atomic transaction. With `idempotencyKey`, retries on the same `(runId, key, idempotencyKey)` are silently deduped.

## Query API

```ts
// Everything attached to a run, ordered by createdAt then id
await kernel.annotations.list(runId);

// Filters (all AND-combined)
await kernel.annotations.list(runId, {
  key: "decision.outcome",        // exact key
  keyPrefix: "decision.",          // namespace prefix (uses index on Postgres)
  scope: "stage",                  // "run" | "stage" | custom
  scopeId: "classify-urgency",
  actorId: "triage-v3",
  actorKind: "agent",
  attempt: 0,
  since: new Date("2026-05-20T00:00:00Z"),
  until: new Date("2026-05-25T00:00:00Z"),
  limit: 100,                      // default 1000
});
```

### Cross-DB notes

- **Postgres**: `keyPrefix` uses the `(workflowRunId, key)` btree index (LIKE 'prefix.%' range scan).
- **SQLite**: same query path; `LIKE` is case-insensitive by default and may scan at scale. The engine convention is lowercase keys, which keeps the scan fast for small-to-mid datasets. For high-volume SQLite, consider Postgres.

Value content is never queryable via the persistence port — only by key. If you need indexed value filtering for a specific attribute, extract that column in your own schema.

## Conventions catalog (v0.8)

Importable from `@bratsos/workflow-engine/conventions`. All `stable` unless noted.

### `Trigger.*`

What initiated the run. Attach at `run.create`.

| Key | Value type | Description |
|---|---|---|
| `trigger.source` | `string` | What system or path initiated the run, e.g. `"webhook:zendesk"`, `"manual:cli"`, `"schedule:cron"` |
| `trigger.parent_run_id` | `string` | Run ID of the prior run when this is a follow-up |
| `trigger.reason` | `string` | Free-text rationale for triggering this run |
| `trigger.actor.kind` | `string` | Recommended: `"user"` / `"agent"` / `"system"`. Open string. |
| `trigger.actor.id` | `string` | Stable identifier for the triggering actor |

### `Decision.*`

Choices made during execution. Attach from inside a stage.

| Key | Value type | Description |
|---|---|---|
| `decision.outcome` | `unknown` | The chosen outcome. Consumer-defined shape. |
| `decision.rationale` | `string` | Human-readable reason |
| `decision.confidence` | `number` | Confidence score, typically 0–1 |
| `decision.alternatives` | `unknown[]` | Alternatives that were considered but not selected |
| `decision.used_fallback` | `boolean` | Whether a fallback heuristic was used (experimental) |

### `Approval.*`

Sign-off events. Pluralization rule: `approvers` is always an array.

| Key | Value type | Description |
|---|---|---|
| `approval.approvers` | `string[]` | All approvers; always an array, `["alice"]` for one |
| `approval.timestamp` | `string` | ISO 8601 timestamp |
| `approval.policy.version` | `string` | Policy version (experimental) |

### `Revision.*`

This run as a revision of a prior run.

| Key | Value type | Description |
|---|---|---|
| `revision.previous_run_id` | `string` | Run ID this revision supersedes |
| `revision.reason` | `string` | Why this revision was created |

## Naming rules for custom keys

- Lowercase, dot-delimited segments, underscores within a segment OK.
- Org-prefixed for custom keys: `acme.compliance.signoff`, not `compliance.signoff`.
- Pluralization rule (OTel): singular name = scalar value; plural name = array value. So `approval.approvers: string[]` always, even with one approver.
- Three-segment structure preferred: `namespace.noun.qualifier`.

## Migration from `WorkflowRun.metadata`

The `metadata` parameter on `RunCreateCommand` is `@deprecated` in 0.8 and will be removed in 1.0. Existing rows with `WorkflowRun.metadata` populated are automatically projected as virtual `legacy.metadata.*` annotations when you call `kernel.annotations.list(runId)`:

```ts
// Run was created with:
//   metadata: { tenantId: "acme", source: "webhook" }

await kernel.annotations.list(runId);
// → [
//     { key: "legacy.metadata.source", value: "webhook", scope: "run", ... },
//     { key: "legacy.metadata.tenantId", value: "acme", scope: "run", ... },
//   ]
```

No dual-write — the column remains source of truth for legacy rows. If you want to explicitly migrate a row, attach the keys yourself and the shim stops projecting:

```ts
await kernel.annotations.attach(runId, {
  attributes: { "legacy.metadata.tenantId": "acme" },
});
```

## Annotation vs log vs outbox — decision matrix

A fresh agent dropped into a workflow will mis-classify if they don't internalize this:

| You want to record... | Use | Why |
|---|---|---|
| Time-ordered narrative for debugging | `ctx.log("INFO", "msg", { meta })` | Logs are streams; `metadata` is per-line context, not indexed by key |
| A state transition (started/completed/failed/suspended) | Don't — kernel emits the outbox event for you | Don't duplicate kernel-emitted facts |
| A decision the agent made (outcome, rationale, evidence, alternatives) | `ctx.annotate(Decision.*, ...)` | Key-addressable, queryable across runs, atomic with stage outcome |
| Who/what triggered the run | `run.create` with `annotations: [{ "trigger.*": ... }]` | Atomic with run creation, queryable later |
| Post-hoc human action on a run (approval, override, review note) | `kernel.annotations.attach(...)` | Single transaction, idempotent retries |
| The actual stage output (what downstream stages consume) | `return { output: ... }` | Outputs are the contract between stages; annotations are out-of-band |
| Large blob (full model response, debug trace) | `ctx.annotate({ attributes, payload: { ... } })` | `payload` is not indexed but lives alongside the queryable attributes |
| A workflow-level artifact (file, embedding, generated content) | `ctx.storage.save(key, data)` | Artifacts live in the BlobStore; annotations are for labels/facts about them |

**Rule of thumb**: if you'd want to filter or query by it across runs, it's an annotation. If it's a story being told in order, it's a log. If it's a state transition, the kernel handles it.

## Query patterns

These are the queries most consumers and future agents actually want to run.

### Timeline reconstruction — "what happened in this run, in order?"

```ts
const timeline = await kernel.annotations.list(runId);
// Already sorted by createdAt then id — stable across calls.

for (const a of timeline) {
  console.log(
    `[${a.createdAt.toISOString()}] ` +
    `${a.actorKind ?? "?"}:${a.actorId ?? "?"} → ` +
    `${a.key} = ${JSON.stringify(a.value)}`,
  );
}
```

### Decision audit — "what decisions did the triage agent make?"

```ts
const decisions = await kernel.annotations.list(runId, {
  keyPrefix: "decision.",
  actorId: "triage-agent",
});
```

### Who-did-what across one run

```ts
const trail = await kernel.annotations.list(runId, {
  actorId: "compliance-agent-v2",
});
// Group by stage:
const byStage = new Map<string, typeof trail>();
for (const a of trail) {
  const k = a.scopeId ?? "<run>";
  byStage.set(k, [...(byStage.get(k) ?? []), a]);
}
```

### Walking a chain of runs via `trigger.parent_run_id`

```ts
async function findChainRoot(runId: string): Promise<string> {
  const trigger = await kernel.annotations.list(runId, {
    key: "trigger.parent_run_id",
    limit: 1,
  });
  const parent = trigger[0]?.value as string | undefined;
  return parent ? findChainRoot(parent) : runId;
}
```

### Recent annotations only

```ts
const lastHour = await kernel.annotations.list(runId, {
  since: new Date(Date.now() - 60 * 60 * 1000),
});
```

## Patterns for structured decision provenance

The minimal-but-useful "decision" annotation shape, derived from agent-orchestration use cases:

```ts
ctx.annotate({
  actor: { kind: "agent", id: "triage", version: "v3" },
  attributes: {
    "decision.outcome": chosen,                     // the answer
    "decision.rationale": explanation,              // why
    "decision.confidence": score,                   // 0–1
    "decision.alternatives": alternativesConsidered,// what else was on the table
    "decision.used_fallback": ranKeywordFallback,   // did we use the primary signal?
  },
  payload: {
    rawAIResponse: fullModelOutput,                  // the evidence
  },
});
```

Why each field earns its place:
- `outcome`: queryable. Lets you ask "how many runs decided X?"
- `rationale`: human-readable; what a human reviewer or future agent reads first.
- `confidence`: lets you find low-confidence decisions to spot-check.
- `alternatives`: makes the decision space visible — "we considered X, picked Y." Plural per OTel rule.
- `used_fallback`: cheap boolean for filtering all fallback paths.
- `payload.rawAIResponse`: the evidence trail without polluting the queryable layer.

## Testing annotations

The in-memory persistence adapter exposes a test helper for asserting on writes:

```ts
import { InMemoryWorkflowPersistence } from "@bratsos/workflow-engine/testing";

const persistence = new InMemoryWorkflowPersistence();
// ... drive your workflow ...

const annotations = persistence.getAllAnnotations();
expect(annotations).toContainEqual(
  expect.objectContaining({
    key: "decision.outcome",
    value: "low",
    scope: "stage",
    scopeId: "classify-urgency",
  }),
);
```

Or via the public query API:

```ts
const decisions = await kernel.annotations.list(runId, {
  keyPrefix: "decision.",
});
expect(decisions).toHaveLength(3);
```

Annotations are flushed inside the stage-completion transaction. In tests this means: after `kernel.dispatch({ type: "job.execute", ... })` returns, all annotations written via `ctx.annotate` are persisted and queryable.

## Common pitfalls

### Don't put high-cardinality values in keys

```ts
// ❌ Wrong — every unique run gets its own key
ctx.annotate(`decision.outcome.${runId}`, "low");

// ✅ Right — the key is stable; the value carries the variance
ctx.annotate("decision.outcome", "low");
```

The unique constraint and `(workflowRunId, key)` index only help when keys repeat. A key per run defeats the design.

### Don't annotate state transitions

```ts
// ❌ Wrong — kernel already emits this as an outbox event
ctx.annotate("stage.completed", true);

// ✅ Right — annotate the *content* of what was decided, not the fact that the stage ran
ctx.annotate("decision.outcome", "low");
```

`stage:started` / `stage:completed` / `stage:failed` / `stage:suspended` are kernel-emitted outbox events. Duplicating them in annotations clutters queries.

### Don't write annotations from outside the kernel's transactional boundary

```ts
// ❌ Wrong — bypasses transactional semantics, no atomicity with stage outcome
await persistence.appendAnnotations([{ ... }]);

// ✅ Right — let the kernel handle it
ctx.annotate(...);
// or for plugin / external attach:
await kernel.annotations.attach(runId, { ... });
```

Calling `persistence.appendAnnotations` directly bypasses the buffer-and-flush guarantee. Annotations could persist while the stage rolls back, or vice versa.

### Don't use `value` as a blob slot

```ts
// ❌ Wrong — defeats key-prefix querying, breaks cross-DB indexing
ctx.annotate("decision", {
  outcome: "low",
  evidence: { /* large nested object */ },
});

// ✅ Right — scalars in `value`, blobs in `payload`
ctx.annotate({
  attributes: {
    "decision.outcome": "low",
  },
  payload: { evidence: { /* large nested object */ } },
});
```

The `value` column is indexed and meant for scalars/arrays. The `payload` column is the explicit blob slot.

### Don't use `idempotencyKey` for stage-scope annotations

```ts
// ❌ Unnecessary — stage annotations are already atomic with stage outcome
ctx.annotate({
  attributes: { "decision.outcome": "low" },
  idempotencyKey: "stage-1-decision",  // redundant; stage outcome handles it
});

// ✅ Right — reserve idempotencyKey for external attach and run.create
await kernel.annotations.attach(runId, {
  attributes: { "review.disposition": "approved" },
  idempotencyKey: "review-2026-05-24-alice",
});
```

The buffer-and-flush model makes stage-scope writes inherently atomic. Idempotency keys are for retry-prone *external* paths.

## Best practices

- **Use TypedKeys for well-known concepts**: `ctx.annotate(Decision.outcome, ...)` beats `ctx.annotate("decision.outcome", ...)` because the value type is checked and typos are caught at compile time.
- **Prefer scalars and scalar arrays in `attributes`**: they're indexable and queryable. Use the `payload` slot for rich blobs.
- **Set `actor` on every annotation**: the future agent reading this should know who recorded it.
- **Org-prefix custom keys**: `acme.compliance.signoff`, not `compliance.signoff`. Prevents accidental collisions with future engine conventions.
- **Use `idempotencyKey` for retry-sensitive paths**: external attach calls especially. Stage-scope annotations don't need it.
- **Don't annotate state transitions**: the kernel emits outbox events for those.
- **Keep per-stage annotation counts modest**: a chatty agent writing 100+ annotations per stage will fan out 100+ rows per execution. Aim for a small set of high-signal facts, not full traces.
- **Use logs for narrative, annotations for facts**: if it has a timestamp and reads as a sentence, it's a log. If it has a key and a typed value, it's an annotation.

## Reruns and the `attempt` axis

`run.rerunFrom` recreates stage records at and after the target group. The engine assigns the new stage records a fresh `attempt` value (one higher than the max attempt across the deleted stages), and `ctx.annotate(...)` inherits that value for the new annotations. Annotations from the prior attempt survive (the FK to the deleted stage record is `SetNull`, preserving the row with its original `attempt` value).

This means a single run's annotations can carry multiple `attempt` values, distinguishing decisions made on different runs of the same logical stage. Filter by `attempt` to look at just one attempt:

```ts
// Just the most recent attempt
const latestAttempt = await kernel.annotations.list(runId, { attempt: 1 });

// All attempts in chronological order
const allAttempts = await kernel.annotations.list(runId, { keyPrefix: "decision." });
```

## Outbox emission (opt-in)

By default, writing an annotation does **not** emit an outbox event. If a plugin or external system needs push notifications on annotation writes (audit pipelines, SIEM, live dashboards), set `emitEvent: true` and the engine writes an `annotation:created` outbox event in the same transaction as the annotation row.

**Caveat when combining `emitEvent` with `idempotencyKey`:** the engine skips duplicate `(workflowRunId, key, idempotencyKey)` rows under the unique constraint, but emits one `annotation:created` event per input regardless. On a retry with the same idempotency key, the row is deduplicated (correct) but the event fires again. If your downstream consumer cares about exactly-once delivery, dedupe events on `(causationId, key)` or use a stable identifier in the event payload — don't assume one event per persisted row.

```ts
// Stage-scope
ctx.annotate("decision.outcome", "low", { emitEvent: true });

// Batch
ctx.annotate({
  attributes: { "approval.approvers": ["alice", "bob"] },
  emitEvent: true,
});

// External attach
await kernel.annotations.attach(runId, {
  attributes: { "review.disposition": "approved" },
  emitEvent: true,
});

// At run.create
annotations: [{
  attributes: { "trigger.source": "webhook" },
  emitEvent: true,
}]
```

Subscribe via the existing event sink (the kernel routes `annotation:created` events through the same outbox machinery as `stage:completed` etc.):

```ts
const plugin = definePlugin({
  id: "annotation-audit",
  name: "Annotation Audit",
  on: ["annotation:created"],
  async handle(event) {
    // event.key, event.value, event.scope, event.actorId, etc.
  },
});
```

Keep emission off for high-volume runs — every emit-on annotation is one outbox row to flush.

## Cancellation safety

When `run.cancel` commits **before** a stage's Phase 3 (or Phase 2 suspended-poll) transaction begins, the transaction reads the cancelled status from the run, throws, and rolls back atomically — the stage's annotations, status update, and outbox events all roll back together. This closes the common race window where cancel had clearly committed first but the stage was still mid-flight.

There is a residual narrow window where cancel commits **after** the transaction's status check but **before** the transaction commits. Under standard READ COMMITTED isolation the status check is not a row lock, so a concurrent cancel can still slip through that gap. The window is small (microseconds inside a transaction) and applies equally to all Phase 3 writes (stage status, outbox events, annotations) — annotations don't introduce the race, they just inherit it. A future engine release may close this fully via `SELECT ... FOR UPDATE` or coordinated optimistic locking; for now consumers who need stronger cancel atomicity should rely on the kernel's existing ghost-job detection downstream.
