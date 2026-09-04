/**
 * Definition pinning — resolving a run against the definition it started
 * under rather than whatever the process happens to have loaded.
 *
 * The engine answers completed steps from a ledger instead of replaying
 * history, so it is a specification engine (Conductor, LittleHorse) rather
 * than a replay engine (Temporal). The answer to "the pipeline changed
 * while runs were in flight" is therefore pinning, not patching: a run
 * resolves against the definition version it was created under, and a
 * process whose build presents a different structure refuses the work so a
 * process that can serve it picks it up instead.
 *
 * Stage bodies are code and cannot be serialised, so what is pinned is the
 * structural contract (see `core/definition-version.ts`) and what enforces
 * the pin is routing: `run.claimPending` only claims runs whose version
 * this build serves, and the execution paths below refuse a run whose
 * pinned version this build does not present.
 */

import {
  buildDefinitionSnapshot,
  hashDefinitionSnapshot,
} from "../../core/definition-version.js";
import type { Workflow } from "../../core/workflow";
import type {
  ServedDefinition,
  WorkflowRunRecord,
} from "../../persistence/interface";
import {
  DefinitionVersionConflictError,
  DefinitionVersionMismatchError,
} from "../errors.js";
import type { KernelDeps, WorkflowRegistry } from "../kernel";

/**
 * Records the structural snapshot of `workflow` and returns the version to
 * stamp on a new run, or `null` on a database whose schema predates
 * definition versioning (in which case runs stay unpinned and every host
 * can serve them, exactly as before).
 *
 * Throws {@link DefinitionVersionConflictError} when an explicit version is
 * re-registered with a different structure — the one failure mode manual
 * versioning has that derived versions do not.
 */
export async function recordDefinitionVersion(
  workflow: Workflow<any, any>,
  deps: KernelDeps,
): Promise<string | null> {
  if (!deps.persistence.supportsDefinitionVersioning()) return null;

  const version = workflow.definitionVersion;
  const snapshot = workflow.getDefinitionSnapshot();
  const structureHash = hashDefinitionSnapshot(snapshot);

  const stored = await deps.persistence.insertDefinitionIfAbsent({
    workflowId: workflow.id,
    version,
    snapshot,
    structureHash,
  });
  if (!stored) return null;

  if (stored.structureHash !== structureHash) {
    throw new DefinitionVersionConflictError(
      workflow.id,
      version,
      stored.structureHash,
      structureHash,
    );
  }
  return version;
}

/**
 * Returns the workflow definition a run must be executed against, or
 * throws {@link DefinitionVersionMismatchError} when this build presents a
 * different structure than the one the run was pinned to.
 *
 * An unpinned run (`definitionVersion === null`) resolves against the live
 * definition, which is what every run did before versioning existed.
 */
export function resolvePinnedWorkflow(
  run: Pick<WorkflowRunRecord, "id" | "workflowId" | "definitionVersion">,
  deps: KernelDeps,
): Workflow<any, any> {
  const workflow = deps.registry.getWorkflow(run.workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${run.workflowId} not found in registry`);
  }
  assertServesRun(run, workflow);
  return workflow;
}

/**
 * Throws when `workflow` cannot serve `run` because the run is pinned to a
 * different definition version. Separated from
 * {@link resolvePinnedWorkflow} for call sites that already hold the
 * workflow.
 */
export function assertServesRun(
  run: Pick<WorkflowRunRecord, "id" | "workflowId" | "definitionVersion">,
  workflow: Workflow<any, any>,
): void {
  const pinned = run.definitionVersion;
  if (pinned === null || pinned === undefined) return;
  const live = workflow.definitionVersion;
  if (live === pinned) return;
  throw new DefinitionVersionMismatchError(
    run.id,
    run.workflowId,
    pinned,
    live,
  );
}

/**
 * Non-throwing form of {@link assertServesRun}, for call sites whose
 * correct response to "not my run" is to leave it alone.
 */
export function servesRun(
  run: Pick<WorkflowRunRecord, "workflowId" | "definitionVersion">,
  workflow: Workflow<any, any>,
): boolean {
  const pinned = run.definitionVersion;
  if (pinned === null || pinned === undefined) return true;
  return workflow.definitionVersion === pinned;
}

/**
 * The (workflowId, version) pairs this process is built to serve, or
 * `undefined` when the registry cannot enumerate its workflows — in which
 * case claiming stays unfiltered, i.e. the pre-1.0 behaviour.
 *
 * Wire `createWorkflowRegistry` (or any registry with `listWorkflows`) to
 * turn version-filtered claiming on.
 */
export function servedDefinitions(
  registry: WorkflowRegistry,
): ServedDefinition[] | undefined {
  const workflows = registry.listWorkflows?.();
  if (!workflows) return undefined;
  return workflows.map((workflow) => ({
    workflowId: workflow.id,
    version: workflow.definitionVersion,
  }));
}

/**
 * Rebuilds the structural snapshot of a live definition. Exposed so the
 * shadow tooling and `run.listVersions` can compare a candidate build with
 * what a run was pinned to without importing the core module directly.
 */
export function snapshotOf(workflow: Workflow<any, any>) {
  return buildDefinitionSnapshot(workflow);
}
