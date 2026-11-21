---
"@bratsos/workflow-engine-host-node": minor
---

Bound maintenance outbox waits with the new `outboxFlushTimeoutMs` option (default 5 seconds), and set claim lifetimes beyond the applicable maintenance or shutdown timeout. A slow in-flight sink call can finish or be recovered after its claim expires.

Each job loop and tick belongs to its host start. A stopped tick cannot call its hook after a restart. A replacement job loop waits for the old loop to settle. A job dequeued while the host stops is not run: the host returns it with the transport's `defer`, fenced by its lease, so it keeps its attempt count. The host waits for that return for at most `shutdownTimeoutMs`; a return that has not finished by then is still fenced, and the job is recovered when its lease expires if the return never commits.
