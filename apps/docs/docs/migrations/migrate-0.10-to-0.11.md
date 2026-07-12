---
sidebar_position: 2
title: Migrating from 0.10 to 0.11
---

# Migrating from 0.10 to 0.11

## Summary
`0.11` is a correctness and hardening sweep. While there are no database schema migrations, there are breaking API and behavior changes:
1. `AIBatchResult<T>` is now a strict discriminated union. Failed results no longer return empty placeholder objects.
2. `zod` is now a required `peerDependency` instead of a bundled dependency.
3. The dead method `getSuspendedJobsReadyToPoll` was removed from the `JobTransport`/`JobQueue` interfaces.
4. `getModelProvider` throws an error on unknown providers instead of silently defaulting to Google.

---

## Required Actions

### 1. Install `zod` Explicitly
`zod` was moved to a `peerDependency`. If your project does not depend on `zod` directly, add it:
```bash
npm install zod
```

### 2. Update Batch Result Processing
Verify your `getResults` parsing loops. `AIBatchResult<T>` is now a discriminated union:
* Check `status === "succeeded"` before reading `.result`.
* If `status === "failed"`, the `.result` property is undefined and details live on `.error`.

**Before:**
```typescript
const results = await batch.getResults(batchId);
for (const r of results) {
  // Silent error: r.result was {} on failure
  console.log(r.result); 
}
```

**After:**
```typescript
const results = await batch.getResults(batchId);
for (const r of results) {
  if (r.status === "succeeded") {
    console.log(r.result); // Valid T
  } else {
    console.error(`Request failed: ${r.error}`); // string
  }
}
```

### 3. Remove `getSuspendedJobsReadyToPoll` from Custom Adapters
If you implemented a custom `JobTransport` or `JobQueue`, delete this unused method from your class.

### 4. Configure `providerResolver` for Custom Providers
`getModelProvider` no longer silently resolves custom provider values to Google. If you register custom models using a provider other than `"openrouter"` or `"google"`, you must supply a custom `providerResolver` or register it via `registerEmbeddingProvider`.

---

## New Features

### Options-Object `defineWorkflow()`
An alternative syntax to building workflows without the 5-argument constructor:
```typescript
import { defineWorkflow } from "@bratsos/workflow-engine";

const workflow = defineWorkflow({
  id: "my-workflow",
  name: "My Workflow",
  description: "Task description",
  input: InputSchema,
})
  .pipe(stage1)
  .build();
```

### Heartbeating Leases
Hosts now touch active job leases while running (`jobHeartbeatIntervalMs`, default 60s). To prevent conflicts, the default `staleLeaseThresholdMs` has been raised from 60s to 300s (5 minutes).

### Cross-Process Batch Schema Verification
You can now pass Zod schemas to `getResults` on a resumed batch stage:
```typescript
const results = await batch.getResults(batchId, {
  schemas: { "req-1": ItemSchema }
});
```

---

## Behavioral Improvements

* **Enforced `maxWaitTime`**: Suspended async-batch stages will now time out and fail if they exceed their configured `maxWaitTime` (previously they would poll indefinitely).
* **Early Run Failure**: When a stage fails terminally (depleting its retries), the workflow run is transitioned to `FAILED` immediately inside the completion transaction rather than lingering until reaped.
* **Non-Retryable Validation Errors**: Zod input and config validation errors are treated as terminal stage failures immediately.
