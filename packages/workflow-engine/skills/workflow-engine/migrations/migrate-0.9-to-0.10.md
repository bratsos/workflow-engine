# Migrating from 0.9 to 0.10

## Summary

0.10 adds an injectable **`ActivityExecutor`** port to the kernel and a new companion package, **`@bratsos/workflow-engine-host-remote`**, for running a stage's `execute()` on a separate, credential-free machine. The core change is additive and backward-compatible: if you don't set `executor`, the kernel uses a default `LocalExecutor` that behaves byte-for-byte like 0.9.

## Required actions

None. 0.9 → 0.10 is a drop-in upgrade for existing projects — no schema migration, and no API changes to existing call sites.

## New features

- **`ActivityExecutor` port** (`@bratsos/workflow-engine/kernel`): `createKernel({ ..., executor })` now accepts an optional executor. Defaults to `createLocalExecutor()` (in-process, unchanged behavior).
- **`createRoutingExecutor({ remote, remoteStageIds })`**: route specific stage IDs to a remote executor; all other stages run locally.
- **`@bratsos/workflow-engine-host-remote`** (new package): proxy stage (`defineRemoteStage`), broker, worker SDK (`createActivityWorker`), HTTP transport (`createBrokerHttpServer` / `createHttpWorkerTransport`), and S3/R2/MinIO artifact stores (`createS3Presigner` / `createS3BlobStore`). Run heavy stages on disposable workers with no DB connection and no root object-store credentials, restart-durable, with binary artifacts by reference. See [`../references/11-remote-activity-workers.md`](../references/11-remote-activity-workers.md).

## Deprecations

None.

## Bug fixes

None affecting existing behavior. The executor refactor is byte-for-byte compatible — all existing kernel tests pass unchanged.

## Code examples

Existing kernels keep working with no change (the default `LocalExecutor` is used):

```typescript
const kernel = createKernel({
  persistence, blobStore, jobTransport, eventSink, scheduler, clock, registry,
});
// identical behavior to 0.9
```

Opt in to remote workers for specific stages:

```typescript
import { createRoutingExecutor } from "@bratsos/workflow-engine/kernel";
import { createRemoteExecutor } from "@bratsos/workflow-engine-host-remote";

const kernel = createKernel({
  persistence, blobStore, jobTransport, eventSink, scheduler, clock, registry,
  executor: createRoutingExecutor({
    remote: createRemoteExecutor(orchestratorTransport),
    remoteStageIds: ["heavy-transcode"],
  }),
});
```
