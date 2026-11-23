---
"@bratsos/workflow-engine": patch
"@bratsos/workflow-engine-host-node": patch
"@bratsos/workflow-engine-host-serverless": patch
"@bratsos/workflow-engine-host-remote": patch
---

Route engine diagnostics through one application sink with `setLogger({ debug, info, warn, error })` from `@bratsos/workflow-engine/kernel`. The kernel, hosts, standalone helpers, and Prisma adapters pass contextual IDs as structured fields. The default console keeps its trace-level gate. Prompt and response previews require `WORKFLOW_ENGINE_TRACE_TEXT`. Error diagnostics retain their original details. If the application sink throws, the engine falls back to the console for that entry.

Rollout is rolling-safe because the change only affects process diagnostics and requires no schema or worker coordination.
