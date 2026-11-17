---
sidebar_position: 1
---

# The embeddable console

`@bratsos/workflow-engine-console` is an optional package that answers
"what happened to this run" without you building a screen for it. It is a
framework-agnostic `(Request) => Promise<Response>` handler plus a
prebuilt UI, mounted inside your own application.

It is optional in the strict sense: nothing in the engine depends on it,
and nothing in it is required to run a workflow.

![The runs list: status, workflow, pinned definition version, duration, cost and tokens per run](/img/console/runs.png)

The *Costs* tab rolls the same run totals up by workflow or by day:

![Cost rollups by workflow](/img/console/costs.png)

## It never opens a connection

Engine state lives in your Postgres. If you run the kernel inside one
transaction per tenant under row-level security, those policies are
evaluated against the session the query runs in — so a separate dashboard
process with its own connection string is a second session, and therefore
a second security context. There is no configuration that recovers the
tenant scoping: such a service either connects as a role that bypasses RLS
and can see every tenant, or it cannot see anything.

So the console does not dial the database. You construct its read port
from the client — or the transaction client — you already have, and its
reads happen in your session, inside your transaction, with authentication
already decided before the request reaches the handler.

## Mounting it

A catch-all route handler is the whole integration. In the Next.js App
Router, at `app/admin/console/[[...path]]/route.ts`:

```ts
import {
  createPrismaConsoleReadPort,
  createWorkflowConsole,
} from "@bratsos/workflow-engine-console";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createWorkflowConsole({
  reader: createPrismaConsoleReadPort(prisma),
  authorize: async ({ request }) => {
    const session = await getSession(request);
    return session?.role === "operator" || session?.role === "admin";
  },
});

export { handler as GET, handler as POST };
```

Hono, Cloudflare Workers, Deno and Bun speak `Request`/`Response`
natively, so they call the handler directly. Express, Fastify and bare
`node:http` go through `toNodeHandler` from
`@bratsos/workflow-engine-console/node`. There is no per-framework adapter
package, and none is needed.

The reader takes your Prisma client on Prisma 6, 7 or 8. A Prisma 8 client
has no model delegates, so wrap it first:
`createPrismaConsoleReadPort(fromPrisma8(db))`, with `fromPrisma8` from
`@bratsos/workflow-engine/persistence/prisma`. Inside your own transaction,
pass the `tx` and the contract: `fromPrisma8(tx, { contract: db.contract })`.
See [Prisma 8](../persistence/prisma-setup.md#prisma-8).

On SQLite, on any major, also pass the target:
`createPrismaConsoleReadPort(prisma, { databaseType: "sqlite" })`. The default
is `"postgresql"`.

`authorize` is not optional in practice: omit it and every action is
denied, because a permissive default would leak a tenant's runs to anyone
who forgot a line of configuration. It runs *after* your authentication —
answer only "may this principal do this?".

Writes are off by default. `actions: true` needs a `kernel`, and every
write dispatches a kernel command (`run.cancel`, `run.redrive`,
`step.signal`, `plugin.replayDLQ`) rather than SQL, so the console gets the
kernel's leases, idempotency and outbox events and there is still exactly
one writer against run state. `authorize` is asked per action — the
vocabulary is `runs.read`, `run.read`, `queue.read`, `suspended.read`,
`deadLetters.read`, `workers.read`, `costs.read`, `run.cancel`, `run.rerun`,
`step.signal` and `deadLetters.replay` — and `onAction` is told afterwards,
which is your audit trail. A custom `ConsoleKernel` must accept `run.redrive`
and `step.signal`.

## What the run detail shows

The run detail is the stage timeline plus, per stage, its **step ledger**:
every durable step with its `kind` (`run`, `wait`, `signal`, `sleep`),
`status`, `attempt`, lease and deadline (`leaseExpiresAt`, `deadlineAt`),
its error, and — on `run` steps — the `externalKey` the body was given, so
an operator can search a provider for an orphaned batch or charge without
the process that made it. Below that: the run's annotations (including the
engine-written `run.supersededAttempt` and `step.outcome-conflict`), logs
and the outbox event timeline.

