# Retry, Restart and Rerun: `run.redrive`

When a workflow run terminates unsuccessfully, recovery requires resuming execution from an appropriate point without destroying the diagnostic evidence of what failed. Rather than exposing disjoint commands for different restart patterns, `run.redrive` unifies retry, restart, and stage-specific rerun into a single transactional operation while supporting definition version migration. This reference covers the redrive command contract, execution lifecycle, attempt preservation via run annotations, durable step ledger cleanup, definition re-pinning, and migration from the deprecated `run.rerunFrom` command.

## Command modes: retry, restart and rerun

When an execution ends badly, an operator needs one of three distinct recovery actions:

- **Retry**: Pick up from the stage that failed, leaving all previously succeeded stages untouched.
- **Restart**: Re-execute the entire pipeline from the beginning, reusing the original run input.
- **Rerun**: Resume execution from a specific stage chosen by the operator, re-running that stage and all subsequent stages.

Netflix Conductor models these operations as three distinct API endpoints (`retry`, `restart`, `rerun`). The engine unifies them into the `run.redrive` command via the `from` parameter:

```typescript
interface RunRedriveCommand {
  readonly type: "run.redrive";
  readonly workflowRunId: string;
  /** Defaults to `{ kind: "lastFailure" }`. */
  readonly from?: RunRedriveFrom;
  /**
   * Re-pins the run to a different definition version.
   * - omitted: retains the run's current pinned version.
   * - "latest": re-pins to the version served by this host.
   * - string: re-pins to an existing registered definition version.
   */
  readonly definitionVersion?: string | "latest";
  /** Optional idempotency key for deduplication. */
  readonly idempotencyKey?: string;
}

type RunRedriveFrom =
  | { readonly kind: "lastFailure" }
  | { readonly kind: "start" }
  | { readonly kind: "stage"; readonly stageId: string };
```

### Resume resolution

The `from` parameter dictates the resume point:

- `{ kind: "lastFailure" }` (default): Scans existing stage records ordered by execution group and definition index, and resumes at the earliest stage that is not `COMPLETED`. In practice, this is the stage that failed or was interrupted. If every stage record is `COMPLETED` (e.g., retrying a finished run with updated external resources), it re-runs the final stage, matching Conductor's retry semantics for completed workflows.
- `{ kind: "start" }`: Resumes at the first stage of execution group 1, re-executing the entire workflow from scratch.
- `{ kind: "stage", stageId: string }`: Resumes at the designated stage. The stage must exist in the workflow definition, and any execution groups preceding `stageId` must have existing completed stage records.

The target run must be in a terminal status: `COMPLETED`, `FAILED`, or `CANCELLED`. Invoking `run.redrive` on a `PENDING`, `RUNNING`, or `SUSPENDED` run throws an error.

### Result shape

```typescript
interface RunRedriveResult {
  readonly workflowRunId: string;
  readonly fromStageId: string;
  readonly supersededStages: string[];
  readonly redriveCount: number;
  readonly definitionVersion: string | null;
}
```

- `workflowRunId`: The identifier of the redriven run.
- `fromStageId`: The stage identifier where execution resumed.
- `supersededStages`: Array of stage identifiers whose records were deleted and archived.
- `redriveCount`: The updated total redrive count for this run.
- `definitionVersion`: The definition version pinned to the run following the redrive.

## Run identity and execution lifecycle

The engine implements AWS Step Functions' redrive model: the run retains its original `id`. History is appended to the existing execution record rather than branched into a secondary execution:

