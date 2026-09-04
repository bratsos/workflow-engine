/**
 * Shadowing - checking a candidate pipeline against runs that already exist.
 *
 * Definition pinning stops a pipeline change from corrupting a run that is
 * already in flight: the run resolves against the version it was created
 * under, and a host presenting a different structure refuses it. What
 * pinning does not do is tell you, before you deploy, that your change is
 * incompatible. It just leaves those runs waiting for a host that no longer
 * exists.
 *
 * Cadence closes that gap with a Workflow Shadower: sample production runs,
 * fetch their histories, replay them against a candidate build. The
 * step-ledger analogue is what this module does - take recorded runs, and
 * check that the candidate definition could still have executed them. Wire
 * it into a test so an incompatible change fails a build rather than a
 * production run.
 *
 * What it verifies: the structural contract (stage membership, execution
 * groups, definition order), the stored per-stage config against the
 * candidate's config schema, and a completed stage's recorded output
 * against the candidate's output schema.
 *
 * What it cannot verify, and does not pretend to: that a stage body will
 * emit the same `ctx.step` keys. Step keys are produced by running the
 * code, so no static check can know them. Recorded step ids are reported
 * per stage so a change is diagnosable, and a stage the candidate removes
 * while it still holds step records is flagged - but a body that quietly
 * renames a step key is only caught by executing it.
 */

import {
  type DefinitionDrift,
  type DefinitionSnapshot,
  diffDefinitionSnapshots,
} from "../core/definition-version.js";
import type { Workflow } from "../core/workflow.js";
import type { StepLedger } from "../kernel/ports.js";
import type {
  WorkflowPersistence,
  WorkflowRunRecord,
  WorkflowStageRecord,
} from "../persistence/interface.js";

/** How a candidate definition can be incompatible with a recorded run. */
export type ShadowIssueCode =
  /** No candidate was supplied for the run's workflow id. */
  | "WORKFLOW_MISSING"
  /** A stage the run recorded is not in the candidate. */
  | "STAGE_REMOVED"
  /** A recorded stage sits in a different execution group. */
  | "EXECUTION_GROUP_CHANGED"
  /** A recorded stage sits at a different position in definition order. */
  | "STAGE_ORDER_CHANGED"
  /** The candidate adds a stage at or before a group this run already passed. */
  | "STAGE_INSERTED_BEFORE_CURSOR"
  /** The run's stored config for a stage fails the candidate's config schema. */
  | "CONFIG_REJECTED"
  /** A completed stage's recorded output fails the candidate's output schema. */
  | "OUTPUT_REJECTED"
  /** A removed stage still holds durable step records. */
  | "STEP_LEDGER_ORPHANED"
  /** Pinned and candidate snapshots differ in a way no other issue covered. */
  | "SNAPSHOT_DRIFT";

/** One reason a candidate definition could not have executed a recorded run. */
export interface ShadowIssue {
  readonly code: ShadowIssueCode;
  readonly stageId?: string;
  /** A complete sentence naming the run, the stage and the change. */
  readonly message: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

/** The verdict for one recorded run. */
export interface ShadowRunResult {
  readonly workflowRunId: string;
  readonly workflowId: string;
  /** The version the run was pinned to; `null` for runs created before versioning. */
  readonly pinnedVersion: string | null;
  /** The candidate's version, or `null` when no candidate matched. */
  readonly candidateVersion: string | null;
  /** Stage ids the run has records for, in recorded order. */
  readonly recordedStages: readonly string[];
  /** Recorded durable step ids per stage id; empty when no `stepLedger` was supplied. */
  readonly recordedSteps: Readonly<Record<string, readonly string[]>>;
  readonly issues: readonly ShadowIssue[];
  readonly compatible: boolean;
}

/** The verdict across every run checked. */
export interface ShadowReport {
  readonly runs: readonly ShadowRunResult[];
  readonly compatible: readonly ShadowRunResult[];
  readonly incompatible: readonly ShadowRunResult[];
  /** True when nothing is incompatible. */
  readonly ok: boolean;
}

/** Input to {@link shadowRuns}. */
export interface ShadowRunsOptions {
  /** Read surface over recorded runs. A real or in-memory adapter both work. */
  readonly persistence: Pick<
    WorkflowPersistence,
    | "getRun"
    | "getStagesByRun"
    | "getDefinition"
    | "supportsDefinitionVersioning"
  >;
  /** The build being proposed: one entry per workflow id it defines. */
  readonly candidates: ReadonlyArray<Workflow<any, any>>;
  /** The runs to replay. */
  readonly runIds: readonly string[];
  /**
   * When supplied, each stage's durable step ids are read and reported, and
   * a removed stage that still holds step records raises
   * `STEP_LEDGER_ORPHANED`.
   */
  readonly stepLedger?: Pick<StepLedger, "list">;
  /**
   * When supplied, a completed stage whose output was written to the blob
   * store is fetched and validated against the candidate's output schema.
   * Without it, only inline outputs are validated.
   */
  readonly blobStore?: { get(key: string): Promise<unknown> };
}

interface StructuralSchema {
  safeParse(data: unknown): { success: boolean; error?: { message: string } };
}

/**
 * Validates against a schema without importing Zod, so a consumer using a
 * different Standard Schema implementation still gets the check. A value
 * that does not look like a schema is treated as valid.
 */
function validate(
  schema: unknown,
  data: unknown,
): { success: boolean; error?: string } {
  if (
    schema !== null &&
    typeof schema === "object" &&
    typeof (schema as StructuralSchema).safeParse === "function"
  ) {
    const result = (schema as StructuralSchema).safeParse(data);
    return { success: result.success, error: result.error?.message };
  }
  return { success: true };
}

/** Adapters may store the snapshot as JSON or as a text column. */
function parseSnapshot(raw: unknown): DefinitionSnapshot | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as DefinitionSnapshot;
    } catch {
      return null;
    }
  }
  if (raw !== null && typeof raw === "object") {
    return raw as DefinitionSnapshot;
  }
  return null;
}

