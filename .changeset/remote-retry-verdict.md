---
"@bratsos/workflow-engine-host-remote": patch
---

A stage that throws on a remote worker is classified as a local one is. The worker reports the error's `name` and, when the kernel's `isRetryableStageError` rejects the error (a `NonRetryableError`, a Zod error from any copy of zod, a duplicate step key), `retryable: false` on the failed outcome; the `RemoteExecutor` passes both to `job.execute`, so the job is not retried and the stage records the same `"Name: message"` text a local stage would. A stage input that fails validation in the `RemoteExecutor` is non-retryable too, as in `LocalExecutor`. Both fields are optional: a worker that sends neither behaves as before, and a broker that does not know them drops them. A `defineRemoteStage` proxy still fails the run on any failed outcome.
