---
"@bratsos/workflow-engine": patch
---

`workflow_engine_enqueue` uses the status column's PostgreSQL enum type, so it works with a renamed native enum. The `fromPrisma8` validation message also recognizes custom names. Pass a custom name as `statusEnumName` to `createPrismaWorkflowPersistence` for the kernel's raw run claim.

**Rolling-safe.** The replacement SQL function works with the enum already in use. Install it in the schema migration and re-grant `EXECUTE` to application roles before committing.