function removedStageIssues(
  run: WorkflowRunRecord,
  stage: WorkflowStageRecord,
  stepIds: readonly string[],
): ShadowIssue[] {
  const issues: ShadowIssue[] = [
    {
      code: "STAGE_REMOVED",
      stageId: stage.stageId,
      message: `Stage "${stage.stageId}", which run ${run.id} has a record for, is not in the candidate definition of workflow "${run.workflowId}".`,
      before: {
        executionGroup: stage.executionGroup,
        stageNumber: stage.stageNumber,
      },
    },
  ];
  if (stepIds.length > 0) {
    issues.push({
      code: "STEP_LEDGER_ORPHANED",
      stageId: stage.stageId,
      message: `Removing stage "${stage.stageId}" would strand ${stepIds.length} durable step record(s) recorded by run ${run.id}.`,
      before: stepIds,
    });
  }
  return issues;
}

/**
 * Checks that each named run could still have been executed by the
 * candidate definitions.
 *
 * @throws when a run id does not exist — a typo in a test should be loud,
 *   not a silent pass.
 */
export async function shadowRuns(
  options: ShadowRunsOptions,
): Promise<ShadowReport> {
  const runs: ShadowRunResult[] = [];

  for (const runId of options.runIds) {
    const run = await options.persistence.getRun(runId);
    if (!run) {
      throw new Error(
        `Cannot shadow run ${runId}: no such run exists in this persistence adapter.`,
      );
    }

    const candidate = options.candidates.find((c) => c.id === run.workflowId);
    if (!candidate) {
      runs.push({
        workflowRunId: run.id,
        workflowId: run.workflowId,
        pinnedVersion: run.definitionVersion,
        candidateVersion: null,
        recordedStages: [],
        recordedSteps: {},
        issues: [
          {
            code: "WORKFLOW_MISSING",
            message: `No candidate definition was supplied for workflow "${run.workflowId}", which run ${run.id} belongs to.`,
          },
        ],
        compatible: false,
      });
      continue;
    }

    const stages = await options.persistence.getStagesByRun(runId);
    const recordedStages = stages.map((s) => s.stageId);
    const recordedSteps: Record<string, readonly string[]> = {};
    const issues: ShadowIssue[] = [];

    // How far the run actually got: a PENDING stage record has not run.
    const executed = stages.filter((s) => s.status !== "PENDING");
    const cursor =
      executed.length > 0
        ? Math.max(...executed.map((s) => s.executionGroup))
        : 0;

    for (const stage of stages) {
      let stepIds: readonly string[] = [];
      if (options.stepLedger) {
        const records = await options.stepLedger.list(stage.id);
        stepIds = records.map((r) => r.stepId);
        recordedSteps[stage.stageId] = stepIds;
      }

      const candidateStage = candidate.getStage(stage.stageId);
      if (!candidateStage) {
        issues.push(...removedStageIssues(run, stage, stepIds));
        continue;
      }

      const candidateGroup = candidate.getExecutionGroupIndex(stage.stageId);
      if (candidateGroup !== stage.executionGroup) {
        issues.push({
          code: "EXECUTION_GROUP_CHANGED",
          stageId: stage.stageId,
          message: `Stage "${stage.stageId}" was recorded by run ${run.id} in execution group ${stage.executionGroup}, but the candidate puts it in execution group ${candidateGroup}.`,
          before: stage.executionGroup,
          after: candidateGroup,
        });
      }

      const candidateNumber = candidate.getStageIndex(stage.stageId) + 1;
      if (candidateNumber !== stage.stageNumber) {
        issues.push({
          code: "STAGE_ORDER_CHANGED",
          stageId: stage.stageId,
          message: `Stage "${stage.stageId}" was recorded by run ${run.id} at position ${stage.stageNumber}, but the candidate puts it at position ${candidateNumber} in definition order.`,
          before: stage.stageNumber,
          after: candidateNumber,
        });
      }

      if (stage.config !== null && typeof stage.config === "object") {
        const parsed = validate(candidateStage.configSchema, stage.config);
        if (!parsed.success) {
          issues.push({
            code: "CONFIG_REJECTED",
            stageId: stage.stageId,
            message: `The config run ${run.id} stored for stage "${stage.stageId}" is rejected by the candidate's config schema.`,
            before: stage.config,
            after: parsed.error,
          });
        }
      }

      if (stage.status === "COMPLETED") {
        const output = await resolveRecordedOutput(stage, options.blobStore);
        if (output.resolved) {
          const parsed = validate(candidateStage.outputSchema, output.value);
          if (!parsed.success) {
            issues.push({
              code: "OUTPUT_REJECTED",
              stageId: stage.stageId,
              message: `The output run ${run.id} recorded for stage "${stage.stageId}" is rejected by the candidate's output schema.`,
              before: output.value,
              after: parsed.error,
            });
          }
        }
      }
    }

    // A stage the candidate adds at or before the group this run has
    // already passed would never execute for this run.
    const recorded = new Set(recordedStages);
    for (const stageId of candidate.getStageIds()) {
      if (recorded.has(stageId)) continue;
      const group = candidate.getExecutionGroupIndex(stageId);
      if (group > cursor) continue;
      issues.push({
        code: "STAGE_INSERTED_BEFORE_CURSOR",
        stageId,
        message: `The candidate adds stage "${stageId}" in execution group ${group}, but run ${run.id} has already executed through group ${cursor}, so it would never run that stage.`,
        before: { cursor },
        after: { executionGroup: group },
      });
    }

    // Anything the per-stage checks did not already cover, from the pinned
    // snapshot itself. A stage added after the cursor is legitimate and is
    // deliberately not reported.
    if (
      run.definitionVersion !== null &&
      options.persistence.supportsDefinitionVersioning()
    ) {
      const stored = await options.persistence.getDefinition(
        run.workflowId,
        run.definitionVersion,
      );
      const pinned = stored ? parseSnapshot(stored.snapshot) : null;
      if (pinned) {
        const covered = new Set(
          issues
            .map((issue) => issue.stageId)
            .filter((id): id is string => typeof id === "string"),
        );
        for (const drift of diffDefinitionSnapshots(
          pinned,
          candidate.getDefinitionSnapshot(),
        )) {
          if (drift.code === "STAGE_ADDED") continue;
          if (drift.stageId !== undefined && covered.has(drift.stageId)) {
            continue;
          }
          issues.push({
            code: "SNAPSHOT_DRIFT",
            ...(drift.stageId !== undefined ? { stageId: drift.stageId } : {}),
            message: drift.message,
            before: drift.before,
            after: drift.after,
          });
        }
      }
    }

    runs.push({
      workflowRunId: run.id,
      workflowId: run.workflowId,
      pinnedVersion: run.definitionVersion,
      candidateVersion: candidate.definitionVersion,
      recordedStages,
      recordedSteps,
      issues,
      compatible: issues.length === 0,
    });
  }

  const compatible = runs.filter((r) => r.compatible);
  const incompatible = runs.filter((r) => !r.compatible);
  return { runs, compatible, incompatible, ok: incompatible.length === 0 };
}