![Run detail for a contract review suspended on a legal sign-off signal: the stage timeline and a pending signal step in the ledger](/img/console/run-suspended.png)

## Attempts, grouped by stage

A stage that retried used to show only its latest attempt: the stage row
holds its current status and last error, and a step row holds its last
state. The run detail now has an **Attempts by stage** section that lists
every attempt of every stage, built from the events the run's outbox still
holds: the stage events (`stage:started`, `stage:suspended`,
`stage:retrying`, `stage:failed`, `stage:completed`) and the run's
`workflow:created`, `workflow:started`, `workflow:completed`,
`workflow:failed` and `workflow:cancelled` events:

- when the attempt started and ended, why it began (first run recorded, job retry,
  retry while suspended, rerun after a redrive, started again after the
  previous attempt ended, or started again while the previous execution had
  no recorded end) and how it ended (completed, retrying, failed, suspended,
  running, cancelled, or no end recorded);
- the error that ended it;
- the events of the attempt;
- the steps that last changed during it: step id, kind, status, the step's
  own execution count, duration, error and external key.

Each attempt is a native disclosure (`<details>`), so it works from the
keyboard and with a screen reader. The status is spelled out in text, not
only coloured, and long errors wrap. An error text longer than 2,000
characters is cut by the read, and the page says so.

The attempt boundaries are:

- `stage:started` opens an attempt.
- A second `stage:started` while an attempt is open shows that the stage
  started again; no event says how the earlier execution ended. The earlier
  attempt is shown as *No end recorded* (not failed and not cancelled), its
  window closes where the stage started again, and the next attempt is
  labelled as started while the previous execution had no recorded end. Causes
  that leave this record include a worker that stopped or lost its lease
  (`lease.reapStale`), a job delivered again while it was still running, and an
  outcome that could not be written after the stage's code ran; the page lists
  them and does not pick one. The steps of such a window are placed by time
  only, and the page says so. The engine does not count this on the stage's
  `attempt`, so the count check leaves it out.
- `stage:suspended` and the poll that later resumes the stage stay inside the
  open attempt.
- `stage:completed` and `stage:failed` end it. A `stage:started` after an
  ended attempt with no redrive in between is shown as *started again after
  the previous attempt ended, with no redrive recorded*.
- `stage:retrying` ends the attempt as *retrying*. When the stage was suspended
  at that moment, the retry happened inside `stage.pollSuspended`: the stage
  stays `SUSPENDED`, no `stage:started` follows, and the next attempt begins
  at the retry event. Otherwise it was a job retry and the next attempt begins
  at the next `stage:started`.
- `workflow:cancelled` ends the open attempt as *cancelled*. `run.cancel`
  marks every unfinished stage `CANCELLED` and emits no stage event, so this is
  the only event that says the execution ended. A job that started its stage
  after the cancel is cancelled when it tries to record its outcome, with no
  event: that attempt shows *Cancelled* from the stage's record and says no
  event records when it ended.
- `workflow:started` is written by the first claim and by every redrive
  (`run.redrive`, `run.rerunFrom`). A redrive takes only a completed, failed or
  cancelled run, each of which ended its attempts with an event, so no attempt
  is open there; if one is, the history contradicts itself and the stage falls
  back. The next `stage:started` is a rerun after a redrive, also for a stage
  that was waiting for a job retry when the run was cancelled.
