---
"@bratsos/workflow-engine": minor
"@bratsos/workflow-engine-host-node": minor
"@bratsos/workflow-engine-host-serverless": minor
"@bratsos/workflow-engine-host-remote": minor
---

Correctness and hardening sweep across the kernel, persistence, AI layer, and hosts.

**Breaking (pre-1.0 minor):**

- `AIBatchResult<T>` is now a discriminated union: `result: T` exists only on `status: "succeeded"` (validated against the request's Zod schema); failures carry `error` and no longer return `{} as T`.
- `zod` is now a required peer dependency of `@bratsos/workflow-engine` and `@bratsos/workflow-engine-host-remote` (previously a regular dependency).
- Removed dead `getSuspendedJobsReadyToPoll` from `JobTransport`/`JobQueue`.
- `getModelProvider` throws on unknown providers instead of silently routing to Google.

**Kernel/host correctness:**

- Terminal job failures now dispatch `run.transition` immediately — runs fail promptly with the real stage error instead of lingering until reaped as "stuck".
- A FAILED stage with a retry still queued/in-flight no longer fails the whole run (parallel-group retry race fixed).
- Zod input/config validation errors are non-retryable; error name/stack preserved in results.
- `maxWaitTime` on suspended stages is now enforced (timeout failure instead of polling forever).
- Already-COMPLETED stages are not re-executed by duplicate/stale-lease jobs.
- Job enqueue and `rerunFrom` blob deletion moved after transaction commit; `run.reapStuck` recovers RUNNING runs with PENDING stages missing jobs, is version-guarded against double-reaping, and reports `transitioned` truthfully.
- `run.rerunFrom` supports idempotency keys; stuck `in_progress` idempotency keys are reclaimable after a configurable TTL (`idempotencyStaleInProgressMs`, default 10 min).
- Outbox flush preserves per-run event ordering on failure; suspended job rows are completed on resume; `workflow:suspended` is now emitted.
- Hosts heartbeat job leases while executing (`jobHeartbeatIntervalMs`, default 60s) and default `staleLeaseThresholdMs` raised 60s → 300s.
- Missing previous-group output fails the stage loudly instead of silently substituting the workflow input.

**Persistence:**

- Fixed `claimNextPendingRunPostgres` enum cast (`::"Status"`) — claiming failed on real Postgres.
- In-memory and Prisma adapters reconciled: identical version-bump, suspended-readiness, retry-default, ordering, artifact and undefined-field semantics; version now increments on every update/claim.
- `dequeue` rethrows DB errors instead of masking a dead database as an empty queue; claim/dequeue contention retries are bounded; outbox sequence assignment is safe outside transactions via unique-constraint retry.
- Conformance suites exported from `@bratsos/workflow-engine/testing` for third-party adapters; new real-Postgres conformance CI job.

**AI layer:**

- Batch structured output: JSON schema is sent to providers (native `responseJsonSchema` on Google) and results validated; Google batch uses `systemInstruction`/`generationConfig` instead of prompt text; OpenAI batch uses `max_completion_tokens`.
- Tool-call executions no longer double-count tokens/cost in aggregated stats; streamed calls always persist a call log via `onFinish`.
- `maxRetries`/`abortSignal` exposed on text/object/stream options; multi-text `embed()` uses `embedMany`.

**Remote host:**

- Workers honor the broker's heartbeat cancel signal (skip doomed reports), surface loop errors via `onError` with exponential backoff, and the broker returns an error instead of minting unusable blob URLs when `publicBaseUrl` is missing.

**DX:** `defineWorkflow()` options-object API, `onProgress` auto-fills stage identity, async-batch `pollConfig` derived from state, `parallel()` context types no longer collapse to unions, tests included in typecheck, corrected README Prisma schema (`@@map`), export drift fixed (`RunReapStuckCommand`, `ModelFilter`).
