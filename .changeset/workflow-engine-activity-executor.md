---
"@bratsos/workflow-engine": minor
---

Adds the `ActivityExecutor` kernel port with a default `LocalExecutor` (backward-compatible; default behavior unchanged).

The `ActivityExecutor` port (`src/kernel/ports.ts`) lets the kernel's `job.execute` handler delegate stage execution to an injected implementation. The default `LocalExecutor` replicates today's in-process behavior byte-for-byte — no behavior change for existing consumers.

Also exports `createLocalExecutor` and `createRoutingExecutor` from `@bratsos/workflow-engine/kernel` so that `@bratsos/workflow-engine-host-remote` can inject a `RemoteExecutor` (or a `RoutingExecutor` that routes specific stage IDs remotely and all others locally) without touching the kernel internals.

The port is designed so that `@bratsos/workflow-engine-host-remote`'s `createRemoteExecutor` can implement it directly: submit work to a broker, block until the worker reports, and return an `ActivityRunResult`. This is Phase 2 of the remote-activity-workers design (RFC-REMOTE-ACTIVITY-WORKERS.md § Phase 2).
