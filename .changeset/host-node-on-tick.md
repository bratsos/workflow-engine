---
"@bratsos/workflow-engine-host-node": minor
---

`createNodeHost` accepts `onTick(counts)`, called after every orchestration tick with the `MaintenanceTickCounts` the tick computed. Combine it with the `engine.stats` command to export gauges. A hook that throws or rejects is caught and logged and never stops the loop. The hook is awaited as part of the tick, so a slow hook delays the next tick (firings that land meanwhile are skipped, never queued) and ticks never overlap; `stop()` waits for it for at most `shutdownTimeoutMs`.
