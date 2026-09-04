# Definition Versioning, Version-Filtered Claiming and Shadowing

A workflow definition changes every time you deploy, but runs in flight must not silently change shape because the pipeline was edited mid-execution. To guarantee execution consistency without freezing deployments, the engine stamps every run with a definition version, records the structural contract that version identifies as a content-addressed snapshot, routes execution so hosts only claim runs they can faithfully execute, and provides shadowing utilities to verify candidate builds against recorded production runs in CI. This reference covers how definition versions are derived and declared, how snapshot records are stored, how version-filtered claiming isolates rolling deploys, how drain status is queried, how persistence adapters implement versioning, and how candidate definitions are shadowed against live runs.

## Why pinning rather than patch markers

The engine answers completed steps from a ledger rather than replaying history from an event log. This execution model makes it a specification engine (comparable to Netflix Conductor or LittleHorse) rather than a replay engine (comparable to Temporal or Cadence). 

In replay engines, workflow code must re-execute past events deterministically to reconstruct execution state, requiring developers to litter workflow code with version checks (`getVersion()`, patch markers) and carry backwards-compatible branching indefinitely until old runs terminate. In specification engines, execution state is preserved directly in the database ledger, and stages execute forward against a recorded structural contract.

For this engine family, the correct versioning model is **pinning**: a run resolves against the definition version it was created under. A host only claims or processes a run if that host's build serves the run's pinned definition. When a pipeline changes, there are no patch markers to insert, no legacy code branches to maintain, and no code paths to retire.

## Deriving the definition version

A workflow's definition version identifies the pipeline's **structural contract**:

- The workflow identifier (`id`),
- The workflow's canonicalised input and output schemas,
- The ordered sequence of stages, including each stage's identifier (`id`), 1-based definition order (`stageNumber`), execution group index (`executionGroup`), declared dependency stage IDs (`dependencies`), and declared execution mode (`mode`),
- The canonicalised JSON Schema representations of each stage's input schema (`inputSchema`), output schema (`outputSchema`), and configuration schema (`configSchema`).

The version deliberately **excludes**:

- Stage human-readable names (`name`) and descriptions (`description`),
- Stage execution logic (`execute`), completion checks (`checkCompletion`), and cost estimators (`estimateCost`).

```typescript
import { z } from "zod";
import { defineStage, defineWorkflow } from "@bratsos/workflow-engine";

const extractStage = defineStage({
  id: "extract",
  name: "Extract",              // excluded from the hash
  schemas: {
    input: z.object({ documentId: z.string() }),
    output: z.object({ rawText: z.string() }),
    config: z.object({}),
  },
  async execute(ctx) {
    // The body is excluded from the hash: editing it never forks a version.
    return { output: { rawText: "extracted content" } };
  },
});

const workflow = defineWorkflow("document-pipeline", {
  input: z.object({ documentId: z.string() }),
})
  .pipe(extractStage)
  .build();

// Derived hash: "sha256-..."
const version = workflow.definitionVersion;

// The raw structural snapshot object
const snapshot = workflow.getDefinitionSnapshot();
```

Excluding stage bodies is a deliberate architectural decision. Hashing source code—the default strategy in DBOS—forks every in-flight run whenever a file is reformatted, a comment is added, or a log statement is edited. Hashing the structural contract—analogous to LittleHorse's `majorVersion`—forks only when a recorded run's shape could stop lining up. Changing what a stage does internally is a deployment concern; changing the set, order, grouping, or schemas of stages a run is halfway through is a run-compatibility concern.

Schemas are included in the hash because schemas define data compatibility across stage boundaries. Adding an optional field cleanly creates a new version while allowing old runs to drain safely; in contrast, removing a required field or altering an expected payload shape without versioning corrupts in-flight executions.

### Hash computation

When an explicit version is not declared, the version is derived from the workflow snapshot:

```typescript
const DERIVED_VERSION_PREFIX = "sha256-";

function hashDefinitionSnapshot(snapshot: DefinitionSnapshot): string {
  const digest = createHash("sha256")
    .update(stableStringify(snapshot))
    .digest("hex")
    .slice(0, 32);
  return `${DERIVED_VERSION_PREFIX}${digest}`;
}
```

