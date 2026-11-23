---
"@bratsos/workflow-engine": minor
---

Attach tenant IDs and labels to accounting rows through `AIHelperOptions.attribution`. Stage helpers inherit them from the run and also record its ID. A row written through `ctx.aiLogger` carries the run's ID, gets the run's tenant when it has none, and the run's labels under its own. Child helpers merge labels by key. Custom loggers receive the attribution fields, and `PrismaAICallLogger.costByTenant` reads a tenant's USD cost for a period with optional label grouping.

**Rolling-safe** after the additive attribution schema migration. Custom stage helper factories must forward the supplied options.
