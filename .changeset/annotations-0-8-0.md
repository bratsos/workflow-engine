---
"@bratsos/workflow-engine": minor
---

Add `WorkflowAnnotation` — a first-class, queryable provenance surface inspired by OpenTelemetry semantic conventions.

**New API**

- `ctx.annotate(key, value, opts?)` inside a stage's `execute()` or `checkCompletion()` — durable, buffered, flushed atomically with the stage outcome (not fire-and-forget). Supports a TypedKey form, a string-key form, and a batch form.
- `annotations: [...]` on `RunCreateCommand` — capture trigger context atomically with run creation.
- `kernel.annotations.attach(workflowRunId, input)` — single-transaction external attach for plugins, post-hoc reviews, or audit annotations.
- `kernel.annotations.list(workflowRunId, filters?)` — queryable timeline with filters for `key`, `keyPrefix`, `scope`, `scopeId`, `actorId`, `actorKind`, `attempt`, `since`/`until`, `limit`.
- New subpath `@bratsos/workflow-engine/conventions` — typed-key registry: `Trigger.*`, `Decision.*`, `Approval.*`, `Revision.*`. `typedKey<T>(name, meta?)` helper lets consumers define org-local conventions with the same value-type linkage.

**Schema migration required**

Add the `WorkflowAnnotation` model and the `annotations` back-relations on `WorkflowRun` and `WorkflowStage`. See `skills/workflow-engine/migrations/migrate-0.7-to-0.8.md` for the exact Prisma snippet and the documentation fix for the previously-undocumented `AICall.metadata` column.

**Deprecations**

- `RunCreateCommand.metadata` is `@deprecated` in 0.8 and removed in 1.0. Existing rows with populated `WorkflowRun.metadata` are automatically surfaced as virtual `legacy.metadata.*` annotations when `kernel.annotations.list(runId)` is called (lazy read-side shim, no dual-write).

**Additional v0.8 features**

- **`attempt` auto-increment on rerun.** `run.rerunFrom` assigns a fresh `attempt` to recreated stages so annotations from prior attempts (preserved via `onDelete: SetNull` on the WorkflowStage FK) are distinguishable from new ones. Filterable via `kernel.annotations.list(runId, { attempt })`.
- **Opt-in outbox emission for annotations.** Pass `emitEvent: true` on any annotation write and the engine writes an `annotation:created` outbox event in the same transaction, routed through the existing event sink for plugin subscriptions.
- **Cancellation tightened across stage Phase 3 transactions.** A `run.cancel` committing between the kernel's outer ghost check and a stage's Phase 3 transaction now triggers an in-transaction status guard that rolls back the stage update, annotations, and outbox events atomically. Same protection added to the suspended-stage poll path. Pre-existing race; annotations inherit the fix.

**Notes**

- `value` is `unknown`-typed; the scalar/array convention is documented but not runtime-enforced. Use the `payload` slot for blobs.

See `docs/RFC-ANNOTATIONS.md` for the full design rationale.
