---
sidebar_position: 3
title: Migrating from 0.9 to 0.10
---

# Migrating from 0.9 to 0.10

## Summary
`0.10` introduces the `ActivityExecutor` port to the kernel, facilitating delegation of stage execution logic to remote worker fleets via the new **`@bratsos/workflow-engine-host-remote`** package.

This update is fully backward-compatible. If no custom `executor` is provided, the kernel defaults to executing stages locally using `LocalExecutor`, matching the behavior of `0.9` exactly.

---

## Required Actions
None. This is a drop-in upgrade—no database migrations or code changes are required for existing setups.

---

## New Features

### 1. `ActivityExecutor` Port
You can pass a custom stage executor when initializing the kernel:
```typescript
const kernel = createKernel({
  persistence,
  blobStore,
  jobTransport,
  eventSink,
  scheduler,
  clock,
  registry,
  // Optional executor:
  executor: myCustomExecutor
});
```

### 2. Custom Routing Executor
Use `createRoutingExecutor` to route specific stages to remote workers while running other stages in the main host process:
```typescript
import { createRoutingExecutor } from "@bratsos/workflow-engine/kernel";
import { createRemoteExecutor } from "@bratsos/workflow-engine-host-remote";

const kernel = createKernel({
  ...,
  executor: createRoutingExecutor({
    remote: createRemoteExecutor(orchestratorTransport),
    remoteStageIds: ["heavy-video-transcoding"],
  }),
});
```
