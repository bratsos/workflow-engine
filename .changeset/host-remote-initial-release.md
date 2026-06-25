---
"@bratsos/workflow-engine-host-remote": minor
---

Initial release: credential-free remote activity workers.

Run a workflow stage's `execute()` on a separate, disposable worker machine that holds no database connection and no root object-store credentials, while a trusted orchestrator owns all state and persistence.

- **Proxy stage** (`defineRemoteStage`) + an in-process **broker** (lease / fencing token / deadline / presign) that drives the worker through the engine's existing suspend/resume — no kernel changes required for this path.
- **HTTP transport** (`createBrokerHttpServer` + `createHttpWorkerTransport`) with bearer-token auth, so workers connect over the network from a separate process/machine.
- **Direct-to-bucket artifacts** (`createS3Presigner` / `createS3BlobStore`; S3/R2/MinIO via SigV4): workers PUT large binary artifacts directly to object storage via presigned URLs; the broker token is never sent to the object store.
- **Restart durability with no new DB table**: the engine's `SUSPENDED` `WorkflowStage` + a claim-checked payload are the durable anchor; the in-memory broker rehydrates on poll, with the absolute deadline preserved across restarts.
- **Lease renewal** (heartbeat) and **durable reports** so a completed activity survives an orchestrator restart without re-running expensive work.
- **Deploy safety** via per-task version pinning, a **prefix-validated** artifact-key boundary (confused-deputy prevention), **per-stage routing** (`createRoutingExecutor`), and a blocking `createRemoteExecutor` for the in-core `ActivityExecutor` port.

See the package README for the full quickstart and API reference.
