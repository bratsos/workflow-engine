# Migrating from 0.7 to 0.8

## Summary

`0.8.0` introduces **annotations** — a first-class, queryable surface for attaching provenance to workflow runs and stages. It replaces the ad-hoc pattern of stuffing context into `WorkflowRun.metadata`, with a uniform attach/query API inspired by OpenTelemetry semantic conventions. No breaking API changes; the only deprecation is the existing `WorkflowRun.metadata` field, which still works in 0.8.

If you don't use `WorkflowRun.metadata` and don't care about provenance recording, you can upgrade with **only the schema migration step** below — everything else is opt-in.

## Notes on conventions

- **Scalar / array value convention is documented, not enforced.** The `value` column accepts any JSON. Nested objects work but are discouraged for well-known keys (they break `keyPrefix` query semantics). Use the `payload` slot for rich blobs.

## Required actions

### 1. Schema migration: add `WorkflowAnnotation` table

Add the following model to your Prisma schema:

```prisma
model WorkflowAnnotation {
  id                    String   @id @default(cuid())
  createdAt             DateTime @default(now())

  workflowRunId         String
  workflowRun           WorkflowRun     @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)

  workflowStageRecordId String?
  workflowStage         WorkflowStage?  @relation(fields: [workflowStageRecordId], references: [id], onDelete: SetNull)
  attempt               Int      @default(0)

  scope                 String
  scopeId               String?

  actorKind             String?
  actorId               String?
  actorVersion          String?

  key                   String
  value                 Json
  payload               Json?

  idempotencyKey        String?

  @@unique([workflowRunId, key, idempotencyKey])
  @@index([workflowRunId, key])
  @@index([workflowRunId, createdAt])
  @@index([workflowRunId, scope])
  @@index([workflowRunId, actorId])
}
```

You'll also need to add the back-relations to your existing models:

```prisma
model WorkflowRun {
  // ... existing fields ...
  annotations           WorkflowAnnotation[]
}

model WorkflowStage {
  // ... existing fields ...
  annotations           WorkflowAnnotation[]
}
```

Then run your migration:

```bash
# Postgres / SQLite via Prisma
pnpm prisma migrate dev --name add_workflow_annotations
```

### 2. (Drive-by) Add missing `metadata` column to `AICall` if you copied the README schema before 0.8

`0.8` ships a documentation fix: the `AICall` Prisma schema in earlier README versions omitted `metadata Json?`, even though the code wrote to it (since 0.5). If you copy-pasted that schema, your existing `AICall` rows are missing rich metadata (`temperature`, `finishReason`, `durationMs`, tool details, etc.).

Add the column:

```prisma
model AICall {
  // ... existing fields ...
  metadata      Json?
}
```

Then migrate:

```bash
pnpm prisma migrate dev --name aicall_add_metadata_column
```

Note: this is additive. Existing rows will have `null` metadata; new rows will be populated.

## New features

### Annotations: attach provenance from stages

Inside a stage's `execute()`, use `ctx.annotate()` to record decisions, observations, or anything else you want queryable later:

```ts
const classifyUrgency = defineStage({
  id: "classify-urgency",
  // ... schemas ...
  async execute(ctx) {
    const { object: ai } = await aiHelper.generateObject(...);

    const usedFallback = ai.confidence < 0.6;
    const urgency = usedFallback ? keywordHeuristic(ctx.input.text) : ai.urgency;

    ctx.annotate({
      actor: { kind: "agent", id: "triage-agent", version: "v3" },
      attributes: {
        "decision.outcome": urgency,
        "decision.rationale": usedFallback
          ? "AI confidence < 0.6 — fell back to keyword heuristic"
          : "AI classification accepted",
        "decision.confidence": ai.confidence,
        "decision.alternatives": ["low", "medium", "high"],
        "decision.used_fallback": usedFallback,
      },
    });

    return { output: { urgency } };
  },
});
```

Writes are **buffered and flushed atomically with the stage completion transaction** — if the stage fails, annotations recorded before the failure still persist; if a suspend/resume race rolls back the stage, annotations roll back too.

### Annotations: attach trigger context at `run.create`

```ts
await kernel.dispatch({
  type: "run.create",
  workflowId: "ticket-triage",
  input: { ticket },
  annotations: [{
    actor: { kind: "system", id: "zendesk-integration" },
    attributes: {
      "trigger.source": "webhook:zendesk",
      "trigger.parent_run_id": previousRunId,
      "trigger.reason": "auto-triage on ticket create",
    },
  }],
});
```

### Annotations: query later

