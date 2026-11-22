---
"@bratsos/workflow-engine-host-remote": patch
---

A stage that throws a `NonRetryableError` on a remote worker (or a step whose `retryIf` declines) is not retried. The worker adds `retryable: false` to the failed outcome, decided by the `NonRetryableError` brand alone, and the `RemoteExecutor` passes it to `job.execute`; a stage input that fails validation with a `NonRetryableError` in the `RemoteExecutor` is handled the same way. The reported text and every other error are unchanged. The field is optional: a worker that does not send it behaves as before, and a broker that does not know it drops it. A `defineRemoteStage` proxy fails the run on a failed outcome with an empty message, such as a worker throwing `new NonRetryableError()`, with the text `remote activity failed`; it used to leave the stage suspended.
