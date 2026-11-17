---
"@bratsos/workflow-engine-console": minor
---

The run detail groups each stage's history by attempt. A new "Attempts by stage" section lists every attempt of every stage with when it started and ended, why it began (first run, job retry, retry inside `stage.pollSuspended`, or a rerun after a terminal outcome), how it ended, its error, its stage events, and the steps that last changed during it. A retry inside `stage.pollSuspended` appears as an attempt boundary like a job retry. Each attempt is a native disclosure control. When a run's events are purged, past retention, cut off, or disagree with the stage's row, the stage falls back to its latest attempt and says per-attempt history is unavailable.

`RunDetail` gains an optional `stageEvents: { events: StageEvent[]; complete: boolean }`, a run's stage lifecycle events read apart from the 200-row `events` list with only the stage id and error extracted from each payload. Custom `ConsoleReadPort` implementations keep compiling and keep working without it. `createInMemoryConsoleReadPort` accepts `fixtures.stageEvents`. The run detail now issues eight statements in one transaction instead of six. No schema change.