```ts
// Everything attached to a run
const all = await kernel.annotations.list(runId);

// Just decisions
const decisions = await kernel.annotations.list(runId, { keyPrefix: "decision." });

// Just things a specific agent recorded
const trail = await kernel.annotations.list(runId, { actorId: "triage-agent" });

// Time-ranged
const recent = await kernel.annotations.list(runId, {
  since: new Date(Date.now() - 3600_000),
});
```

### Annotations: typed keys via the conventions module

```ts
import { Decision, Trigger } from "@bratsos/workflow-engine/conventions";

// Compile-time typo protection + value-type linkage
ctx.annotate(Decision.outcome.key, "low");          // ✅ value typed as JsonValue
ctx.annotate(Decision.confidence.key, 0.42);        // ✅ value typed as number
ctx.annotate(Decision.confidence.key, "high");      // ❌ type error — expected number

// Custom keys remain free-form
ctx.annotate("acme.compliance.signoff", "alice@acme.com");
```

The conventions module ships well-known keys for `Trigger.*`, `Decision.*`, `Approval.*`, `Revision.*`. See `references/10-annotations.md` for the full list and conventions for naming custom keys.

### Annotations: external attach (plugins, post-hoc reviews)

```ts
await kernel.annotations.attach(workflowRunId, {
  actor: { kind: "user", id: "alice@acme.com" },
  attributes: { "review.disposition": "approved-anyway" },
  idempotencyKey: "review-2026-05-24-alice",
});
```

### Annotations: rerun attempt disambiguation

`run.rerunFrom` now assigns a fresh `attempt` value to recreated stages. Annotations from the prior run survive (with their original `attempt`) and new annotations carry the new value, so a future agent can disambiguate decisions across rerun generations:

```ts
// First run → annotations with attempt=0
ctx.annotate(Decision.outcome, "low");

// After run.rerunFrom and re-execution → annotations with attempt=1
ctx.annotate(Decision.outcome, "high");

// Query just the latest attempt
await kernel.annotations.list(runId, { attempt: 1 });
```

### Annotations: opt-in outbox emission

When a plugin or external system wants real-time notifications on annotation writes (audit pipelines, SIEM, live dashboards), pass `emitEvent: true`. The engine writes an `annotation:created` outbox event in the same transaction as the annotation row, plugged into the same delivery machinery as `stage:completed` and friends. Off by default.

```ts
ctx.annotate("decision.outcome", "low", { emitEvent: true });
```

## Migrating from pre-0.8 provenance patterns

Annotations replace several ad-hoc patterns that 0.7-and-earlier consumers used to stuff "why" context into the engine. None of these patterns are removed in 0.8 — the migration is opportunistic, not forced. Move callsites as you touch them.

### Pattern: `ctx.log("INFO", "...", { decision: "low", confidence: 0.42 })` for decisions

**Before**: structured log entries served double duty as "what happened" and "what was decided."

```ts
// Pre-0.8
await ctx.log("INFO", "classified as low urgency", {
  confidence: 0.42,
  usedFallback: true,
});
```

**After**: keep logs for narrative; move structured facts to annotations.

```ts
// 0.8+
await ctx.log("INFO", "classified as low urgency");
ctx.annotate({
  attributes: {
    "decision.outcome": "low",
    "decision.confidence": 0.42,
    "decision.used_fallback": true,
  },
});
```

**Why**: logs are time-ordered narrative and aren't indexed by key. You can't ask "show me every decision in this run" via logs — you'd grep through `message` fields. Annotations are key-addressable and queryable across runs.

### Pattern: stuffing trigger context into `WorkflowRun.metadata`

**Before**: `metadata` was the only place to record who triggered the run.

```ts
// Pre-0.8
await kernel.dispatch({
  type: "run.create",
  ...,
  metadata: {
    triggeredBy: "alice",
    source: "webhook",
    parentRunId: "run_abc",
  },
});
```

**After**: use the `annotations` array.

```ts
// 0.8+
await kernel.dispatch({
  type: "run.create",
  ...,
  annotations: [{
    actor: { kind: "user", id: "alice" },
    attributes: {
      "trigger.source": "webhook",
      "trigger.parent_run_id": "run_abc",
    },
  }],
});
```

**Why**: the new path lands inside the same transaction as `createRun`, is queryable by key prefix (`trigger.*`), and the legacy `metadata` column is auto-projected as `legacy.metadata.*` until you migrate — no breakage.

### Pattern: stuffing decision context into stage `outputData`

**Before**: consumers sometimes mixed the stage's "real output" with decision metadata to avoid losing it.

