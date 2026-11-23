---
"@bratsos/workflow-engine-console": patch
---

Filter the console runs list by exact tenant ID using the Tenant ID control, `GET /api/runs?tenantId=tenant-a`, or `ConsoleReadPort.listRuns({ filters: { tenantId: "tenant-a" } })`. The runs list shows the tenant ID when present. Omit the filter to see all runs available to the reader, including runs with no tenant ID. The filter only changes the view. Anyone who can open the console can clear it and see every tenant available to the reader.

The runs list and run detail now read the `workflow_runs.tenantId` column, so the database needs the engine schema that adds it (the same release's migration) before the console is upgraded. Rolling-safe once that migration is applied: the reader uses the existing tenant column and index and writes nothing.
