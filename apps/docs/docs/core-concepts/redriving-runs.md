---
sidebar_position: 6
title: Retry, Restart and Rerun
---

# Retry, Restart and Rerun

When a run ends badly, operators want one of three things, and they are not
the same thing:

- **retry** — pick up from the stage that failed, leaving everything that
  succeeded alone.
- **restart** — run the whole pipeline again from the beginning, with the
  same input.
- **rerun** — go back to a stage you choose and go forward from there.

Conductor exposes these as three verbs. `run.redrive` is one command with
those three modes, plus the ability to move the run onto a different
definition version.

```ts
await kernel.dispatch({
  type: "run.redrive",
  workflowRunId,
  from: { kind: "lastFailure" },              // the default
  // from: { kind: "start" },
  // from: { kind: "stage", stageId: "summarise" },
  definitionVersion: "latest",                // optional
  idempotencyKey: "redrive-invoice-4711",     // optional
});
```

| `from` | Resumes at |
| --- | --- |
| `{ kind: "lastFailure" }` | the earliest stage record that is not `COMPLETED`; if every stage completed, the last one |
| `{ kind: "start" }` | the first stage of execution group 1 |
| `{ kind: "stage", stageId }` | the named stage |

The run must be `COMPLETED`, `FAILED` or `CANCELLED`.

The result reports what happened:

```ts
{
  workflowRunId: "…",
  fromStageId: "summarise",
  supersededStages: ["summarise", "publish"],
  redriveCount: 2,
  definitionVersion: "sha256-…",
}
```

Like Step Functions' redrive, this is the **same run**: the same id, an
incremented `redriveCount`, no branching into a second execution. Stages at
and after the resume point are replaced; their job rows and durable step
ledgers are cleared so the new attempt starts clean.

## The failed attempt is preserved

`run.rerunFrom` used to delete the failed stage row and everything after
it, which destroyed the evidence of the failure you were retrying.
`run.redrive` archives every stage record it removes as a stage-scoped
annotation first, in the same transaction:

```ts
const attempts = await kernel.annotations.list(workflowRunId, {
  key: "run.supersededAttempt",
});

attempts[0];
// {
//   scope: "stage",
//   scopeId: "summarise",
//   attempt: 0,
//   value: "FAILED",
//   payload: {
//     redriveCount: 1,
//     stageRecordId: "…",
//     stageNumber: 2,
//     executionGroup: 2,
//     status: "FAILED",
//     errorMessage: "Provider returned 503",
//     startedAt: "…", completedAt: "…", duration: 4210,
//     metrics: { … },
//     outputData: { _artifactKey: "…" },
//     definitionVersion: "sha256-…",
//   },
// }
```

Annotations already survive stage deletion (`onDelete: SetNull` on the stage
relation), already carry `attempt`, and are already queryable — so the
superseded attempt lands on the surface built for exactly this, rather than
in a new table.

Two things it records rather than copies: `outputData` keeps the blob key,
not the blob. The new attempt writes to the same key, so the archive tells
you an output existed and where it lived, not what it contained. And the
durable step ledger is cleared rather than archived — its rows are keyed by
the deleted stage record's id, so nothing would ever read them again.

### What the redrive abandons

Clearing the ledger can strand an effect that is still live: a durable step
that submitted a provider batch holds its handle and its
[external key](../api/index/functions/deriveStepExternalKey.md), and the
provider keeps processing and keeps billing it whether or not you redrove
the run. Those rows cannot be kept, so what they name is recorded before
they go — as `abandonedSteps` on the superseded-attempt annotation, and as a
`WARN` log on the run:

```ts
attempts[0].payload.abandonedSteps;
// [{ stepId: "extract:submit", status: "completed", externalKey: "wfe-…" }]
```

The key is the actionable part: it is what you search the provider with to
find, and cancel, a batch nothing will collect any more. The field is absent
when the redrive abandoned nothing that named an external effect, which is
the normal case. The annotation is there as well as the log because logs
rotate and the annotation stays on the run.

## Redriving onto a different definition version

With [definition versioning](./definition-versioning.md) in place, a redrive
can also move the run onto a different version — DBOS's fork-onto-a-new-
application-version, which is the answer to "we shipped a bug, patch it and
re-run":

```ts
await kernel.dispatch({
  type: "run.redrive",
  workflowRunId,
  from: { kind: "lastFailure" },
  definitionVersion: "latest",
});
```

- omitted: keep the run's pinned version. This process must present it, or
  the command throws `DefinitionVersionMismatchError` — planning a redrive
  against a different shape than the host that would execute it is exactly
  the bug pinning exists to prevent.
- `"latest"`: re-pin to the version this process serves, registering its
  snapshot if it has not been seen before. This is how you rescue a run
  stranded at a version nothing serves any more (find them with
  `run.listVersions`).
- an explicit version string: re-pin to that version, which must already be
  registered for this workflow.

## `run.rerunFrom` is deprecated

`run.rerunFrom` still works and its result shape is unchanged — including
`deletedStages`, which now reports the stages that were *superseded and
archived*. It delegates to `run.redrive` with
`from: { kind: "stage", stageId }`, so it inherits the preserved attempt and
the redrive count. The one thing it does not inherit is `run.redrive`'s
wider input: it still refuses a `CANCELLED` run, and it cannot change the
definition version.

Migrating is a one-line change:

```ts
// before
await kernel.dispatch({ type: "run.rerunFrom", workflowRunId, fromStageId });

// after
await kernel.dispatch({
  type: "run.redrive",
  workflowRunId,
  from: { kind: "stage", stageId: fromStageId },
});
```
