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

The comparable design in the field is DBOS's `enqueueInTransaction`, which
joins a caller's transaction for the *enqueue* and requires that transaction
to be on its own system database. Several Postgres queues — pg-boss (including
`fromPrisma(tx)`), Graphile Worker, River, Oban — put the enqueue in your
transaction too. What is different here is scope: it is the whole kernel tick,
not the enqueue.

### Provider batch APIs as durable steps

OpenAI Batch, Anthropic Message Batches, Google/Vertex batch and OpenRouter's
`:batch` endpoint are roughly half price and take hours. `ctx.step.ai.map`
submits to them as a durable step: the submit is recorded in the step ledger,
the stage suspends and releases its lease, a maintenance tick polls, and the
run resumes where it left off. A crash between submit and collect resumes from
the ledger rather than resubmitting, because the submit carries a derived
`externalKey` a reclaim can search for and adopt.

The Vercel AI SDK shipped a batch transport in August 2026 for OpenAI,
Anthropic and Google; `@openrouter/ai-sdk-provider` does not implement it.
What is not available elsewhere is the batch call being a step in a durable
workflow, with its handle, its request ids and its cost recorded.

### Cost as a value your workflow code can read

Every AI call records tokens and cost, rolled up onto `WorkflowRun.totalCost`
and `totalTokens` in the same transaction as the stage that made it. Because
it is a column and not a trace, the next stage can read it: you can gate a step
on spend, route to a cheaper model, or bill a tenant from inside the workflow.

Observability platforms compute cost after the fact and better than we do.
LangSmith's price table is user-editable with per-token-type breakdowns, model
activation dates and regex model matching; Langfuse's has dated price
versioning, pricing tiers and dozens of distinct usage keys. Ours has neither
activation dates nor regex matching, and covers fewer token subtypes. It is
ahead on two things: **batch**, and **placement**.

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

Schema portability itself is not ours alone: `@mastra/schema-compat` is a
standalone Apache-2.0 package that forces properties required, widens optionals
to nullable, sets `additionalProperties: false` and strips `propertyNames`
across six provider dialects; `@ai-sdk/anthropic` and `@ai-sdk/google` ship
their own per-provider shims; LangChain sanitises `additionalProperties`. Two
narrower things are unusual here: rewriting a `z.record()` into an array of
`{ key, value }` pairs **and transforming the answer back** into your object
before validation, and applying the same rewrite at the *batch* submission
boundary, not only the realtime one.

---

## Things that are good choices, not differentiators

- **Keyed step identity.** A durable step is keyed by `(stageRecordId, stepId)`
  rather than by ordinal position, so reordering, branching and refactoring the
  code around a step are free. Effect's `@effect/workflow` keys memoised
  activities by name too. The cost of keyed identity is that we get no drift
  detection for free the way an ordinal ledger does, which is why
  `DuplicateStepKeyError` exists.
- **Restart from a step.** `run.redrive` gives you retry, restart and rerun.
  Inngest, Cloudflare Workflows, Hatchet, DBOS, Restate, Conductor, Temporal,
  Step Functions and Mastra all ship a form of this. The factoring here is
  borrowed: the three verbs are Conductor's, the same-run-id, append-not-branch
  audit shape with a `redriveCount` is Step Functions' redrive, and
  re-pinning onto another definition version is DBOS's fork-onto-a-new-version.
- **Transactional outbox.** The outbox is how system events reach your
  `EventSink` at least once without phantom events. It is not how the engine
  wakes its own consumer, and it is not a differentiator: pg-boss, Graphile
  Worker, River and Oban all get an enqueue into your transaction, three of
  them by fusing a `pg_notify` into the insert.
- **No payload ceiling.** Nothing rejects a large value. That is shared with
  DBOS and Effect, both bounded only by Postgres. What used to be missing was
  the escape hatch; since 1.0 a step result over 64 KiB spills to the blob
  store behind a claim check
  (see [Kernel and Ports](../core-concepts/kernel-and-ports.md)).

## What it does not do

- **No arbitrary DAG.** Pipelines are linear with concurrent execution groups.
  There is no fan-out/fan-in graph and no child workflows.
- **No exactly-once execution.** The step ledger gives exactly-once
  *recording* and at-least-once *execution* of a step body — the same boundary
  Inngest, Cloudflare Workflows, Hatchet, Restate and DBOS all document. A step
  body runs outside a transaction, so its result and its own writes do not
  commit together. What the engine gives you instead is a derived
  `step.externalKey`, written before the body runs, to make the repeat
  recoverable, and `onReclaim: "fail"` for a body where it cannot be.
- **No per-tenant concurrency, throttle, rate limit, debounce or priority
  key.** The Postgres queue has priority and an opt-in per-group concurrency
  cap; it has nothing like Inngest's or Hatchet's CEL-keyed flow control.
- **No step-mocking test utilities** in the shape of Cloudflare's
  `mockStepResult()` / `mockStepError()` / `forceStepTimeout()`. The clock is
  an injected port, so `FakeClock.advance(ms)` skips a sleep or a poll
  interval, and `createTestHarness` runs a whole workflow in memory; what is
  missing is per-step stubbing and a replay-against-recorded-history harness.
  `shadowRuns` / `shadowVersions` check a candidate build against runs that
  already exist, which is the nearer equivalent.
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
