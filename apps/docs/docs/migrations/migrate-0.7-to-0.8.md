---
sidebar_position: 5
title: Migrating from 0.7 to 0.8
---

# Migrating from 0.7 to 0.8

## Summary
`0.8.0` introduces the **Annotations API**, replacing ad-hoc metadata fields with a structured, queryable provenance layer modeled after OpenTelemetry conventions. 

Upgrading requires a database schema migration. Usage of the Annotations API is optional, and the legacy `WorkflowRun.metadata` column is still supported via a backward-compatible shim.

---

## Required Actions

### 1. Database Schema Migration
Add the `WorkflowAnnotation` model and back-relations to your Prisma schema:

```prisma
// schema.prisma

model WorkflowRun {
  // ... existing fields ...
  annotations   WorkflowAnnotation[]
}

model WorkflowStage {
  // ... existing fields ...
  annotations   WorkflowAnnotation[]
}

model WorkflowAnnotation {
  id                    String          @id @default(cuid())
  createdAt             DateTime        @default(now())
  workflowRunId         String
  workflowRun           WorkflowRun     @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  workflowStageRecordId String?
  workflowStage         WorkflowStage?  @relation(fields: [workflowStageRecordId], references: [id], onDelete: SetNull)
  attempt               Int             @default(0)
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
  @@map("workflow_annotations")
}
```

Run the Prisma migration tool:
```bash
npx prisma migrate dev --name add_workflow_annotations
```

### 2. Add `metadata` to the `AICall` Schema
If you set up your database schema prior to `0.8`, your `AICall` model is missing the `metadata` column, which is populated by the AI Helper.

Add the column to your `AICall` model:
```prisma
model AICall {
  // ... existing fields ...
  metadata      Json?
}
```
Apply the database changes:
```bash
npx prisma migrate dev --name add_aicall_metadata_column
```

---

## Code Migration Patterns

### 1. Reworking Run Metadata
If you were previously setting run-level metadata via `RunCreateCommand.metadata`, this field is now deprecated. Migrate to the `annotations` array:

**Before:**
```typescript
await kernel.dispatch({
  type: "run.create",
  workflowId: "my-wf",
  input: {},
  metadata: { source: "webhook", tenantId: "123" }
});
```

**After:**
```typescript
import { Trigger } from "@bratsos/workflow-engine/conventions";

await kernel.dispatch({
  type: "run.create",
  workflowId: "my-wf",
  input: {},
  annotations: [
    {
      actor: { kind: "system", id: "webhook-service" },
      attributes: {
        "trigger.source": "webhook",
        "acme.tenant_id": "123" // Custom namespaced key
      }
    }
  ]
});
```

### 2. Moving Stage Logging / Metadata to Annotations
Instead of embedding debugging metadata inside time-ordered logs or stage output data blocks:

**Before:**
```typescript
await ctx.log("INFO", "Classified document", { confidence: 0.85 });
return {
  output: {
    result: "low-urgency",
    _meta_confidence: 0.85 // Bloating output contract
  }
};
```

**After:**
```typescript
import { Decision } from "@bratsos/workflow-engine/conventions";

ctx.annotate(Decision.outcome, "low-urgency");
ctx.annotate(Decision.confidence, 0.85);

return {
  output: { result: "low-urgency" }
};
```