- `workflow_runs.redriveCount` increments by 1 on each redrive. This counter tracks the total number of redrives over the entire lifetime of the run and is never reset.
- The run record transitions to `RUNNING`: `startedAt` is updated to the current clock time, and `completedAt`, `duration`, `output`, `totalCost`, and `totalTokens` are reset to clean initial states.
- Downstream stage records (those belonging to execution groups greater than or equal to the target stage's execution group) are removed from `workflow_stages`.
- In-flight or pending jobs associated with superseded stages are deleted from `job_queue` via `jobTransport.deleteByRunAndStages`.
- Stage records for the resumed execution group are recreated with an incremented attempt generation (`attemptMode: "max+1"`).

```typescript
import { createKernel } from "@bratsos/workflow-engine";

const result = await kernel.dispatch({
  type: "run.redrive",
  workflowRunId: "run-4815162342",
  from: { kind: "lastFailure" },
});

console.log(result.redriveCount);      // 1
console.log(result.fromStageId);       // "summarise"
console.log(result.supersededStages);  // ["summarise", "publish"]
```

## Attempt preservation via annotations

Older recovery implementations (`run.rerunFrom`) deleted failed stage records outright, erasing the error messages, metrics, and timings of the failure being retried.

`run.redrive` archives every stage record it removes as a stage-scoped annotation before deletion. The archival write occurs in the exact same database transaction as the stage deletion, ensuring that if the transaction rolls back, the archive rolls back with it.

### Archive structure

Archived attempts are stored under the annotation key `run.supersededAttempt`, exported as the constant `SUPERSEDED_ATTEMPT_KEY`:

```typescript
export const SUPERSEDED_ATTEMPT_KEY = "run.supersededAttempt";
```

Each superseded stage record produces an annotation with the following structure:

- `key`: `"run.supersededAttempt"`
- `scope`: `"stage"`
- `scopeId`: The `stageId` of the superseded stage
- `attempt`: The `attempt` generation of the superseded stage record
- `actor`: `{ kind: "engine", id: "run.redrive" }`
- `value`: The stage's status at the time of archival (`"FAILED"`, `"COMPLETED"`, etc.)
- `idempotencyKey`: `run.supersededAttempt:${stage.id}:${stage.attempt}`
- `payload`: A JSON object capturing stage execution state:

```typescript
interface SupersededAttemptPayload {
  readonly redriveCount: number;
  readonly stageRecordId: string;
  readonly stageNumber: number;
  readonly executionGroup: number;
  readonly attempt: number;
  readonly status: string;
  readonly errorMessage: string | null;
  readonly startedAt: string | null;   // ISO 8601 string
  readonly completedAt: string | null; // ISO 8601 string
  readonly duration: number | null;
  readonly metrics: unknown | null;
  readonly outputData: unknown | null; // Blob key pointer
  readonly definitionVersion: string | null;
}
```

`outputData` retains the blob storage pointer (e.g., `{ _artifactKey: "..." }`), not a duplicate copy of the underlying blob. A subsequent execution attempt writes to the same storage key; retaining the pointer preserves the historical fact that an output existed and where it was located without duplicating storage bytes.

### Querying superseded attempts

Archived attempts can be queried using the kernel's annotation query API:

```typescript
const attempts = await kernel.annotations.list(workflowRunId, {
  key: "run.supersededAttempt",
});

for (const record of attempts) {
  console.log(`Stage ${record.scopeId} attempt ${record.attempt} failed with:`);
  console.log((record.payload as any).errorMessage);
}
```

### Rationale and rejected alternatives

Archiving superseded attempts into the annotation system relies on existing engine guarantees:

- Annotations survive stage deletion because the database foreign key from `workflow_annotations.workflowStageRecordId` to `workflow_stages.id` specifies `onDelete: SetNull`.
- Annotations already carry an `attempt` column, allowing queries to filter across distinct execution generations.
- Annotations provide an indexed query surface (`kernel.annotations.list`) with multi-attribute filtering.

Two alternative storage strategies were considered and rejected:

1. **Relaxing the unique constraint on `workflow_stages`**: Removing `@@unique([workflowRunId, stageId])` to allow multiple rows for the same stage was rejected. Core kernel operations, pollers, and activity workers rely on `persistence.getStage(runId, stageId)` returning a single current row. Allowing multiple rows would introduce nondeterminism and require rewriting every stage query across the engine.
2. **Introducing a separate `workflow_stage_attempts` table**: Creating a dedicated table was rejected as redundant. Annotations already provide transactional writes, lifecycle decoupling via `SetNull`, and rich query APIs. A separate table would duplicate existing schema infrastructure without adding operational capability.

## Step ledger reclamation

When a stage record is superseded during a redrive, its associated durable step ledger entries are deleted via `stepLedger.clear(stage.id)`.

This cleanup occurs inside the `_postCommit` phase of `handleRunRedrive`:

```typescript
for (const stage of stagesToSupersede) {
  await postDeps.stepLedger?.clear(stage.id);
}
```

### Rationale

Durable step rows in `workflow_steps` are foreign-keyed to `stageRecordId`—the specific primary key of the stage record. When a redrive occurs, the old stage record is deleted and a fresh stage record with a new primary key is created for the next attempt.

If the old step rows were preserved in the database, no future replay could ever read them because no stage record references that `stageRecordId`. Leaving orphaned step records in `workflow_steps` would cause unbounded table growth.

This behavior is distinct from an **in-flight job retry** on a running stage: during job retries, the stage record is preserved, and steps with external keys are reopened and reclaimed. During a **redrive**, the entire stage record is replaced, and the historical record is preserved in `run.supersededAttempt` annotations.

## Redriving onto a different definition version

When an in-flight workflow encounters a software defect or edge case, deploying a fix creates a new workflow definition. Under definition pinning, runs created under the buggy version cannot be processed by the updated host build.

`run.redrive` provides the solution by allowing an operator to re-pin a terminal run onto an updated definition version (comparable to DBOS's fork-onto-a-new-application-version):

```typescript
await kernel.dispatch({
  type: "run.redrive",
  workflowRunId: "run-4815162342",
  from: { kind: "lastFailure" },
  definitionVersion: "latest",
});
```

### Version options

The `definitionVersion` property controls re-pinning:

- **Omitted**: Keeps the run's existing `pinnedVersion`. The executing host must serve this pinned version; if the host serves a different definition, `assertServesRun` throws `DefinitionVersionMismatchError`. Planning a redrive against a different pipeline graph than the host that executes it is invalid.
- `"latest"`: Re-pins the run to the definition version currently served by the local host build. If this version's snapshot has not yet been persisted, `recordDefinitionVersion` registers it in `workflow_definitions`. This mode rescues runs stranded at versions no longer served by any active worker.
- **Explicit version string**: Re-pins the run to a specific version (e.g., `"2026-09-04.1"`). The explicit version must already exist in `workflow_definitions` for that `workflowId`; if absent, the command throws an error.

## Migration from `run.rerunFrom`

The `run.rerunFrom` command is **deprecated**. It remains fully functional for backwards compatibility and shares the underlying implementation of `run.redrive`.

### Delegation and behavior

`handleRunRerunFrom` delegates directly to `handleRunRedrive`:

```typescript
const result = await handleRunRedrive(
  {
    type: "run.redrive",
    workflowRunId,
    from: { kind: "stage", stageId: fromStageId },
    idempotencyKey: command.idempotencyKey,
  },
  deps,
);

return {
  workflowRunId: result.workflowRunId,
  fromStageId: result.fromStageId,
  deletedStages: result.supersededStages,
  _events: result._events,
  _postCommit: result._postCommit,
};
```

Because it delegates to `run.redrive`, `run.rerunFrom` inherits attempt preservation via annotations, step ledger cleanup, and `redriveCount` tracking. Its return property `deletedStages` returns the exact stage IDs reported by `supersededStages`.

### Differences and restrictions

`run.rerunFrom` enforces a narrower contract than `run.redrive`:

- `run.rerunFrom` strictly rejects runs in `CANCELLED` status, throwing: `Cannot rerun workflow in CANCELLED state. Must be COMPLETED or FAILED.` In contrast, `run.redrive` allows redriving `CANCELLED` runs.
- `run.rerunFrom` cannot alter the workflow's pinned definition version; it always executes against the existing pinned version.

### Operational tooling notice

As a current implementation detail, the UI action `run.rerun` in `@bratsos/workflow-engine-console` dispatches `run.rerunFrom`.

### Migration snippet

To migrate existing call sites to `run.redrive`:

```typescript
// Deprecated:
await kernel.dispatch({
  type: "run.rerunFrom",
  workflowRunId,
  fromStageId: "summarise",
});

// Replacement:
await kernel.dispatch({
  type: "run.redrive",
  workflowRunId,
  from: { kind: "stage", stageId: "summarise" },
});
```

## Cross-references

- [Definition Versioning, Version-Filtered Claiming and Shadowing](./13-definition-versioning.md): Covers structural snapshots, conflict errors, and resolving stranded runs identified by `run.listVersions`.
- [Annotations — first-class provenance](./10-annotations.md): Covers annotation schema types, the `attempt` axis, and querying stage-scoped provenance records.
