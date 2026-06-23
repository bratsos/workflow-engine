# @bratsos/workflow-engine-host-remote

Credential-free remote activity workers for `@bratsos/workflow-engine`. This package provides a proxy-stage + broker + worker SDK that runs a stage's execute() on a remote worker with no DB or root object-store credentials. It is wired through the engine's existing suspend/resume mechanism with zero core change.

For detailed design and architecture, see [SPEC.md](./SPEC.md) and [RFC-REMOTE-ACTIVITY-WORKERS.md](../workflow-engine/docs/RFC-REMOTE-ACTIVITY-WORKERS.md).
