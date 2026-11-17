---
"@bratsos/workflow-engine": minor
---

New `assertTimerMs(name, value, { allowZero?, hint? })` and `MAX_TIMER_MS` (2147483647) in `@bratsos/workflow-engine/kernel`: a host option that reaches `setTimeout` or `setInterval` must be a finite number of milliseconds a timer can honour, because `Infinity`, `NaN`, a negative number or more than 2**31 - 1 makes the timer fire after 1 ms. `executeJobWithHeartbeat` checks `jobHeartbeatIntervalMs` and `runTickHook` checks `timeoutMs` with it, and both throw a `RangeError` that names the option. A numeric string also throws now: an environment variable passed through unparsed (`jobHeartbeatIntervalMs: process.env.HEARTBEAT_MS`) worked before because a timer coerces `"20"`; pass `Number(process.env.HEARTBEAT_MS)`.
