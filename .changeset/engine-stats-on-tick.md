---
"@bratsos/workflow-engine": minor
---

New read-only command `engine.stats` reports the state of active work without the engine taking a metrics dependency: runs, stages and jobs by non-terminal status, the age of the oldest PENDING run and job, the SUSPENDED stages that are due and how overdue the most overdue one is, unpublished outbox events and the age of the oldest, and dead-lettered events. It counts PENDING, RUNNING and SUSPENDED rows only and never visits a terminal row, so its cost follows the work in flight and not the table size. It writes nothing: no outbox event, no idempotency key, no transaction.

It reads two new optional port methods, `Persistence.getActiveWorkStats(now)` and `JobTransport.getJobStats()` (also on `JobQueue`). Nothing is required of a custom adapter: a port without a method has its sections reported as `{ available: false }` instead of failing or reading as zero. The in-memory ports and the Prisma adapters (Prisma 6, 7 and 8, on PostgreSQL and SQLite) implement them, and `persistenceConformanceSuite` and `jobQueueConformanceSuite` cover them, skipped when absent. `createSpillingJobTransport` forwards `getJobStats` when the transport it wraps has it. `runTickHook` and `MaintenanceTickHook` are exported from `@bratsos/workflow-engine/kernel` for hosts that call an `onTick` hook themselves.