async function resolveRecordedOutput(
  stage: WorkflowStageRecord,
  blobStore: { get(key: string): Promise<unknown> } | undefined,
): Promise<{ resolved: boolean; value?: unknown }> {
  const output = stage.outputData;
  if (output === null || typeof output !== "object") return { resolved: false };

  const artifactKey = (output as Record<string, unknown>)._artifactKey;
  if (typeof artifactKey !== "string") {
    return { resolved: true, value: output };
  }
  if (!blobStore) return { resolved: false };
  try {
    return { resolved: true, value: await blobStore.get(artifactKey) };
  } catch {
    // A blob that has aged out is not a compatibility finding.
    return { resolved: false };
  }
}

/** Input to {@link shadowVersions}. */
export interface ShadowVersionsOptions {
  readonly persistence: Pick<
    WorkflowPersistence,
    | "getDefinition"
    | "supportsDefinitionVersioning"
    | "countRunsByDefinitionVersion"
  >;
  /** The build being proposed: one entry per workflow id it defines. */
  readonly candidates: ReadonlyArray<Workflow<any, any>>;
  /**
   * Only versions that still have runs in these statuses are checked.
   * Defaults to the statuses in which a run still needs a host:
   * `["PENDING", "RUNNING", "SUSPENDED"]`.
   */
  readonly statuses?: readonly string[];
}