- `run.reapStuck` writes `stage:failed` for every unfinished stage, so a reaped
  attempt ends as *failed*. A reaped stage that was waiting for a job retry (or
  for a redrive's first job) has no attempt open: it is listed as a failed
  attempt that never started, with the reaper's error and the time it failed,
  and it is not counted against the stage's `attempt`. Any other end event with
  no attempt open, such as a `stage:failed` for a stage that completed,
  contradicts the history.

The ledger keeps only each step's latest state, so a step is listed under the
one attempt whose time window contains the step row's `updatedAt`. Those
times are stamped by the processes that wrote them: the step by the worker
that ran it, the window's ends by the workers, pollers or the cancel that
wrote the events. When hosts' clocks differ, a step near a boundary can be
listed under the neighbouring attempt or as not assignable, so the page says
it places steps by their recorded times. A step that failed in attempt 1 and
succeeded in attempt 2 appears in attempt 2 with *Execution 2*. A step whose
last change falls in no attempt, or on the boundary of two, is listed apart
as not assignable to one attempt instead of being guessed into one. A step's
duration is shown only when it executed once and has finished, because the
row does not keep per-execution timings.

### What the page relies on

Every history is built from the events the run's outbox still holds, and
the page says so in one line wherever it shows one. Nothing in the engine
deletes outbox rows: `run.purge` removes the run and leaves its rows, and a
purged run has no page. Rows of a run that still exists are removed only by
SQL, such as a pruning job of your own. What the page finds of such a
removal:

- **Rows removed from the start or the middle are always found.** A run's
  outbox starts at sequence 1 with its `workflow:created`, and the page uses
  the events only when every row from sequence 1 to the last one it read is
  retained and the row at sequence 1 is that `workflow:created`. The second
  condition is needed because a store numbers a run's next row one past the
  highest one it still holds: once every row of a run is gone, a later
  redrive's `workflow:started` is numbered 1 again.
- **Rows removed from the end are found only when what remains contradicts
  the run's or a stage's record.** By the same numbering, when rows are
  removed from the end and the run then writes again, the new rows take the
  removed numbers and the range is unbroken again. A re-delivery after a
  crash, or a retry while suspended, recorded only in such rows is not shown.

The checks against the records, none of which rests on the numbering:

- **The run's events follow the engine's order and agree with the run's
  record.** `workflow:created` comes first; the claim writes one
  `workflow:started`; every later `workflow:started` is a redrive and follows
  a `workflow:completed`, `workflow:failed` or `workflow:cancelled`, because a
  redrive takes only an ended run; `workflow:completed` comes only while the
  run is running. The redrives found that way must be exactly the run's
  redrive count, and the state the last of these events leaves (pending
  before the claim, running after a start, otherwise the last end) must be
  the run's status.
- **The stage's record agrees with them.** Its status with the last attempt
  (a `SUSPENDED` stage needs its `stage:suspended`, a `CANCELLED` one a
  `workflow:cancelled`, a `PENDING` one a retry or a redrive to wait for); its
  `attempt` with the executions recorded: a row starts at 0 and gains 1 per
  job retry and per retry while suspended, never for a re-delivery; a
  redrive leaves a row of an earlier execution group as it was, reopens a row
  of the target group at its attempt plus 1 (`lastFailure`, `stage`), creates
  the target group's rows one past the highest attempt of the rows it
  replaced (`start`), and lets later groups' rows be created again at 0, so
  after a redrive the row's `attempt` must be one of the values these rules
  give for the recorded executions; its `startedAt` with the last
  `stage:started`, its `completedAt` with the event that ended it, and its
  error with the last error event. After a redrive the row's status and
  error may also be the ones it had before the redrive (a row the redrive
  kept, such as a stage left cancelled by a redrive from a later stage), with
  a later cancel applied. The engine stamps the row and writes the
  event in one transaction, the row first, so a row stamped after the last
  retained event shows that the events after it are not retained. These are
  the only time comparisons that decide whether the history is shown, and
  each compares two values one transaction of one process stamped
  (`startedAt` with the `stage:started` that `job.execute` writes with it;
  `completedAt` with the `stage:completed` or `stage:failed` written with
  it), so a run spread over hosts whose clocks differ is not made unavailable
  by them. Everything else is ordered by sequence.
- **Only what every store writes alike is read.** The stores differ in one
  field the checks could read: before a stage first starts, the Prisma store
  has stamped its row's `startedAt` with the time it created the row (when
  the claim, a transition or a redrive creates it, and on rows written by
  every earlier release), and the in-memory store leaves it null. So
  `startedAt` is compared only after a retained `stage:started` with no
  redrive since, when `job.execute` has stamped it on every store, and a
  stage with no event of its own is read from its status and `attempt`
  alone. A custom read port may return either form.

