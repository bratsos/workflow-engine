---
"@bratsos/workflow-engine-host-node": patch
---

`createNodeHost` checks every option that reaches a timer at construction: `orchestrationIntervalMs`, `jobPollIntervalMs`, `jobHeartbeatIntervalMs` and `shutdownTimeoutMs` must be a number from 1 to 2147483647, and `postJobYieldMs` from 0 (0 turns the pause off). `Infinity`, `NaN`, zero (where it is not documented as off), a negative number or a larger value now throws a `RangeError` naming the option; before, a timer turned such a value into 1 ms (an interval became a busy loop, a bound meant as "no limit" the tightest one). `runAndWait` applies the same rule to `pollIntervalMs`, before it creates the run. A numeric string also throws now: an environment variable passed through unparsed (`orchestrationIntervalMs: process.env.TICK_MS`) worked before because a timer coerces `"20"`; pass `Number(process.env.TICK_MS)`.
