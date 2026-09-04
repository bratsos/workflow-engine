---
sidebar_position: 5
title: Definition Versioning
---

# Definition Versioning

A workflow definition changes every time you deploy. Runs do not stop while
you deploy. Without versioning, a run that started under a three-stage
pipeline resolves its next stage against whatever the process currently has
loaded — so adding, removing or reordering a stage silently changes the
shape of a run that is already half-finished.

The engine answers completed steps from a ledger rather than replaying
history, which makes it a *specification* engine (like Conductor or
LittleHorse) rather than a *replay* engine (like Temporal). The right answer
for that family is **pinning**, not patching: a run resolves against the
definition it was created under. There are no patch markers and no
`getVersion()` branches to retire.

## What the version identifies

The version is a hash of the pipeline's **structural contract**:

- every stage id, in definition order (`stageNumber`),
- every stage's execution group (which stages run in parallel),
- each stage's declared `dependencies` and `mode`,
- the normalised JSON Schema of each stage's `input`, `output` and `config`
  schemas,
- the workflow's own input and output schemas.

It deliberately **excludes** stage `name`, stage `description`, and the
bodies of `execute`, `checkCompletion` and `estimateCost`.

That exclusion is the point. Hashing source code — DBOS's default — forks
every in-flight run when you reformat a file or edit a log line. Hashing the
contract — LittleHorse's `majorVersion` — forks only when a recorded run's
shape could actually stop lining up. Changing what a stage *does* is a
deploy concern; changing the *set and order of stages a run is halfway
through* is a run-compatibility concern.

A derived version looks like `sha256-3f2a9c81b0e4d7a6...`.

```ts
const workflow = defineWorkflow("invoice", { input: InvoiceInput })
  .pipe(extract)
  .pipe(summarise)
  .build();

workflow.definitionVersion;      // "sha256-…"
workflow.getDefinitionSnapshot(); // the structure that hash identifies
```

### Declaring the version yourself

If you would rather control forking by hand, Conductor-style:

```ts
const workflow = defineWorkflow("invoice", { input: InvoiceInput })
  .pipe(extract)
  .pipe(summarise)
  .version("2026-09-04.1")
  .build();
```

The declared string replaces the derived hash. The engine still records the
derived structure alongside it, and refuses to register the same explicit
version with a different structure — you get a
`DefinitionVersionConflictError` at `run.create` telling you to bump it,
rather than two incompatible pipelines quietly sharing one version.

## Where the snapshot lives

`run.create` writes the snapshot to a `workflow_definitions` row keyed by
`(workflowId, version)`, and stamps the version on the run:

```
workflow_runs.definitionVersion  ->  workflow_definitions(workflowId, version)
```

The row is content-addressed, so ten thousand runs at one version share one
snapshot rather than each carrying a copy. Registration is
insert-if-absent: the first run at a version writes it, every later run
reads it back.

The snapshot stores *structure*, not code — stage bodies cannot be
serialised. What enforces the pin is therefore routing, not deserialisation:
a process only takes work whose version it can actually present.

## Rolling deploys are safe by construction

`run.claimPending` filters on the version. A host claims a pending run only
when its own build presents that run's `(workflowId, version)` pair. Runs
created before you migrated carry `definitionVersion = null` and stay
claimable by everyone.

This needs a registry that can enumerate itself:

```ts
import { createKernel, createWorkflowRegistry } from "@bratsos/workflow-engine";

const kernel = createKernel({
  registry: createWorkflowRegistry([invoiceWorkflow, reportWorkflow]),
  // ...
});
```

`createWorkflowRegistry` implements `listWorkflows()`, which is what turns
filtering on. A hand-written `{ getWorkflow }` registry cannot enumerate, so
claiming stays unfiltered — exactly the pre-1.0 behaviour. You can also pass
the predicate explicitly per dispatch:

```ts
await kernel.dispatch({ type: "run.claimPending", workerId, serves: "all" });
```

During a rolling deploy the result is: old hosts finish their own work, new
hosts never adopt a run whose shape they would change.

For a run that was already `RUNNING` when the deploy landed, the same rule
applies at execution time. `job.execute` returns
`{ ghost: true, ghostReason: "version" }` rather than running the wrong
shape — the job is re-delivered for a host that can serve it, and the run is
**not** failed. `run.transition` and `stage.pollSuspended` leave such a run
untouched for the same reason.

## Has it drained?

Pinning introduces one failure mode unpinned execution does not have: a run
whose version *no* live process presents has no host. That has to be
visible, so it is a first-class query rather than something you infer from a
run that never moves.

