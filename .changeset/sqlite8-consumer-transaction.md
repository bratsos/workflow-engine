---
"@bratsos/workflow-engine": patch
---

Prisma 8 SQLite: an engine write is never acknowledged and then lost inside a transaction your code opened on the client's root connection. Such a transaction can come from a raw `BEGIN` or `SAVEPOINT` sent through `db.execute` or `db.query` before the adapter's first call, which the wrapper could not refuse yet. The wrapper now reads the root's transaction state from the connection when it takes the driver over, and again after each of your statements while that transaction is open. Engine writes wait up to 5 s for it to end, and then fail with a busy error (`code: "SQLITE_BUSY"`) instead of joining it. Ending a transaction (`COMMIT`, `END`, `ROLLBACK`, `RELEASE`) is no longer refused; only `BEGIN` and `SAVEPOINT` are, as before. Before this fix, the wrapper refused the consumer's `COMMIT`, so engine writes acknowledged after the takeover were rolled back when the client closed.
