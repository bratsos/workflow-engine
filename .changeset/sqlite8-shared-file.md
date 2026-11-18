---
"@bratsos/workflow-engine": patch
---

Prisma 8 SQLite: several root clients of one file in one process share one statement queue. Each root has its own synchronous connection, so a write on one root while another held the file's write lock waited inside the driver and blocked the event loop for the whole busy timeout (an engine `run.create` took 5.3 s; an outbox flush across 13 roots stalled the process). A root now waits its turn without blocking, and closes the other roots' open reads before it writes.