```ts
// Pre-0.8 — output schema bloat
return {
  output: {
    urgency: "low",                          // the actual output
    _meta_aiConfidence: 0.42,                // hidden provenance
    _meta_usedFallback: true,
  },
};
```

**After**: clean output, annotations carry the "why."

```ts
// 0.8+
ctx.annotate({
  attributes: {
    "decision.outcome": "low",
    "decision.confidence": 0.42,
    "decision.used_fallback": true,
  },
});
return { output: { urgency: "low" } };
```

**Why**: stage output is the contract between stages. Polluting it with provenance creates schema noise, makes downstream stages care about things they shouldn't, and makes outputs hard to reuse across workflows. Annotations are out-of-band — downstream stages never see them.

### Pattern: using outbox `causationId` to trace cross-stage provenance

**Before**: consumers correlated outbox events by `causationId` to reconstruct what an agent decided.

**After**: keep outbox events for state transitions (`stage:started`/`completed`/`failed`) — they remain the source of truth for *what happened*. Use annotations for *why* it happened. The two layers compose: events tell you a stage completed; annotations tell you what the agent decided during that stage.

```ts
// 0.8+ — typical reconstruction query
const events = await persistence.getUnpublishedOutboxEvents(...);  // state transitions
const annotations = await kernel.annotations.list(runId);          // decisions/facts
// Join in your app code by stageId/scopeId.
```

### Pattern: `WorkflowArtifact.metadata` for non-output stage data

**Before**: consumers sometimes wrote small structured data to `WorkflowArtifact.metadata` to avoid the BlobStore round-trip.

**After**: artifacts remain the right place for *content* (large outputs, embeddings, model responses, debug traces). Annotations are for *labels and facts you'll query later*. If the data is small and you want it indexed by key, prefer annotations. If it's a blob you want attached to a specific artifact key, keep using `WorkflowArtifact`.

### Pattern: relying on `WorkflowLog.metadata` for queryable structured logging

**Before**: `WorkflowLog.metadata` is a Json column on each log entry. Consumers occasionally treated it as a searchable index.

**After**: `WorkflowLog.metadata` stays — it's intrinsic to the log entry, useful for debugging context attached to a specific log line. But it's not indexed by key, isn't cross-DB queryable, and shouldn't be used as a provenance store. If you find yourself querying log metadata to ask "what did this agent decide?", that's a sign to move it to annotations.

## Deprecations

### `WorkflowRun.metadata` is deprecated

The `metadata` parameter on `RunCreateCommand` is marked `@deprecated` in 0.8. It still works — and reading `WorkflowRun.metadata` from the database row still works — but new code should use the `annotations` array instead.

```ts
// Before (still works in 0.8, will be removed in 1.0)
await kernel.dispatch({
  type: "run.create",
  workflowId: "x",
  input: {...},
  metadata: { triggeredBy: "alice", source: "webhook" },
});

// After (recommended)
await kernel.dispatch({
  type: "run.create",
  workflowId: "x",
  input: {...},
  annotations: [{
    actor: { kind: "user", id: "alice" },
    attributes: { "trigger.source": "webhook" },
  }],
});
```

`kernel.annotations.list(runId)` automatically materializes legacy `metadata` as virtual `legacy.metadata.*` annotations in query results, so you can migrate reads incrementally.

#### Optional: eagerly migrate existing rows

For most consumers, the lazy read-shim above is sufficient — old rows surface as `legacy.metadata.*` on demand, no data migration required. If you operate at a volume where you'd rather drop the per-`list()` `getRun()` overhead, or you want to eventually remove the `metadata` column, you can copy existing rows into persisted annotations once.

There's no shipped utility for this — the right migration depends on what you put in `metadata` and whether you want to also re-key into proper conventions (`trigger.*`, `decision.*`, etc.). Below is a starting point you can adapt:

```ts
// One-time migration. Idempotent — safe to re-run on the same rows.
async function copyLegacyMetadataToAnnotations(
  kernel: Kernel,
  prisma: PrismaClient,
  batchSize = 100,
) {
  let migrated = 0;
  let skipped = 0;

  while (true) {
    const runs = await prisma.workflowRun.findMany({
      where: {
        metadata: { not: null },
        // Skip runs that already have legacy.metadata.* persisted
        annotations: { none: { key: { startsWith: "legacy.metadata." } } },
      },
      take: batchSize,
      select: { id: true, metadata: true },
    });
    if (runs.length === 0) break;

    for (const run of runs) {
      // Only object-shaped metadata can be projected to keys.
      // Primitives, arrays, and null are skipped.
      if (
        typeof run.metadata !== "object" ||
        run.metadata === null ||
        Array.isArray(run.metadata)
      ) {
        skipped++;
        continue;
      }

      const attributes: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(run.metadata)) {
        // OPTIONAL: replace this verbatim copy with your own mapping
        // — e.g., remap `metadata.user` → `trigger.actor.id` instead
        // of `legacy.metadata.user`. The library can't do this for you;
        // it depends on your domain.
        attributes[`legacy.metadata.${k}`] = v;
      }
      if (Object.keys(attributes).length === 0) {
        skipped++;
        continue;
      }

      await kernel.annotations.attach(run.id, {
        attributes,
        idempotencyKey: `legacy-migrate-${run.id}`,
      });
      migrated++;
    }
  }
  return { migrated, skipped };
}
```

