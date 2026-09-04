/**
 * Definition versioning — the structural contract a run is pinned to.
 *
 * A workflow run must not silently change shape because the pipeline was
 * edited while the run was in flight. To make that impossible the engine
 * stamps every run with a *definition version* and stores the structure
 * that version identifies as a content-addressed snapshot.
 *
 * What the version identifies is the pipeline's **structural contract**:
 * the ordered stage ids, their execution groups, their declared
 * dependencies and modes, and the normalised JSON Schema of every stage's
 * input, output and config schema, plus the workflow's own input/output
 * schemas. That is exactly the set of facts a recorded run depends on:
 * stage rows are keyed by `stageId` and carry `stageNumber` /
 * `executionGroup`, and stored configs and outputs are validated against
 * the stage schemas.
 *
 * Deliberately **excluded** from the version: stage `name` and
 * `description`, the `execute` and `checkCompletion` function bodies, and
 * `estimateCost`. Hashing source (DBOS's default) forks every in-flight
 * run on a reformat or a log-line edit; hashing the contract (LittleHorse's
 * `majorVersion`) forks only when a run's recorded shape could actually
 * stop lining up. Behaviour changes inside a stage body are a deploy
 * concern, not a run-compatibility concern.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

// ============================================================================
// Structural read surfaces (type-only, so this module has no import cycle
// with core/workflow.ts, which imports it)
// ============================================================================

/** The read surface of a stage that a definition snapshot is derived from. */
export interface DefinableStage {
  readonly id: string;
  readonly dependencies?: readonly string[];
  readonly mode?: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly configSchema: unknown;
}

/** The read surface of a built workflow that a definition snapshot is derived from. */
export interface DefinableWorkflow {
  readonly id: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  getAllStages(): ReadonlyArray<{
    stage: DefinableStage;
    executionGroup: number;
  }>;
}

// ============================================================================
// Canonical JSON
// ============================================================================

function canonicalizeInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return { $circular: true };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalizeInternal(item, seen));
    }
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      result[key] = canonicalizeInternal(source[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/**
 * Recursively sorts object keys ascending, preserving array order and
 * passing primitives through, so that two structurally identical values
 * always stringify identically. A cycle is replaced with
 * `{ $circular: true }` rather than throwing.
 */
export function canonicalize(value: unknown): unknown {
  return canonicalizeInternal(value, new WeakSet<object>());
}

/** `JSON.stringify` over {@link canonicalize}, i.e. key-order-independent. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// ============================================================================
// The snapshot
// ============================================================================

/** Bumped only when the *shape* of a snapshot changes, so old snapshots stay readable. */
export const DEFINITION_SNAPSHOT_FORMAT = 1;

/** The structural contract of one stage, as stored in a definition snapshot. */
export interface DefinitionStageSnapshot {
  /** Stage id — the key the engine writes on every stage row and step ledger entry. */
  readonly id: string;
  /** 1-based position in definition order (matches `workflow_stages.stageNumber`). */
  readonly stageNumber: number;
  /** Parallel-group index (matches `workflow_stages.executionGroup`). */
  readonly executionGroup: number;
  /** Declared dependencies, sorted for stability. Absent when the stage declares none. */
  readonly dependencies?: readonly string[];
  /** Stage mode, when the stage declares one. */
  readonly mode?: string;
  /** Normalised JSON Schema of the stage's input schema, or null when absent. */
  readonly inputSchema: unknown;
  /** Normalised JSON Schema of the stage's output schema, or null when absent. */
  readonly outputSchema: unknown;
  /** Normalised JSON Schema of the stage's config schema, or null when absent. */
  readonly configSchema: unknown;
}

/** The full structural contract of a workflow definition. */
export interface DefinitionSnapshot {
  /** {@link DEFINITION_SNAPSHOT_FORMAT} at the time the snapshot was written. */
  readonly format: number;
  /** The workflow id the snapshot belongs to. */
  readonly workflowId: string;
  /** Normalised JSON Schema of the workflow's input schema. */
  readonly inputSchema: unknown;
  /** Normalised JSON Schema of the workflow's output schema. */
  readonly outputSchema: unknown;
  /** Every stage, in definition order. */
  readonly stages: readonly DefinitionStageSnapshot[];
}

/**
 * Normalises a Zod schema to a canonical JSON Schema. Returns `null` for a
 * missing schema and `{ $unrepresentable: true }` when Zod cannot express
 * it, so one exotic field never prevents a definition from being versioned.
 */
export function toStableJsonSchema(schema: unknown): unknown {
  if (schema === null || schema === undefined) return null;
  try {
    return canonicalize(
      z.toJSONSchema(schema as z.ZodTypeAny, {
        unrepresentable: "any",
        io: "input",
      }),
    );
  } catch {
    return { $unrepresentable: true };
  }
}

/** Derives the serialisable structural contract of a built workflow. */
export function buildDefinitionSnapshot(
  workflow: DefinableWorkflow,
): DefinitionSnapshot {
  const stages = workflow.getAllStages().map((node, index) => {
    const { stage, executionGroup } = node;
    const deps = stage.dependencies;
    const sortedDeps = deps && deps.length > 0 ? [...deps].sort() : undefined;
    const snapshot: DefinitionStageSnapshot = {
      id: stage.id,
      stageNumber: index + 1,
      executionGroup,
      ...(sortedDeps !== undefined ? { dependencies: sortedDeps } : {}),
      ...(stage.mode !== undefined ? { mode: stage.mode } : {}),
      inputSchema: toStableJsonSchema(stage.inputSchema),
      outputSchema: toStableJsonSchema(stage.outputSchema),
      configSchema: toStableJsonSchema(stage.configSchema),
    };
    return snapshot;
  });

  return {
    format: DEFINITION_SNAPSHOT_FORMAT,
    workflowId: workflow.id,
    inputSchema: toStableJsonSchema(workflow.inputSchema),
    outputSchema: toStableJsonSchema(workflow.outputSchema),
    stages,
  };
}

// ============================================================================
// The version
// ============================================================================

/** Prefix identifying how a derived version was computed, so the scheme can evolve. */
export const DERIVED_VERSION_PREFIX = "sha256-";

/** Hashes a snapshot that was already built (e.g. loaded back from storage). */
export function hashDefinitionSnapshot(snapshot: DefinitionSnapshot): string {
  const digest = createHash("sha256")
    .update(stableStringify(snapshot))
    .digest("hex")
    .slice(0, 32);
  return `${DERIVED_VERSION_PREFIX}${digest}`;
}

/** Derives the definition version of a built workflow from its structure. */
export function computeDefinitionVersion(workflow: DefinableWorkflow): string {
  return hashDefinitionSnapshot(buildDefinitionSnapshot(workflow));
}

/** True when a version string was derived rather than declared by hand. */
export function isDerivedVersion(version: string): boolean {
  return (
    typeof version === "string" && version.startsWith(DERIVED_VERSION_PREFIX)
  );
}

// ============================================================================
// Structural comparison
// ============================================================================

/** The kinds of structural difference {@link diffDefinitionSnapshots} reports. */
export type DefinitionDriftCode =
  | "STAGE_REMOVED"
  | "STAGE_ADDED"
  | "EXECUTION_GROUP_CHANGED"
  | "STAGE_ORDER_CHANGED"
  | "DEPENDENCIES_CHANGED"
  | "STAGE_MODE_CHANGED"
  | "STAGE_SCHEMA_CHANGED"
  | "WORKFLOW_SCHEMA_CHANGED";

/** One structural difference between two definition snapshots. */
export interface DefinitionDrift {
  /** Machine-readable classification. */
  readonly code: DefinitionDriftCode;
  /** The stage the difference is about, for stage-scoped codes. */
  readonly stageId?: string;
  /** A complete sentence naming the stage and the change. */
  readonly message: string;
  /** The pinned side of the difference. */
  readonly before?: unknown;
  /** The candidate side of the difference. */
  readonly after?: unknown;
}

function schemaDrift(
  stageId: string,
  which: "input" | "output" | "config",
  before: unknown,
  after: unknown,
): DefinitionDrift | undefined {
  if (stableStringify(before) === stableStringify(after)) return undefined;
  return {
    code: "STAGE_SCHEMA_CHANGED",
    stageId,
    message: `Stage "${stageId}" ${which} schema changed.`,
    before,
    after,
  };
}

/**
 * Compares a pinned snapshot with a candidate one and reports every
 * structural difference. An empty array means the candidate can serve
 * runs pinned to the snapshot.
 *
 * Ordering: workflow-level differences first, then per stage in pinned
 * order, then stages the candidate added.
 */
export function diffDefinitionSnapshots(
  pinned: DefinitionSnapshot,
  candidate: DefinitionSnapshot,
): DefinitionDrift[] {
  const drifts: DefinitionDrift[] = [];

  if (
    stableStringify(pinned.inputSchema) !==
    stableStringify(candidate.inputSchema)
  ) {
    drifts.push({
      code: "WORKFLOW_SCHEMA_CHANGED",
      message: `Workflow "${pinned.workflowId}" input schema changed.`,
      before: pinned.inputSchema,
      after: candidate.inputSchema,
    });
  }
  if (
    stableStringify(pinned.outputSchema) !==
    stableStringify(candidate.outputSchema)
  ) {
    drifts.push({
      code: "WORKFLOW_SCHEMA_CHANGED",
      message: `Workflow "${pinned.workflowId}" output schema changed.`,
      before: pinned.outputSchema,
      after: candidate.outputSchema,
    });
  }

  const candidateById = new Map(candidate.stages.map((s) => [s.id, s]));
  const pinnedIds = new Set(pinned.stages.map((s) => s.id));

  for (const before of pinned.stages) {
    const after = candidateById.get(before.id);
    if (!after) {
      drifts.push({
        code: "STAGE_REMOVED",
        stageId: before.id,
        message: `Stage "${before.id}" is no longer in the workflow.`,
        before: {
          executionGroup: before.executionGroup,
          stageNumber: before.stageNumber,
        },
      });
      continue;
    }

    if (before.executionGroup !== after.executionGroup) {
      drifts.push({
        code: "EXECUTION_GROUP_CHANGED",
        stageId: before.id,
        message: `Stage "${before.id}" moved from execution group ${before.executionGroup} to execution group ${after.executionGroup}.`,
        before: before.executionGroup,
        after: after.executionGroup,
      });
    }
    if (before.stageNumber !== after.stageNumber) {
      drifts.push({
        code: "STAGE_ORDER_CHANGED",
        stageId: before.id,
        message: `Stage "${before.id}" moved from position ${before.stageNumber} to position ${after.stageNumber} in definition order.`,
        before: before.stageNumber,
        after: after.stageNumber,
      });
    }
    if (
      stableStringify(before.dependencies ?? []) !==
      stableStringify(after.dependencies ?? [])
    ) {
      drifts.push({
        code: "DEPENDENCIES_CHANGED",
        stageId: before.id,
        message: `Stage "${before.id}" declared dependencies changed from [${(before.dependencies ?? []).join(", ")}] to [${(after.dependencies ?? []).join(", ")}].`,
        before: before.dependencies,
        after: after.dependencies,
      });
    }
    if (before.mode !== after.mode) {
      drifts.push({
        code: "STAGE_MODE_CHANGED",
        stageId: before.id,
        message: `Stage "${before.id}" mode changed from ${before.mode ? `"${before.mode}"` : "none"} to ${after.mode ? `"${after.mode}"` : "none"}.`,
        before: before.mode,
        after: after.mode,
      });
    }

    for (const drift of [
      schemaDrift(before.id, "input", before.inputSchema, after.inputSchema),
      schemaDrift(before.id, "output", before.outputSchema, after.outputSchema),
      schemaDrift(before.id, "config", before.configSchema, after.configSchema),
    ]) {
      if (drift) drifts.push(drift);
    }
  }

  for (const added of candidate.stages) {
    if (pinnedIds.has(added.id)) continue;
    drifts.push({
      code: "STAGE_ADDED",
      stageId: added.id,
      message: `Stage "${added.id}" was added at position ${added.stageNumber} in execution group ${added.executionGroup}.`,
      after: {
        executionGroup: added.executionGroup,
        stageNumber: added.stageNumber,
      },
    });
  }

  return drifts;
}
