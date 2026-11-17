---
"@bratsos/workflow-engine-host-serverless": minor
---

`createServerlessHost` accepts `onTick(counts)`, called at the end of every `runMaintenanceTick()` with the counts it computed, before the method returns them. Combine it with the `engine.stats` command to export gauges. A hook that throws or rejects is caught and logged, and the tick still returns its counts. The hook is awaited, so a slow hook delays the return of `runMaintenanceTick()`.