Once a run has any persisted `legacy.metadata.*` annotation, the read-side shim stops synthesizing for that run — so this script must produce the complete set of keys per run, not a partial migration. If your `metadata` values are non-object (a string, number, or array), the script can't project them into keys; you'll need to handle those rows by hand or leave them on the column.

## Bug fixes

### Stage failure path now persists pre-failure side effects

Previously, if a stage threw an exception mid-execution, any `ctx.log(...)` calls made before the throw were preserved (fire-and-forget), but there was no mechanism for the stage to record *why* it was failing — the error message went only to `WorkflowStage.errorMessage`.

With annotations in 0.8, you can attribute structured failure context that persists in the failure transaction:

```ts
async execute(ctx) {
  try {
    return await doWork();
  } catch (err) {
    ctx.annotate({
      attributes: {
        "failure.kind": classifyError(err),
        "failure.retryable": isRetryable(err),
      },
    });
    throw err;
  }
}
```

The annotation is buffered before the throw and flushed in the failure-path transaction (Phase 3b in `job-execute.ts`).

### Cancellation tightened across stage Phase 3 transactions

Before 0.8, `run.cancel` could commit between the kernel's outer ghost check and a stage's Phase 3 transaction, letting stage updates and outbox events commit against an already-cancelled run. 0.8 adds an in-transaction status guard: if cancel committed before the Phase 3 transaction starts, the transaction throws and rolls back atomically (stage update + annotations + outbox events). Same protection added to the suspended-stage poll path. The race window is meaningfully narrower than before. A residual microsecond-scale window remains under READ COMMITTED isolation when cancel commits during the Phase 3 transaction itself — this is general engine behavior, not annotation-specific, and may be closed in a future release. No code change required.

### AICall metadata documentation gap fixed

The README's Prisma schema for `AICall` had been missing the `metadata` column since 0.5, even though the AI helper wrote to it. The documentation is now corrected. See the **Required actions** section above for the corresponding schema update.

## Code examples — common patterns

### Pattern: trigger annotation at the entrypoint of a chain of runs

```ts
async function rerunFromAlert(originalRunId: string, alertId: string) {
  return kernel.dispatch({
    type: "run.create",
    workflowId: "x",
    input: {...},
    annotations: [{
      actor: { kind: "system", id: "alerting" },
      attributes: {
        "trigger.source": "alert",
        "trigger.parent_run_id": originalRunId,
        "trigger.reason": `Alert ${alertId} detected anomaly`,
      },
    }],
  });
}

// Walk back the chain later
async function findChainRoot(runId: string): Promise<string> {
  const trigger = await kernel.annotations.list(runId, { keyPrefix: "trigger." });
  const parent = trigger.find(a => a.key === "trigger.parent_run_id")?.value as string | undefined;
  return parent ? findChainRoot(parent) : runId;
}
```

### Pattern: durable decision audit for compliance

```ts
ctx.annotate({
  actor: { kind: "agent", id: "compliance-screener", version: "v2.1" },
  attributes: {
    "approval.approvers": ["alice", "bob"],          // plural → array
    "approval.timestamp": new Date().toISOString(),
    "approval.policy.version": "v3.2",
  },
  payload: {
    fullReviewArtifact: { ... },  // rich blob, not indexed
  },
  idempotencyKey: `approval-${ctx.workflowRunId}-${reviewId}`,
});
```

### Pattern: cross-stage trail via the timeline index

```ts
// Get all annotations from a run in time order
const timeline = await kernel.annotations.list(runId);
// Already sorted by createdAt thanks to the (workflowRunId, createdAt) index.

for (const a of timeline) {
  console.log(`[${a.createdAt.toISOString()}] ${a.actorKind}:${a.actorId} — ${a.key} = ${JSON.stringify(a.value)}`);
}
```

## Reference

For the full design rationale, see `docs/RFC-ANNOTATIONS.md` in the package source. The skill reference doc `references/10-annotations.md` covers the API surface in depth.
