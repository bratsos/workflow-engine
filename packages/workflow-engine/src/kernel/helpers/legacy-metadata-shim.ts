/**
 * Legacy metadata shim
 *
 * Synthesizes virtual `legacy.metadata.*` annotation records from a
 * run's `WorkflowRun.metadata` JSON column. Implements the transition
 * path documented in the 0.7→0.8 migration:
 *
 *   - `WorkflowRun.metadata` is deprecated but remains source of truth
 *     for legacy rows.
 *   - `kernel.annotations.list(runId)` materializes the legacy column
 *     as if it had been migrated, so consumers can query unified
 *     provenance without an explicit data migration.
 *   - No dual-write. The column stays as the canonical store for
 *     legacy rows until a future major version, at which point a bulk
 *     migration script ships and the column is removed.
 */

import type {
  AnnotationFilters,
  WorkflowAnnotationRecord,
  WorkflowRunRecord,
} from "../../persistence/interface";

/**
 * Build virtual annotation rows from `run.metadata`, applying the same
 * filter set that `listAnnotations` honors. Returns `[]` if there is no
 * metadata to project or the filter excludes run-scope rows.
 *
 * Synthesized rows carry a deterministic ID prefixed `synthesized:` so
 * they are distinguishable from real persisted rows. Their `createdAt`
 * is the run's `createdAt` (legacy metadata has no per-key timestamp).
 */
export function synthesizeLegacyMetadata(
  run: Pick<WorkflowRunRecord, "id" | "createdAt" | "metadata">,
  filters: AnnotationFilters = {},
): WorkflowAnnotationRecord[] {
  if (!run.metadata || typeof run.metadata !== "object") return [];
  if (Array.isArray(run.metadata)) return [];

  // Synthesis only emits run-scope rows. Skip if the filter excludes
  // run scope, or filters on stage-only dimensions.
  if (filters.scope !== undefined && filters.scope !== "run") return [];
  if (filters.scopeId !== undefined && filters.scopeId !== null) return [];
  if (filters.actorId !== undefined) return [];
  if (filters.actorKind !== undefined) return [];
  if (filters.attempt !== undefined && filters.attempt !== 0) return [];

  // Time-range filters compare against the run's createdAt.
  if (filters.since !== undefined && run.createdAt < filters.since) return [];
  if (filters.until !== undefined && run.createdAt > filters.until) return [];

  const rows: WorkflowAnnotationRecord[] = [];
  for (const [originalKey, value] of Object.entries(
    run.metadata as Record<string, unknown>,
  )) {
    const key = `legacy.metadata.${originalKey}`;

    if (filters.key !== undefined && filters.key !== key) continue;
    if (filters.keyPrefix !== undefined && !key.startsWith(filters.keyPrefix))
      continue;

    rows.push({
      id: `synthesized:${run.id}:${originalKey}`,
      createdAt: run.createdAt,
      workflowRunId: run.id,
      workflowStageRecordId: null,
      attempt: 0,
      scope: "run",
      scopeId: null,
      actorKind: null,
      actorId: null,
      actorVersion: null,
      key,
      value,
      payload: null,
      idempotencyKey: null,
    });
  }

  return rows;
}

/**
 * Decide whether `kernel.annotations.list` should bother fetching the
 * run to attempt synthesis. The check is cheap and avoids a `getRun()`
 * round-trip when the filter clearly excludes legacy rows.
 */
export function filterCouldMatchLegacy(filters: AnnotationFilters): boolean {
  if (filters.scope !== undefined && filters.scope !== "run") return false;
  if (filters.scopeId !== undefined && filters.scopeId !== null) return false;
  if (filters.actorId !== undefined) return false;
  if (filters.actorKind !== undefined) return false;
  if (filters.attempt !== undefined && filters.attempt !== 0) return false;
  if (filters.key !== undefined && !filters.key.startsWith("legacy.metadata."))
    return false;
  if (filters.keyPrefix !== undefined) {
    // Either the prefix is a sub-prefix of "legacy.metadata." (could match)
    // or "legacy.metadata." is a sub-prefix of the filter (also could match)
    if (
      !"legacy.metadata.".startsWith(filters.keyPrefix) &&
      !filters.keyPrefix.startsWith("legacy.metadata.")
    ) {
      return false;
    }
  }
  return true;
}