The snapshot is serialised using `stableStringify`, which recursively canonicalises objects by sorting keys in ascending order. JSON Schemas are normalised via `z.toJSONSchema` with `{ unrepresentable: "any", io: "input" }`. If a field cannot be converted to JSON Schema, it returns `{ $unrepresentable: true }` rather than throwing, preventing an exotic type construct from breaking definition versioning. The derived version begins with the constant prefix `DERIVED_VERSION_PREFIX = "sha256-"`, ensuring future hashing schemes can be introduced without ambiguity.

The snapshot structure conforms to `DefinitionSnapshot`:

```typescript
const DEFINITION_SNAPSHOT_FORMAT = 1;

interface DefinitionStageSnapshot {
  readonly id: string;
  readonly stageNumber: number;
  readonly executionGroup: number;
  readonly dependencies?: readonly string[];
  readonly mode?: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly configSchema: unknown;
}

interface DefinitionSnapshot {
  readonly format: number;
  readonly workflowId: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly stages: readonly DefinitionStageSnapshot[];
}
```

### Declaring an explicit version

If you prefer manual version management (analogous to Conductor's workflow versioning), you can supply an explicit version string using `.version()`:

```typescript
const workflow = defineWorkflow("document-pipeline", {
  input: z.object({ documentId: z.string() }),
})
  .pipe(extractStage)
  .version("v2.1.0")
  .build();

workflow.definitionVersion; // Returns "v2.1.0"
```

Calling `defineWorkflow(...).version(version: string)` overrides the derived structural hash. The getter `workflow.definitionVersion` returns the explicit version when set, or computes and caches the derived hash if omitted.

Even when an explicit version is declared, the engine still derives and stores the structural snapshot and its `structureHash` alongside the explicit version string.

## Snapshot storage and conflict detection

Workflow definitions are stored in the database table `workflow_definitions`:

```sql
CREATE TABLE "workflow_definitions" (
  "workflowId"    TEXT NOT NULL,
  "version"       TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "snapshot"      JSONB NOT NULL,
  "structureHash" TEXT NOT NULL,
  CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("workflowId", "version")
);
CREATE INDEX "workflow_definitions_workflowId_idx" ON "workflow_definitions" ("workflowId");
```

On `workflow_runs`, two columns support versioning:

```sql
ALTER TABLE "workflow_runs" ADD COLUMN "definitionVersion" TEXT;
ALTER TABLE "workflow_runs" ADD COLUMN "redriveCount" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "workflow_runs_definitionVersion_idx"
  ON "workflow_runs" ("definitionVersion");
CREATE INDEX "workflow_runs_status_workflowId_definitionVersion_idx"
  ON "workflow_runs" ("status", "workflowId", "definitionVersion");
```

The definition record is written insert-if-absent at `run.create` time via `persistence.insertDefinitionIfAbsent`. Thousands of runs executing the same version share a single row in `workflow_definitions`. `RunCreateResult` returns the pinned version:

```typescript
interface RunCreateResult {
  readonly workflowRunId: string;
  readonly status: "PENDING";
  readonly definitionVersion: string | null;
}
```

### Conflict detection on explicit versions

Because derived versions are hashes of the structural snapshot, two identical derived versions are guaranteed to have identical structures. However, when explicit versions are used, an operator or developer might accidentally modify the pipeline's structure without bumping the version string.

When `run.create` attempts to register a definition, `persistence.insertDefinitionIfAbsent` inserts the record if absent and returns the stored row regardless. If a row already exists for `(workflowId, version)` but its `structureHash` does not match the candidate's `structureHash`, `recordDefinitionVersion` throws `DefinitionVersionConflictError`:

```typescript
class DefinitionVersionConflictError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly version: string,
    public readonly storedStructureHash: string,
    public readonly currentStructureHash: string,
  ) {
    super(
      `Workflow "${workflowId}" declares definition version "${version}", but that version is already registered with a different pipeline structure ` +
        `(stored ${storedStructureHash}, current ${currentStructureHash}). Bump the explicit version, or drop .version() to let the engine derive one from the structure.`,
    );
    this.name = "DefinitionVersionConflictError";
  }
}
```

This guard prevents two incompatible pipeline graphs from silently executing under the same explicit version identifier.

## Version-filtered claiming and rolling deploys

During a rolling deployment, hosts running the previous application build coexist with hosts running the new application build. If a host running the new build claims a run created under the old build, stage graph modifications could crash the run or skip stages.

The engine prevents this by filtering claims based on the definitions a host actually serves.

### Registry enumeration

The kernel's `WorkflowRegistry` interface supports workflow enumeration:

```typescript
interface WorkflowRegistry {
  getWorkflow(id: string): Workflow<any, any> | undefined;
  listWorkflows?(): ReadonlyArray<Workflow<any, any>>;
}
```

Supplying `listWorkflows` turns version-filtered claiming on. Use `createWorkflowRegistry` to instantiate a registry with enumeration support:

```typescript
import { createKernel, createWorkflowRegistry } from "@bratsos/workflow-engine";

const kernel = createKernel({
  registry: createWorkflowRegistry([workflowA, workflowB]),
  persistence,
  jobTransport,
  blobStore,
  eventSink,
  clock,
});
```

`createWorkflowRegistry` verifies that workflow IDs are unique and implements `listWorkflows`. If a manual `{ getWorkflow }` registry without `listWorkflows` is provided, version filtering is disabled, and claiming remains unfiltered for backwards compatibility.

### Claiming query mechanism

When `listWorkflows` is implemented, `run.claimPending` gathers the `(workflowId, version)` pairs served by the host using `servedDefinitions(deps.registry)`. It passes these pairs as `serves` to `persistence.claimNextPendingRun`:

```typescript
interface ServedDefinition {
  workflowId: string;
  version: string;
}
```

In the PostgreSQL persistence implementation, claiming uses `FOR UPDATE SKIP LOCKED` with a row-value `IN` predicate:

```sql
WITH claimed AS (
  SELECT id
  FROM "workflow_runs"
  WHERE status = $1::"Status"
    AND ("definitionVersion" IS NULL OR ("workflowId", "definitionVersion") IN (
      ($4, $5), ($6, $7)
    ))
  ORDER BY priority DESC, "createdAt" ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE "workflow_runs"
SET status = $2::"Status",
    "startedAt" = ($3::timestamptz AT TIME ZONE 'UTC'),
    "updatedAt" = ($3::timestamptz AT TIME ZONE 'UTC'),
    version = version + 1
FROM claimed
WHERE "workflow_runs".id = claimed.id
RETURNING "workflow_runs".*
```

The served pairs are bound as row values from `$4` onwards; a build that
serves nothing gets `AND "definitionVersion" IS NULL` instead, so it claims
only unpinned runs rather than everything.

Runs created before database migration have `definitionVersion = null`. These
unpinned runs are matched by `"definitionVersion" IS NULL` and remain
claimable by any host.

`run.claimPending` takes `serves` directly as well: pass `"all"` to claim
regardless of version (the pre-1.0 behaviour), or an explicit
`readonly ServedDefinition[]` to claim on behalf of another build. Left
unset, the kernel derives it from the registry.

### Handling unserved runs across handlers

During rolling deployments or when workloads are partitioned across dedicated worker pools, a host will encounter runs it does not serve:

- **Pending runs**: A `PENDING` run at a version the claiming host does not serve is ignored by the SQL claim query. It is left `PENDING` in the database, waiting for a host that serves its version. It is never marked `FAILED` with `WORKFLOW_NOT_FOUND`.
- **Running jobs (`job.execute`)**: If a job is dequeued by a worker whose build does not serve the run's pinned version, `handleJobExecute` catches the mismatch via `assertServesRun`. Instead of failing the stage or run, it returns `{ outcome: "failed", ghost: true, ghostReason: "version", error: ... }`. The host re-delivers the job to the transport queue, and the run remains `RUNNING`. The complete set of `ghostReason` values is `"orphan" | "race" | "version"`.
- **Transitions and polling**: `run.transition` and `stage.pollSuspended` verify `servesRun(run, workflow)`. If the current host does not serve the run, the handlers no-op. Crucially, `stage.pollSuspended` releases its poll claim lease immediately so that the mismatched host does not hold the 60-second claim lock and starve the host that can execute the run.
- **Stuck run reaper (`run.reapStuck`)**: When sweeping for wedged runs, `run.reapStuck` skips runs whose pinned version is not served by the local host. An unserved run receives no local updates and quickly exceeds the stuck timeout threshold; reaping it would fail a run that is executing normally on a peer worker.

### Why there is no automatic reaper for unserved runs

The engine deliberately provides **no automatic timeout-based reaper** for runs with unserved definition versions.

A host cannot differentiate between "a peer worker on the old build is temporarily restarting or deploying" and "the worker fleet for this version has been decommissioned forever". A timeout reaper would inevitably destroy healthy, in-flight production runs during extended rolling deploys or network partitions. Unserved runs remain active in the database and are surfaced through operational tooling (`run.listVersions`) so operators can intentionally move them forward with `run.redrive`.

## Inspecting drain status: run.listVersions

To verify that old definition versions have finished processing before retiring an application build, dispatch the `run.listVersions` command:

```typescript
const result = await kernel.dispatch({
  type: "run.listVersions",
  workflowId: "document-pipeline", // optional filter
  definitionVersion: "sha256-...",  // optional filter
});
```

### Types

```typescript
interface RunListVersionsCommand {
  readonly type: "run.listVersions";
  readonly workflowId?: string;
  readonly definitionVersion?: string;
}

interface DefinitionVersionSummary {
  readonly workflowId: string;
  /** null for runs created before migration. */
  readonly definitionVersion: string | null;
  /** Run count broken down by status. */
  readonly counts: Readonly<Record<string, number>>;
  /** Total runs recorded at this version. */
  readonly total: number;
  /** Active runs: PENDING + RUNNING + SUSPENDED. */
  readonly active: number;
  /** True when active === 0. Safe to decommission workers. */
  readonly drained: boolean;
  /** Whether the current process serves this definition version. */
  readonly servedHere: boolean;
  /** Creation timestamp of the oldest run recorded at this version. */
  readonly oldestCreatedAt: Date | null;
}

interface RunListVersionsResult {
  /** False when the database schema predates definition versioning. */
  readonly supported: boolean;
  /** Summaries sorted newest-first by oldestCreatedAt, unpinned runs last. */
  readonly versions: readonly DefinitionVersionSummary[];
  /** Versions with active runs that this process cannot execute. */
  readonly unservedHere: readonly DefinitionVersionSummary[];
}
```

If the database schema has not been migrated to include `workflow_definitions`, `supported` returns `false`, and `versions` and `unservedHere` return empty arrays rather than deceptive zero counts.

Entries where `servedHere: false` and `active > 0` indicate stranded runs. These runs require either keeping existing worker pools online until `drained` becomes `true`, or intervening with `run.redrive` to re-pin them to an active version.

## Persistence adapter surface: PersistenceCore

Custom persistence implementations must implement the definition versioning contract on `PersistenceCore`:

```typescript
interface WorkflowDefinitionRecord {
  workflowId: string;
  version: string;
  createdAt: Date;
  snapshot: unknown;
  structureHash: string;
}

interface CreateDefinitionInput {
  workflowId: string;
  version: string;
  snapshot: unknown;
  structureHash: string;
}

interface DefinitionVersionCount {
  workflowId: string;
  definitionVersion: string | null;
  status: Status;
  count: number;
  oldestCreatedAt: Date | null;
}

interface DefinitionVersionCountFilter {
  workflowId?: string;
  definitionVersion?: string;
  status?: readonly Status[];
}

interface PersistenceCore {
  supportsDefinitionVersioning(): boolean;

  insertDefinitionIfAbsent(
    input: CreateDefinitionInput,
  ): Promise<WorkflowDefinitionRecord | null>;

  getDefinition(
    workflowId: string,
    version: string,
  ): Promise<WorkflowDefinitionRecord | null>;

  countRunsByDefinitionVersion(
    filter?: DefinitionVersionCountFilter,
  ): Promise<DefinitionVersionCount[]>;

  claimNextPendingRun(options?: {
    now?: Date;
    serves?: readonly ServedDefinition[];
  }): Promise<WorkflowRunRecord | null>;
}
```

- `supportsDefinitionVersioning()`: Returns `false` on an unmigrated database. When `false`, the engine bypasses all version checks, treats runs as unpinned, and executes in legacy mode.
- `insertDefinitionIfAbsent(input)`: Inserts the definition snapshot if `(workflowId, version)` does not exist, and returns the persisted record in both insert and conflict cases. Returns `null` if versioning is unsupported.
- `getDefinition(workflowId, version)`: Fetches a definition snapshot by compound key, or returns `null` if not found.
- `countRunsByDefinitionVersion(filter)`: Aggregates run counts grouped by `(workflowId, definitionVersion, status)`. Returns an empty array if versioning is unsupported.
- `ServedDefinition`: Evaluated as a compound pair `(workflowId, version)` to ensure workflows declaring matching explicit versions (such as `"1.0.0"`) do not collide.

### Structural feature detection in Prisma

The built-in Prisma adapter detects definition versioning capability **structurally** by inspecting whether `prisma.workflowDefinition` exists on the generated client object:

```typescript
function detectDefinitionVersioning(prisma: PrismaClient): boolean {
  const model = prisma.workflowDefinition;
  return (
    typeof model?.findUnique === "function" &&
    typeof model?.create === "function"
  );
}
```

It does not run a probe query (`SELECT 1 FROM workflow_definitions LIMIT 1`, say). A statement that fails inside a Postgres transaction aborts the whole transaction, so every later statement in it fails too — a probe that answers "not migrated" would take the surrounding kernel transaction down with it. Inspecting the client's model surface costs nothing and cannot fail.

`createPrismaWorkflowPersistence` accepts `definitionVersioning?: boolean` to
override the detection, for a client whose model surface the detection cannot
see. Left unset, detection decides.

## Shadowing: checking compatibility before deployment

Definition pinning ensures that deployed pipeline changes will not corrupt running executions. However, pinning alone cannot warn you before a deployment that an updated pipeline is incompatible with in-flight runs—it simply leaves those runs waiting for an old host.

The shadowing utilities in `@bratsos/workflow-engine/testing` evaluate candidate workflow definitions against real recorded run state from production or staging databases.

### CI sweep: shadowVersions

`shadowVersions` inspects every definition version that currently holds active runs and validates candidate workflow definitions against the recorded snapshots:

```typescript
import {
  assertShadowCompatible,
  shadowVersions,
} from "@bratsos/workflow-engine/testing";

const report = await shadowVersions({
  persistence, // Connected to staging/production database
  candidates: [invoiceWorkflowCandidate, reportWorkflowCandidate],
  statuses: ["PENDING", "RUNNING", "SUSPENDED"], // Optional default
});

// Throws an Error with detailed failure lines if incompatible
assertShadowCompatible(report);
```

#### Types

```typescript
interface ShadowVersionsOptions {
  readonly persistence: Pick<
    WorkflowPersistence,
    | "getDefinition"
    | "supportsDefinitionVersioning"
    | "countRunsByDefinitionVersion"
  >;
  readonly candidates: ReadonlyArray<Workflow<any, any>>;
  readonly statuses?: readonly string[];
}

interface ShadowVersionResult {
  readonly workflowId: string;
  readonly version: string;
  readonly runCount: number;
  readonly drifts: readonly DefinitionDrift[];
  readonly compatible: boolean;
}

interface ShadowVersionsReport {
  readonly supported: boolean;
  readonly versions: readonly ShadowVersionResult[];
  readonly incompatible: readonly ShadowVersionResult[];
  readonly ok: boolean;
}
```

### Targeted run analysis: shadowRuns

To inspect individual runs and validate stage configurations and outputs, use `shadowRuns`:

```typescript
import {
  assertShadowCompatible,
  shadowRuns,
} from "@bratsos/workflow-engine/testing";

const report = await shadowRuns({
  persistence,
  candidates: [candidateWorkflow],
  runIds: ["run-101", "run-102"],
  stepLedger, // Optional: validates durable step records
  blobStore,  // Optional: resolves externalised stage outputs
});

assertShadowCompatible(report);
```

#### Types

```typescript
interface ShadowRunsOptions {
  readonly persistence: Pick<
    WorkflowPersistence,
    | "getRun"
    | "getStagesByRun"
    | "getDefinition"
    | "supportsDefinitionVersioning"
  >;
  readonly candidates: ReadonlyArray<Workflow<any, any>>;
  readonly runIds: readonly string[];
  readonly stepLedger?: Pick<StepLedger, "list">;
  readonly blobStore?: { get(key: string): Promise<unknown> };
}

interface ShadowIssue {
  readonly code: ShadowIssueCode;
  readonly stageId?: string;
  readonly message: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

interface ShadowRunResult {
  readonly workflowRunId: string;
  readonly workflowId: string;
  readonly pinnedVersion: string | null;
  readonly candidateVersion: string | null;
  readonly recordedStages: readonly string[];
  readonly recordedSteps: Readonly<Record<string, readonly string[]>>;
  readonly issues: readonly ShadowIssue[];
  readonly compatible: boolean;
}

interface ShadowReport {
  readonly runs: readonly ShadowRunResult[];
  readonly compatible: readonly ShadowRunResult[];
  readonly incompatible: readonly ShadowRunResult[];
  readonly ok: boolean;
}
```

When `stepLedger` is supplied, durable step IDs written by each stage are retrieved and populated into `recordedSteps`. If a stage was removed in the candidate but holds durable step entries, `STEP_LEDGER_ORPHANED` is raised.

When `blobStore` is provided, stages whose outputs exceeded inline thresholds and spilled to storage are fetched and evaluated against candidate output schemas. Without `blobStore`, only inline outputs are validated, and externalised outputs are skipped.

### Shadow issue codes

`ShadowIssueCode` categorises structural and schema incompatibilities:

| Issue Code | Meaning |
| --- | --- |
| `WORKFLOW_MISSING` | No candidate workflow definition was provided for the run's workflow identifier. |
| `STAGE_REMOVED` | A stage recorded in the existing run does not exist in the candidate definition. |
| `EXECUTION_GROUP_CHANGED` | A recorded stage has been reassigned to a different execution group. |
| `STAGE_ORDER_CHANGED` | A recorded stage has shifted to a different index in definition order. |
| `STAGE_INSERTED_BEFORE_CURSOR` | The candidate definition inserts a stage into an execution group the run has already passed, meaning the run would never execute it. |
| `CONFIG_REJECTED` | The stage config stored on the run fails the candidate's stage `configSchema`. |
| `OUTPUT_REJECTED` | A completed stage's recorded output fails the candidate's stage `outputSchema`. |
| `STEP_LEDGER_ORPHANED` | A stage removed by the candidate still has active step records in the durable step ledger. |
| `SNAPSHOT_DRIFT` | Pinned and candidate structural snapshots differ in an aspect not covered by the preceding codes. |

Stages appended after the execution cursor that the run has reached are compatible; the run will execute them when it progresses to their execution group.

### Limitations of shadowing

Shadowing statically validates workflow graphs, stage schemas, stored configurations, and stage outputs.

Shadowing **cannot** verify that a dynamic stage execution body will produce identical durable step keys (`ctx.step.run`, `ctx.step.waitFor`). Step keys are generated dynamically during execution; no static or ledger analysis can predict keys prior to code execution. If a stage body renames an internal step key, shadowing will not register an incompatibility; upon resume, the stage will simply execute the renamed step freshly.
