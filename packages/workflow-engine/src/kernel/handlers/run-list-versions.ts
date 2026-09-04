/**
 * Handler: run.listVersions
 *
 * The operator's answer to "has this definition version drained?" - and,
 * more importantly, to "is anything stuck at a version nobody serves?".
 *
 * Pinning makes a rolling deploy safe by construction, but it introduces a
 * failure mode that unpinned execution does not have: a run whose version
 * no live process presents has no host. That must be visible rather than
 * silent, so this command reports it directly instead of leaving it to be
 * inferred from a run that never moves.
 */

import type {
  DefinitionVersionSummary,
  RunListVersionsCommand,
  RunListVersionsResult,
} from "../commands";
import { servedDefinitions } from "../helpers/definition-pinning.js";
import type { HandlerResult, KernelDeps } from "../kernel";

/** Statuses in which a run still needs a host to make progress. */
const ACTIVE_STATUSES = new Set(["PENDING", "RUNNING", "SUSPENDED"]);

export async function handleRunListVersions(
  command: RunListVersionsCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunListVersionsResult>> {
  if (!deps.persistence.supportsDefinitionVersioning()) {
    return { supported: false, versions: [], unservedHere: [], _events: [] };
  }

  const counts = await deps.persistence.countRunsByDefinitionVersion({
    workflowId: command.workflowId,
    definitionVersion: command.definitionVersion,
  });

  // What this process serves. A registry that cannot enumerate still
  // answers per workflow id, which is enough to decide `servedHere`.
  const served = servedDefinitions(deps.registry);
  const servesPair = (workflowId: string, version: string | null): boolean => {
    if (version === null) return true; // unpinned runs are served by everyone
    if (served) {
      return served.some(
        (s) => s.workflowId === workflowId && s.version === version,
      );
    }
    return deps.registry.getWorkflow(workflowId)?.definitionVersion === version;
  };

  const buckets = new Map<
    string,
    {
      workflowId: string;
      definitionVersion: string | null;
      counts: Record<string, number>;
      total: number;
      active: number;
      oldestCreatedAt: Date | null;
    }
  >();

  for (const row of counts) {
    const key = `${row.workflowId} ${row.definitionVersion ?? ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        workflowId: row.workflowId,
        definitionVersion: row.definitionVersion,
        counts: {},
        total: 0,
        active: 0,
        oldestCreatedAt: null,
      };
      buckets.set(key, bucket);
    }
    bucket.counts[row.status] = (bucket.counts[row.status] ?? 0) + row.count;
    bucket.total += row.count;
    if (ACTIVE_STATUSES.has(row.status)) bucket.active += row.count;
    if (
      row.oldestCreatedAt !== null &&
      (bucket.oldestCreatedAt === null ||
        row.oldestCreatedAt < bucket.oldestCreatedAt)
    ) {
      bucket.oldestCreatedAt = row.oldestCreatedAt;
    }
  }

  const versions: DefinitionVersionSummary[] = Array.from(buckets.values())
    .map((bucket) => ({
      workflowId: bucket.workflowId,
      definitionVersion: bucket.definitionVersion,
      counts: bucket.counts,
      total: bucket.total,
      active: bucket.active,
      drained: bucket.active === 0,
      servedHere: servesPair(bucket.workflowId, bucket.definitionVersion),
      oldestCreatedAt: bucket.oldestCreatedAt,
    }))
    // Newest first; unpinned runs (no version) sort last so the versions
    // an operator is deciding about are at the top.
    .sort((a, b) => {
      if (a.definitionVersion === null) return 1;
      if (b.definitionVersion === null) return -1;
      const at = a.oldestCreatedAt?.getTime() ?? 0;
      const bt = b.oldestCreatedAt?.getTime() ?? 0;
      if (at !== bt) return bt - at;
      return a.definitionVersion.localeCompare(b.definitionVersion);
    });

  return {
    supported: true,
    versions,
    unservedHere: versions.filter((v) => !v.servedHere && v.active > 0),
    _events: [],
  };
}
