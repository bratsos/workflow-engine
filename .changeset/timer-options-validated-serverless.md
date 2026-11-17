---
"@bratsos/workflow-engine-host-serverless": patch
---

`createServerlessHost` checks every option that reaches a timer at construction, with the rule `onTickTimeoutMs` already had: `outboxFlushTimeoutMs` and `jobHeartbeatIntervalMs` must be a number from 1 to 2147483647. `Infinity`, `NaN`, zero, a negative number or a larger value now throws a `RangeError` naming the option; before, a timer turned it into 1 ms (`outboxFlushTimeoutMs: Infinity` cut the post-job flush to 1 ms). `runToCompletion` applies the rule to `jobHeartbeatIntervalMs`, before it creates the run. A numeric string also throws now: an environment variable passed through unparsed (`jobHeartbeatIntervalMs: process.env.HEARTBEAT_MS`) worked before because a timer coerces `"20"`; pass `Number(process.env.HEARTBEAT_MS)`.
