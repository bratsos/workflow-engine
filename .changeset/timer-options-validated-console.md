---
"@bratsos/workflow-engine-console": patch
---

`createWorkflowConsole`'s `pollIntervalMs` and the CLI's `--poll` are checked with `assertTimerMs` from `@bratsos/workflow-engine/kernel` before the handler or server is created: `0` (the UI's "Off") or a number from 1 to 2147483647 milliseconds, anything else throws a `RangeError` that names the option. Before, `--poll 1e12` or `pollIntervalMs: 2147483648` went to the page's timer, which fired after 1 ms and read the database in a loop; the CLI's old `--poll must be a non-negative number.` message is replaced. The handler and CLI now import `assertTimerMs` from the `@bratsos/workflow-engine` peer dependency at run time, so that version must export it.
