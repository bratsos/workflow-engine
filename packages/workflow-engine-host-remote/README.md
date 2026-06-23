# @bratsos/workflow-engine-host-remote

Credential-free remote activity workers for `@bratsos/workflow-engine`. This package provides a proxy-stage + broker + worker SDK that runs a stage's execute() on a remote worker with no DB or root object-store credentials. It is wired through the engine's existing suspend/resume mechanism with zero core change.

For detailed design and architecture, see [SPEC.md](./SPEC.md) and [RFC-REMOTE-ACTIVITY-WORKERS.md](../workflow-engine/docs/RFC-REMOTE-ACTIVITY-WORKERS.md).

## Security boundary (v1)

`ctx.storage` on the worker is prefix-sandboxed to the task's artifact grant, so a worker cannot directly read or write outside its allocated prefix. However, object-storage keys embedded inside a worker's `output` are **not** prefix-validated by the proxy — the proxy's trust gate (`real.outputSchema.safeParse`) validates output shape, not values. A downstream trusted stage that dereferences a worker-supplied key via the orchestrator's root `BlobStore` trusts the worker not to point outside its grant prefix (a confused-deputy cross-run read is possible if it does). Consumers whose stage outputs carry object keys must re-scope or validate them downstream, or restrict the orchestrator's `BlobStore` credentials. A prefix-checked artifact-ref channel is deferred to Phase 2.
