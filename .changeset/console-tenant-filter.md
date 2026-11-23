---
"@bratsos/workflow-engine-console": patch
---

Filter the console runs list by exact tenant ID using the Tenant ID control, `GET /api/runs?tenantId=tenant-a`, or `ConsoleReadPort.listRuns({ filters: { tenantId: "tenant-a" } })`. The runs list shows the tenant ID when present. Omit the filter to see all runs available to the reader, including runs with no tenant ID. The filter only changes the view. Anyone who can open the console can clear it and see every tenant available to the reader.

Rolling-safe on the current engine schema because the reader uses the existing tenant column and index.
