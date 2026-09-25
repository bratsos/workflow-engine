---
sidebar_position: 1
title: Introduction
slug: /
---

# Introduction

**workflow-engine** is a TypeScript library that runs durable, multi-stage
workflows in your own Postgres. There is no server to deploy and no vendor: you
`npm install` it, point it at a Prisma client, and run it from a Node process,
a serverless function, or a cron trigger. Workflow state lives in tables next
to your application's tables, in the same database and the same transaction
scope.

It is built for pipelines whose expensive steps are model calls, so the things
it takes seriously are suspend and resume across hours, per-call cost, and
provider batch endpoints.

---

## What it does that is worth choosing it for

Every claim below is one you can check against the source in this repository.
Where something is a design that other projects also ship, this page says so.

### The kernel can run inside your transaction, under row-level security

The kernel is a pure command dispatcher: no timers, no signals, no global
state, no connection of its own. You give it a persistence port. If you build
that port over a Prisma *transaction* client with
`skipInteractiveTransactions`, the whole tick — claiming a run, executing a
stage, writing the outbox — happens inside the transaction you opened, on the
session you opened it on, so a `SET LOCAL` for your tenant and your row-level
security policies apply to engine tables exactly as they apply to your own.
This is why the [console](../console/overview.md) is a request handler over
your client rather than a dashboard with its own connection string, and it is
why the suspended-stage lease is a row rather than a Postgres advisory lock
(see [Execution Model](../core-concepts/execution-model.md)).

The scope is the whole kernel tick, not only the enqueue.

### Provider batch APIs as durable steps

OpenAI Batch, Anthropic Message Batches, Google/Vertex batch and OpenRouter's
`:batch` endpoint are roughly half price and take hours. `ctx.step.ai.map`
submits to them as a durable step: the submit is recorded in the step ledger,
the stage suspends and releases its lease, a maintenance tick polls, and the
run resumes where it left off. A crash between submit and collect resumes from
the ledger rather than resubmitting, because the submit carries a derived
`externalKey` a reclaim can search for and adopt.

The batch call is a step in a durable workflow, with its handle, its request
ids and its cost recorded.

### Cost as a value your workflow code can read

Every AI call records tokens and cost, rolled up onto `WorkflowRun.totalCost`
and `totalTokens` in the same transaction as the stage that made it. Because
it is a column and not a trace, the next stage can read it: you can gate a step
on spend, route to a cheaper model, or bill a tenant from inside the workflow.

The price table has no activation dates or regex model matching, and covers
a limited set of token subtypes. What it gets right is **batch** pricing and
**placement**: cost is recorded next to the run, where workflow code can read
it.

### Batch-aware cost accounting

Cost is computed where the engine knows which endpoint it dispatched to, so a
batch call is priced from the model's batch prices
(`batchInputCostPerMillion` / `batchOutputCostPerMillion`) or the OpenRouter
`:batch` catalog row, not by applying a flat 50% to the realtime price. That
matters because the flat multiplier is wrong: Vertex documents that the batch
discount does not stack with implicit caching, and OpenRouter documents that
non-token components are not discounted. Where a provider reports its own
figure, `reportedCostUsd` wins and `costSource` says so.

### Failing before submit rather than after

Anthropic validates a batch asynchronously — a malformed body can cost 24 hours
before you hear about it — and Gemini batch creation is not idempotent. So the
engine converts your Zod schema to each provider's dialect at the model
boundary and raises `UnportableSchemaError`, naming the JSON path and the
keyword, *before* the request, for a schema feature no rewrite can express.

Two details of that rewrite: a `z.record()` becomes an array of
`{ key, value }` pairs **and the answer is transformed back** into your object
before validation, and the same rewrite applies at the *batch* submission
boundary, not only the realtime one.

---

## Things that are good choices, not differentiators

- **Keyed step identity.** A durable step is keyed by `(stageRecordId, stepId)`
  rather than by ordinal position, so reordering, branching and refactoring the
  code around a step are free. The cost of keyed identity is that we get no drift
  detection for free the way an ordinal ledger does, which is why
  `DuplicateStepKeyError` exists.
- **Restart from a step.** `run.redrive` gives you retry, restart and rerun.
  A retry or a rerun reopens the resumed stage in place and keeps its
  completed step rows and their external keys, so a stage that finished 9 of
  10 steps re-runs only the tenth; only a restart replaces everything (see
  [Retry, Restart and Rerun](../core-concepts/redriving-runs.md)).
  A redrive keeps the same run id and appends to its history with a
  `redriveCount`, and can re-pin the run onto another definition version.
- **Transactional outbox.** The outbox is how system events reach your
  `EventSink` at least once without phantom events. It is not how the engine
  wakes its own consumer.
- **No payload ceiling.** Nothing rejects a large value; it is bounded only by
  Postgres. Since 1.0 a step result over 64 KiB spills to the blob
  store behind a claim check
  (see [Kernel and Ports](../core-concepts/kernel-and-ports.md)).

## What it does not do

- **No arbitrary DAG.** Pipelines are linear with concurrent execution groups.
  There is no fan-out/fan-in graph and no child workflows.
- **No exactly-once execution.** The step ledger gives exactly-once
  *recording* and at-least-once *execution* of a step body. A step
  body runs outside a transaction, so its result and its own writes do not
  commit together. What the engine gives you instead is a derived
  `step.externalKey`, written before the body runs, to make the repeat
  recoverable, and `onReclaim: "fail"` for a body where it cannot be.
- **No per-tenant concurrency, throttle, rate limit, debounce or priority
  key.** The Postgres queue has priority and an opt-in per-group concurrency
  cap, and no keyed flow control.
- **No replay-against-recorded-history test harness.** Per-step stubbing does
  exist: `harness.steps.mockResult(id, value)`,
  `.mockError(id, error)` and `.mockTimeout(id)`, plus `.skipSleeps()`. The
  clock is an injected port, so `FakeClock.advance(ms)` skips a sleep or a
  poll interval, and `createTestHarness` runs a whole workflow in memory.
  What is missing is replaying a build against the recorded history of runs
  that already happened; `shadowRuns` / `shadowVersions` check a candidate
  build against existing runs, which is the nearer equivalent.
- **TypeScript only**, and alpha.

---

## When to use something else

| If you need | Look at |
| :--- | :--- |
| Language-heterogeneous workflows, arbitrary DAGs, enforced determinism and workflow-code patching | Temporal |
| The strongest queue-level fairness and flow control available (CEL concurrency keys, throttle, debounce, singleton) | Inngest, or Hatchet self-hosted |
| A library on your own Postgres with version pinning, patching, forks, and a mature ops CLI, where AI is not the point | DBOS Transact |
| Just a job queue, no workflow layer | pg-boss, Graphile Worker, River, BullMQ |
| A hosted product with a run UI, alerting and automatic payload offload out of the box | Trigger.dev, Inngest |

Choose this engine when the workflow's state belongs in *your* Postgres under
*your* tenancy rules, and when the expensive part of the pipeline is model
calls you want batched, priced and resumable.
