---
"@bratsos/workflow-engine": patch
---

`createPrismaJobQueue` now returns `PrismaJobQueue`, so `enqueue` type-checks. It always existed at runtime, but the factory's `JobQueue` return type hid it. A value used as a `JobQueue` keeps working, and the `JobQueue` port itself is unchanged.