/** The verdict for one recorded definition version. */
export interface ShadowVersionResult {
  readonly workflowId: string;
  readonly version: string;
  /** Runs at this version in the statuses that were checked. */
  readonly runCount: number;
  readonly drifts: readonly DefinitionDrift[];
  readonly compatible: boolean;
}

/** The verdict across every recorded version that still has live runs. */
export interface ShadowVersionsReport {
  /** False when the adapter's schema predates definition versioning. */
  readonly supported: boolean;
  readonly versions: readonly ShadowVersionResult[];
  readonly incompatible: readonly ShadowVersionResult[];
  readonly ok: boolean;
}

/**
 * The CI sweep: check every recorded definition version that still has live
 * runs against the build you are about to deploy. Needs no run ids — it
 * finds the versions itself.
 */
export async function shadowVersions(
  options: ShadowVersionsOptions,
): Promise<ShadowVersionsReport> {
  if (!options.persistence.supportsDefinitionVersioning()) {
    return { supported: false, versions: [], incompatible: [], ok: true };
  }

  const statuses = new Set(
    options.statuses ?? ["PENDING", "RUNNING", "SUSPENDED"],
  );
  const rows = await options.persistence.countRunsByDefinitionVersion();

  const groups = new Map<
    string,
    { workflowId: string; version: string; runCount: number }
  >();
  for (const row of rows) {
    // An unpinned run has no recorded structure to compare against.
    if (row.definitionVersion === null) continue;
    if (!statuses.has(row.status)) continue;
    const key = `${row.workflowId}\u0000${row.definitionVersion}`;
    const existing = groups.get(key);
    if (existing) {
      existing.runCount += row.count;
    } else {
      groups.set(key, {
        workflowId: row.workflowId,
        version: row.definitionVersion,
        runCount: row.count,
      });
    }
  }

  const versions: ShadowVersionResult[] = [];
  for (const group of groups.values()) {
    const candidate = options.candidates.find((c) => c.id === group.workflowId);
    if (!candidate) {
      versions.push({
        workflowId: group.workflowId,
        version: group.version,
        runCount: group.runCount,
        drifts: [
          {
            code: "STAGE_REMOVED",
            message: `No candidate definition was supplied for workflow "${group.workflowId}", which still has ${group.runCount} live run(s) at version "${group.version}".`,
          },
        ],
        compatible: false,
      });
      continue;
    }

    const stored = await options.persistence.getDefinition(
      group.workflowId,
      group.version,
    );
    const pinned = stored ? parseSnapshot(stored.snapshot) : null;
    // No recorded structure means nothing to compare; not a finding.
    if (!pinned) continue;

    const drifts = diffDefinitionSnapshots(
      pinned,
      candidate.getDefinitionSnapshot(),
    );
    versions.push({
      workflowId: group.workflowId,
      version: group.version,
      runCount: group.runCount,
      drifts,
      compatible: drifts.length === 0,
    });
  }

  const incompatible = versions.filter((v) => !v.compatible);
  return {
    supported: true,
    versions,
    incompatible,
    ok: incompatible.length === 0,
  };
}

/**
 * Throws a readable report when anything is incompatible, and returns
 * silently otherwise. Call it from a test so an incompatible pipeline
 * change fails a build rather than a production run.
 */
export function assertShadowCompatible(
  report: ShadowReport | ShadowVersionsReport,
): void {
  if (report.ok) return;

  const lines: string[] = [];
  if ("runs" in report) {
    lines.push(
      `${report.incompatible.length} of ${report.runs.length} recorded run(s) cannot be executed by the candidate definition:`,
    );
    for (const run of report.incompatible) {
      lines.push(`run ${run.workflowRunId} (workflow "${run.workflowId}"):`);
      for (const issue of run.issues) lines.push(`  ${issue.message}`);
    }
  } else {
    lines.push(
      `${report.incompatible.length} of ${report.versions.length} recorded definition version(s) cannot be executed by the candidate definition:`,
    );
    for (const version of report.incompatible) {
      lines.push(
        `workflow "${version.workflowId}" version "${version.version}" (${version.runCount} live run(s)):`,
      );
      for (const drift of version.drifts) lines.push(`  ${drift.message}`);
    }
  }
  throw new Error(lines.join("\n"));
}