Every count and label in the section is about recorded events: "First run
recorded", "2 recorded attempts". A stage shows *No start of this stage is
recorded* only when the events cover the run from its first event, none of
them is of that stage, and its record says it has not run: it is `PENDING`,
`SKIPPED` or `CANCELLED` with an `attempt` the rules above give before any
execution (0, or the value a redrive created it at). Its `startedAt` is not
read for this, for the reason above.

When the evidence is missing, the stage falls back to the flat view (the stage
timeline above and the step ledger below show its latest attempt) and says
that the per-attempt history is unavailable, with the reason:

- some of the run's events are missing from its outbox (removed by SQL, such
  as a pruning job): the rows the page read are not an unbroken range from
  sequence 1, or do not begin with the run's `workflow:created`;
- none of the run's events are retained in its outbox: the first read found
  no row of the run;
- the page has read only part of the run's events so far and is reading the
  rest (see below), or, with polling off, reads no more on its own until
  polling resumes;
- the run's record counts more redrives than its retained events record;
- the run's retained events contradict the order the engine writes them in,
  record more redrives than the run's record counts, or end in a state that
  is not the run's status;
- the reader provides no stage events (a custom `ConsoleReadPort` written
  before this existed);
- the stage's record says it ran, and no lifecycle event of it is retained;
- the retained events contradict each other (an execution ends with no start
  recorded, or a redrive starts while an execution has no recorded end), or
  cannot be attributed: one `job.execute` writes a stage's start and that
  execution's end under one causation id, so an end written under the id of
  an earlier retained start is the outcome of an earlier execution that kept
  running (after a cancel or a lost lease) and was recorded after a later one
  started, and which attempt it ended is not known;
- a retained event of the run has no readable time;
- the retained events do not agree with the stage's current record, naming
  the field: its status, its attempt count, its start time, its end time or
  its error.

### How the events are read

The events come from a separate read of the run's outbox, so the 200-row event
table does not limit them, and only the stage id and the error are extracted
from each payload. The page keeps the events it has read and each refresh asks
only for those after its last sequence (`GET /api/runs/:id?stageEventsAfter=N`),
so a refresh reads the rows the run wrote since the previous one. One read
covers at most 10,000 of the run's outbox sequences and returns at most 2,000
events; when rows remain, the page asks again from where the read stopped, at
once, until it has caught up, at most four such reads per poll interval: at
the default 5-second interval a run of 400,000 sequences takes 40 reads,
about 50 seconds, and its stages say the history is still being read until
then. With polling off the page makes no request on
its own, these included: *Refresh now* reads one more part, and turning
polling back on continues from what the page holds. Each such request
needs the previous one to have advanced, so a reader that stops advancing is
asked again only by the poll. What one read costs is therefore bounded
whatever the run's size: on Postgres a first read of a run of 400,000 rows is
the same 10,000-row index range as one of 10,000 rows. Each statement on a
run's outbox rows is written so that its plan does not depend on the table's
statistics: the run's highest sequence is read as `ORDER BY sequence DESC
LIMIT 1`, not `max(sequence)`, which Postgres plans as a scan of the run's
whole range when stale statistics expect one row for the run. The tests
measure each statement with no statistics, with statistics of the empty
table, with current ones, and with stale ones (taken while one run held a
few rows, then grown), on Postgres by pages read and on SQLite by plan.

The run's rows and its events are read at one moment, so a stage that ends
between two of the read's statements is never shown as a contradiction: the
Prisma reader reads in one `REPEATABLE READ` transaction on Postgres and one
transaction on SQLite. Inside a transaction you hand it (the row-level
security setup) that transaction's isolation decides; at `READ COMMITTED` a
stage that changes during the read can show as unavailable, naming the
field, until the next poll reads it at one moment. A custom
`ConsoleReadPort` should return the run detail as of one moment; one that
does not gets the same fallback, never a wrong history. A view of one run only ever merges responses to its own
requests: a response that does not continue what the page holds (a late one,
or one for another run) changes nothing. Rows missing from what was read keep
the history unavailable until the page is reloaded.

## Delivering a signal

A stage suspended on `ctx.step.waitForSignal` — the human-approval case —
is finished from the run detail: a step with `kind === "signal"` and
`status === "pending"` offers *Deliver signal* with a validated JSON payload
box. It dispatches `step.signal` through the kernel:

```
POST /api/runs/:runId/stages/:stageId/steps/:stepId/signal
{ "payload": { "approved": true } }   // optional; defaults to null
```

It is gated by `authorize` like every write (the context carries `stageId`
and `stepId` alongside `runId`), and the kernel's refusals become statuses:
an unknown run or stage is a 404, a step that is not a pending signal is a
409, both with the kernel's message.

## Redriving a run

*Rerun* dispatches `run.redrive`, not the deprecated `run.rerunFrom`, so a
`CANCELLED` run can be redriven and the superseded attempt is archived
rather than deleted. The request takes `from: { kind: "lastFailure" |
"start" | "stage" }` (`fromStageId` still means "from this stage"), and
`definitionVersion: "latest"` or a registered version; a malformed `from` is
a 400 rather than a silent fall back to one mode. The UI offers *Redrive on
latest version* on any run carrying a pinned version. The action name is
still `run.rerun`, so an existing `authorize` keeps matching.

![A support-triage run that failed on a CRM outage and completed after one redrive: the header shows the redrive count](/img/console/run-redriven.png)

## Without a web application

A worker-only repository has nothing to mount into. `workflow-console`
serves the same handler on a local HTTP server:

```bash
npx workflow-console --config ./console.config.mjs
```

The config module builds the reader the way your own code does, which is
what keeps row-level security intact. It binds to loopback only and ships
no authentication — it is a development tool. Connecting it directly with
`--database-url` is possible but requires `--allow-direct-connection`,
which acknowledges that the connection is a second session and will not be
scoped by your policies. `--database-url` needs `@prisma/client`, so it works
on Prisma 6 and 7 only.

On Prisma 8, `--config` is the only route. The module builds the client and
wraps it with `fromPrisma8`:

```js
// console.config.mjs
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { createPrismaConsoleReadPort } from "@bratsos/workflow-engine-console";
import { fromPrisma8 } from "@bratsos/workflow-engine/persistence/prisma";
import contractJson from "./prisma/contract.json" with { type: "json" };