```ts
const { supported, versions, unservedHere } = await kernel.dispatch({
  type: "run.listVersions",
  workflowId: "invoice", // optional
});
```

Each entry reports:

| Field | Meaning |
| --- | --- |
| `definitionVersion` | the version, or `null` for runs created before you migrated |
| `counts` | run count per status |
| `total` / `active` | all runs / runs still needing a host (PENDING + RUNNING + SUSPENDED) |
| `drained` | `active === 0` — safe to retire the build that serves this version |
| `servedHere` | whether *this* process presents this version |
| `oldestCreatedAt` | age of the oldest run at this version |

`unservedHere` is the list to act on: versions with live runs that this
process cannot serve. Either a peer on the old build is still finishing them
— check again shortly — or nothing serves them and you should move them
forward with `run.redrive`.

`supported: false` means the database has not been migrated; `versions` is
then empty rather than misleading.

## Moving a stranded run forward

```ts
await kernel.dispatch({
  type: "run.redrive",
  workflowRunId,
  from: { kind: "lastFailure" },
  definitionVersion: "latest", // re-pin onto the build you are running now
});
```

`definitionVersion` accepts `"latest"` (re-pin to what this process serves)
or an explicit version that has already been registered for the workflow.
See [Retry, restart and rerun](./redriving-runs.md) for the full
`run.redrive` contract.

## Migrating an existing database

Definition versioning adds two columns and one table. **A database that has
not been migrated keeps working**: the Prisma adapter detects that the
generated client has no `workflowDefinition` model, stores no versions, and
behaves exactly as it did before — runs are unpinned, claiming is
unfiltered, and `run.listVersions` reports `supported: false`.

Add to your `schema.prisma`:

```prisma
model WorkflowRun {
  // ... existing fields ...
  definitionVersion String?
  redriveCount      Int     @default(0)

  @@index([definitionVersion])
  @@index([status, workflowId, definitionVersion])
}

model WorkflowDefinition {
  workflowId    String
  version       String
  createdAt     DateTime @default(now())
  snapshot      Json
  structureHash String

  @@id([workflowId, version])
  @@index([workflowId])
  @@map("workflow_definitions")
}
```

Then:

```bash
npx prisma migrate dev --name workflow-engine-definition-versioning
npx prisma generate
```

The equivalent SQL, if you manage migrations by hand:

```sql
ALTER TABLE "workflow_runs" ADD COLUMN "definitionVersion" TEXT;
ALTER TABLE "workflow_runs" ADD COLUMN "redriveCount" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "workflow_runs_definitionVersion_idx"
  ON "workflow_runs" ("definitionVersion");
CREATE INDEX "workflow_runs_status_workflowId_definitionVersion_idx"
  ON "workflow_runs" ("status", "workflowId", "definitionVersion");

CREATE TABLE "workflow_definitions" (
  "workflowId"    TEXT NOT NULL,
  "version"       TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "snapshot"      JSONB NOT NULL,
  "structureHash" TEXT NOT NULL,
  CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("workflowId", "version")
);
CREATE INDEX "workflow_definitions_workflowId_idx"
  ON "workflow_definitions" ("workflowId");
```

Both changes are additive: `definitionVersion` is nullable and
`redriveCount` has a default, so no backfill is needed and existing rows
keep working. Runs that predate the migration stay unpinned for the rest of
their lives; every run created after it is pinned.

### What changes on the day you migrate

- **Every new run is pinned.** If your fleet is homogeneous this is
  invisible — every host presents the same version.
- **Claiming is filtered** once you wire `createWorkflowRegistry` (or
  anything else with `listWorkflows`). Until then, nothing changes.
- **A run whose workflow this host does not have is no longer failed at
  claim time.** Previously `run.claimPending` adopted it and marked it
  `FAILED` with `WORKFLOW_NOT_FOUND`; with an enumerating registry it is
  left `PENDING` for a host that has the workflow, and reported by
  `run.listVersions`. The old behaviour is still what you get from a
  non-enumerating registry, or with `serves: "all"`.

### Opting out

There is no global "off" switch, because there is nothing to switch off:
pinning is only ever as strict as the versions actually recorded. If you do
not migrate the schema, runs are never pinned. If you migrate but want
unfiltered claiming, keep passing `serves: "all"` on `run.claimPending`.

## Checking a change before you ship it

Pinning stops an incompatible change from corrupting a run, but it does not
tell you *before* you deploy that a change is incompatible — it just leaves
old runs stranded. To catch that in CI, replay recent runs' recorded ledgers
against your candidate pipeline; see
[Shadowing a definition change](../testing/shadowing.md).
