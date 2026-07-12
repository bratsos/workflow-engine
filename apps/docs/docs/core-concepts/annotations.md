---
sidebar_position: 4
title: Annotations
---

# Annotations (Provenance)

**workflow-engine** (v0.8.0+) features a first-class **Annotations API** for capturing typed, structured, and queryable facts (provenance) about workflow execution. This is particularly useful for auditing AI-orchestrated decisions: capturing *why* an agent chose a path, which prompt/model was used, or recording human approvals.

---

## When to Use Annotations

Use annotations when you need key-addressable metadata that you want to query across runs later:
* **Trigger Context**: Who or what initiated the run (e.g. Zendesk webhook, manual CLI, cron schedule).
* **Decision Records**: The chosen outcome, rationale, confidence score, and alternatives considered.
* **Human Approvals**: Recording post-hoc human review and sign-off.

### Annotations vs. Logs vs. Artifacts
* **Logs (`ctx.log`)**: Time-ordered, non-indexed strings meant for human debugging.
* **Artifacts (`ctx.storage`)**: Large, structured objects saved in your BlobStore.
* **Annotations (`ctx.annotate`)**: Flat, dot-namespaced, indexed key-value attributes stored in the database.

---

## Recording Annotations

The API supports three forms: typed keys, custom string keys, and batch envelopes. Annotations written within a stage are buffered and flushed **atomically** with the stage execution status.

### 1. Typed Keys (Recommended)
Importing well-known namespaces like `Decision` or `Trigger` provides compile-time value checking.

```typescript
import { Decision } from "@bratsos/workflow-engine/conventions";

// Type-checked values:
ctx.annotate(Decision.outcome, "approved");
ctx.annotate(Decision.confidence, 0.98);

// ctx.annotate(Decision.confidence, "high"); 
// ❌ TypeScript compilation error: expected number
```

### 2. Custom String Keys
Use custom dot-namespaced strings. Org-specific custom keys should be prefixed to avoid future naming clashes.

```typescript
ctx.annotate("acme.compliance.signature", "alice@acme.com");
```

### 3. Batch Envelope
You can group multiple attributes and associate them with a specific actor (agent, user, or system) and an optional unindexed rich blob `payload`.

```typescript
ctx.annotate({
  actor: { kind: "agent", id: "triage-v3", version: "3.0.1" },
  attributes: {
    "decision.outcome": "low",
    "decision.rationale": "AI confidence below threshold",
    "decision.confidence": 0.42,
    "decision.alternatives": ["low", "medium", "high"],
    "decision.used_fallback": true,
  },
  payload: { rawModelResponse: { text: "...", tokens: 100 } }, // rich unindexed blob
});
```

---

## Attaching Annotations Outside Stages

### At Run Creation
You can attach trigger details atomically when creating a workflow run:

```typescript
await kernel.dispatch({
  type: "run.create",
  workflowId: "ticket-triage",
  input: { ticketId: "123" },
  annotations: [
    {
      actor: { kind: "system", id: "zendesk-webhook" },
      attributes: {
        "trigger.source": "webhook:zendesk",
        "trigger.reason": "ticket created webhook",
      },
    },
  ],
});
```

### Post-Hoc External Attaches (e.g. Human Review)
Attach annotations at runtime from external code (like an admin portal) using the query manager:

```typescript
await kernel.annotations.attach(workflowRunId, {
  actor: { kind: "user", id: "manager-bob" },
  attributes: { "review.disposition": "approved-anyway" },
  scope: "run", // "run" (default) or "stage"
  idempotencyKey: "review-run-123-bob", // prevents duplicate writes
});
```

---

## Querying Annotations

Retrieve recorded facts via `kernel.annotations.list(runId, filters?)`. All filters are combined with AND logic.

```typescript
// Get all annotations for a run, sorted chronologically
const timeline = await kernel.annotations.list(runId);

// Filter by key prefix (utilizes index for range scanning)
const decisions = await kernel.annotations.list(runId, {
  keyPrefix: "decision.",
});

// Filter by actor
const agentTrail = await kernel.annotations.list(runId, {
  actorId: "triage-v3",
});
```

---

## Well-Known Conventions (Stability Policy)

Conventions imported from `@bratsos/workflow-engine/conventions` follow the OpenTelemetry naming rules:
* **Singular names** represent scalar values (e.g., `decision.outcome`).
* **Plural names** represent arrays (e.g., `approval.approvers` is always `string[]`, even for single entries).

The core conventions:

### `Trigger.*`
* `trigger.source` (string)
* `trigger.parent_run_id` (string)
* `trigger.reason` (string)

### `Decision.*`
* `decision.outcome` (unknown)
* `decision.rationale` (string)
* `decision.confidence` (number)
* `decision.alternatives` (unknown[])
* `decision.used_fallback` (boolean)

### `Approval.*`
* `approval.approvers` (string[])
* `approval.timestamp` (string)

### `Revision.*`
* `revision.previous_run_id` (string)
* `revision.reason` (string)

> [!NOTE]
> All standard keys inside these namespaces are marked as **stable** and will not undergo breaking signature changes without a major engine version bump.

---

## Legacy Metadata Migration

In `v0.8.0+`, the `metadata` column on `WorkflowRun` is deprecated. If you query annotations for runs created before `v0.8.0`, the engine automatically projects existing metadata key-values as virtual annotations prefixed with `legacy.metadata.*` (e.g., `legacy.metadata.tenantId`). No database migrations or dual-writing are required.
