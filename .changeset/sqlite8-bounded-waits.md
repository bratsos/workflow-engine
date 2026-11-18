---
"@bratsos/workflow-engine": patch
---

Prisma 8 SQLite: every wait the wrapper adds on the root connection is now bounded, and none waits on a read that is not moving. A write awaited inside a `for await` loop over `db.orm` or `db.query`, or made while an iterator is left unfinished, no longer hangs every later caller: it runs at once, and on a rollback-journal file an engine commit under such a read fails with `Transaction commit failed` after the busy timeout, as without the coordination. The wrapper's own reads are waited for up to 5 s, and the commit then gets only what is left of that time. `fromPrisma8(db)` no longer starts the client's connection, so `db.connect()` after it no longer throws `SQLite client already connected`; it looks the root driver up at its first call, and logs one warning when the Prisma 8 build exposes none. The journal mode is now read at a commit only when root reads are in flight.
