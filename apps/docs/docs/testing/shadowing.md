---
sidebar_position: 2
title: Shadowing a Definition Change
---

# Shadowing a Definition Change

[Definition versioning](../core-concepts/definition-versioning.md) stops a
pipeline change from corrupting a run that is already in flight. What it
does not do is tell you *before* you deploy that your change is
incompatible — it just leaves those runs waiting for a host that no longer
exists.

Cadence closes that gap with a Workflow Shadower: sample production runs,
fetch their histories, replay them against a candidate build. The
step-ledger analogue ships in `@bratsos/workflow-engine/testing`, so you can
run it from your own test suite and fail a build instead of a production
run.

## The CI sweep

`shadowVersions` needs no run ids. It finds every definition version that
still has live runs and checks your candidate build against each one:

```ts
import {
  assertShadowCompatible,
  shadowVersions,
} from "@bratsos/workflow-engine/testing";

it("does not strand any run that is still in flight", async () => {
  const report = await shadowVersions({
    persistence,             // your real adapter, pointed at staging
    candidates: [invoiceWorkflow, reportWorkflow], // the build you are shipping
  });

  assertShadowCompatible(report);
});
```

By default it only looks at versions with runs in `PENDING`, `RUNNING` or
`SUSPENDED` — the states in which a run still needs a host. A version whose
runs have all finished cannot be stranded, so it is skipped.

`assertShadowCompatible` throws with one line per problem:

```
1 of 2 recorded definition version(s) cannot be executed by the candidate definition:
workflow "invoice" version "sha256-3f2a…" (14 live run(s)):
  Stage "extract" is no longer in the workflow.
  Stage "summarise" moved from position 2 to position 1 in definition order.
```

## Checking specific runs

`shadowRuns` takes run ids and checks each one in detail, including the
config and output each stage actually recorded:

```ts
import { shadowRuns } from "@bratsos/workflow-engine/testing";

const report = await shadowRuns({
  persistence,
  candidates: [invoiceWorkflowV2],
  runIds: recentRunIds,       // however you choose them
  stepLedger,                 // optional
  blobStore,                  // optional
});

for (const run of report.incompatible) {
  console.log(run.workflowRunId, run.issues.map((i) => i.message));
}
```

Per run it reports:

| Issue | Meaning |
| --- | --- |
| `WORKFLOW_MISSING` | the candidate build defines no workflow with this run's id |
| `STAGE_REMOVED` | a stage this run has a record for is gone |
| `EXECUTION_GROUP_CHANGED` | a recorded stage moved to a different parallel group |
| `STAGE_ORDER_CHANGED` | a recorded stage moved in definition order |
| `STAGE_INSERTED_BEFORE_CURSOR` | the candidate adds a stage at or before a group this run already passed, so this run would never execute it |
| `CONFIG_REJECTED` | the config this run stored for a stage fails the candidate's `configSchema` |
| `OUTPUT_REJECTED` | a completed stage's recorded output fails the candidate's `outputSchema` |
| `STEP_LEDGER_ORPHANED` | a removed stage still holds durable step records |
| `SNAPSHOT_DRIFT` | the pinned and candidate snapshots differ in a way none of the above covered |

A stage appended *after* the point a run has reached is not a finding. That
run simply runs the new stage when it gets there, which is the whole point
of adding one.

Passing `stepLedger` also fills in `recordedSteps` — the durable step ids
each stage actually wrote — which makes a failure diagnosable rather than
just red.

Passing `blobStore` lets output validation see outputs that were
externalised to the blob store rather than stored inline. Without it, only
inline outputs are checked; a blob that has aged out is skipped rather than
reported as a failure.

## What shadowing cannot tell you

Shadowing verifies the **structural contract** and the recorded configs and
outputs. It cannot verify that a stage body will emit the same `ctx.step`
keys, because step keys are produced by running the code — no static check
can know them. Renaming `ctx.step.run("fetch", …)` to
`ctx.step.run("download", …)` does not change the definition version and
shadowing will not catch it; a resumed run simply re-executes that step.

Treat shadowing as the guard against a pipeline change that *strands* runs,
not as a proof that a stage body is unchanged.
