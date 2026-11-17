---
"@bratsos/workflow-engine": patch
---

CI loads rows left in flight by every release from `1.0.0-alpha.13` through
`1.0.0-alpha.20` through the current SQLite and Postgres adapters and replays
each run to its expected terminal outcome.