const db = postgres({
  contract: contractFromJson(contractJson),
  url: process.env.DATABASE_URL,
});

export default {
  reader: createPrismaConsoleReadPort(fromPrisma8(db)),
  dispose: () => db.close(),
};
```

For SQLite, build `db` with `sqlite({ contract, path })` from
`@prisma/orm-sqlite/runtime` and pass `{ databaseType: "sqlite" }` to
`createPrismaConsoleReadPort`.

## Finding a run stranded on an old definition version

[Definition versioning](../core-concepts/definition-versioning.md) pins a
run to the structure it started under, and a run pinned to a version no
build serves any more sits there until someone redrives it. The runs list
carries each run's definition version — shortened, with the full value on
hover — and its redrive count as a `+N` suffix, and the filter bar takes a
version, so "show me everything still pinned to the old version" is one
query:

```
GET /api/runs?definitionVersion=sha256-…
```

The run detail shows the same two fields next to the run's timings, which
is what an operator needs before deciding whether to redrive onto
`"latest"`.

## The indexes it needs

The console's list views are "newest first, optionally narrowed", paged on
a `(createdAt, id)` keyset. The reference schema carries the composite
indexes for exactly those orderings — see
[Prisma setup](../persistence/prisma-setup.md). Without them the runs list
sequentially scans `workflow_runs`. On Prisma 8 the descending ones come
from [`mixed-order-indexes.sql`](../persistence/prisma-setup.md#the-mixed-order-indexes),
because a contract cannot express a sort direction.

There is deliberately no total count and no page numbers: counting a large
run table is the expensive query the console exists to avoid issuing. On
PostgreSQL, a query cancelled by `statement_timeout` comes back as HTTP 504
with a `query_timeout` code, which the UI shows as an inline banner while
leaving the filter bar interactive. SQLite has no `statement_timeout`, so the
console cannot cancel a running SQLite query this way.

The full reference — every option, the action vocabulary, custom read
ports, and what the console deliberately does not do — is in the
[package README](https://github.com/bratsos/workflow-engine/tree/main/packages/workflow-engine-console).
