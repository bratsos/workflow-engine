---
"@bratsos/workflow-engine-host-remote": patch
---

`createActivityWorker` and `createRemoteExecutor` check every option that reaches a timer when they are called, with the rule and the error the Node and serverless hosts use (`assertTimerMs` from `@bratsos/workflow-engine/kernel`): the worker's `heartbeatMs` (a `setInterval`), `idleDelayMs` and `maxBackoffMs` (the idle wait and the failure backoff), and the executor's `pollEveryMs` (the pause between two polls) must be a number from 1 to 2147483647. `Infinity`, `NaN`, zero, a negative number or a larger value now throws a `RangeError` naming the option; before, a timer turned it into 1 ms (a heartbeat every millisecond, a poll loop with no pause, a backoff that is no backoff). `pollIntervalMs` and `maxWaitMs` are not timers (a hint and a deadline sent to the broker) and are unchanged.
