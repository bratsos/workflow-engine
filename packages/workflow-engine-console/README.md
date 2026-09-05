# @bratsos/workflow-engine-console

An optional, embeddable operational console for [`@bratsos/workflow-engine`](../workflow-engine): a framework-agnostic `(Request) => Promise<Response>` handler plus a prebuilt UI, mounted directly inside your application. It opens no database connections and runs no background daemons of its own. Reads go through a read port constructed from your existing database client or transaction, running inside your session under your row-level security policies with authentication decided upstream. Writes dispatch engine kernel commands rather than issuing SQL. Nothing in the workflow engine depends on this package, and nothing here is required to execute workflows.

## Why it mounts instead of running as a service

Workflow engine state lives in your application's Postgres database. In multi-tenant environments, architectures frequently run the engine kernel inside a single database transaction per tenant under PostgreSQL row-level security (RLS). Row-level security policies are evaluated against the specific session in which the query executes — typically configured via session variables like `SET LOCAL app.current_tenant_id = '...'`.

A standalone dashboard service running as a separate process with its own database connection pool creates an entirely separate database session. In that architecture, there is no configuration that recovers tenant scoping: the external service either runs as a superuser or privileged role that bypasses RLS entirely — exposing all tenant data to any operator with dashboard access — or it cannot inspect runs at all.

For that reason, `@bratsos/workflow-engine-console` never opens a database connection. It is constructed from the client, or the active transaction client, your application already owns. It executes queries within your existing session, under your existing RLS policies, with user authentication already verified by your application framework before the handler is invoked. This is the same embedded operational model that Bull Board, Oban Web, and River UI converged on independently.

## Install

```bash
pnpm add @bratsos/workflow-engine-console
```

`@bratsos/workflow-engine-console` declares `@bratsos/workflow-engine` as a peer dependency and is released in lockstep with it.

## Quick start — Next.js App Router

The primary mounting pattern is a catch-all route handler in the Next.js App Router at `app/admin/console/[[...path]]/route.ts`:

```typescript
import {
  createPrismaConsoleReadPort,
  createWorkflowConsole,
} from "@bratsos/workflow-engine-console";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reader = createPrismaConsoleReadPort(prisma);

const handler = createWorkflowConsole({
  reader,
  authorize: async ({ action, request }) => {
    const session = await getSession(request);
    if (!session) return false;

    // Writes require admin role; reads permit operators
    if (
      action === "run.cancel" ||
      action === "run.rerun" ||
      action === "step.signal" ||
      action === "deadLetters.replay"
    ) {
      return session.user.role === "admin";
    }

    return session.user.role === "admin" || session.user.role === "operator";
  },
});

export const GET = handler;
export const POST = handler;
```

## Mounting elsewhere

Because the console handler implements the standard Web Fetch signature `(Request) => Promise<Response>`, it mounts into any modern JavaScript runtime without dedicated adapter packages.

### Hono

```typescript
import { Hono } from "hono";
import {
  createPrismaConsoleReadPort,
  createWorkflowConsole,
} from "@bratsos/workflow-engine-console";

const app = new Hono();
const reader = createPrismaConsoleReadPort(prisma);
const handler = createWorkflowConsole({ reader, authorize });

app.all("/admin/console/*", (c) => handler(c.req.raw));
```

### Cloudflare Workers, Deno, and Bun

The console handler matches the native fetch handler contract directly:

```typescript
import {
  createPrismaConsoleReadPort,
  createWorkflowConsole,
} from "@bratsos/workflow-engine-console";

const reader = createPrismaConsoleReadPort(prisma);
const handler = createWorkflowConsole({ reader, authorize });

export default {
  fetch(request: Request) {
    return handler(request);
  },
};
```

### Express, Fastify, and bare `node:http`

Runtimes using Node.js `IncomingMessage` and `ServerResponse` streams use the `toNodeHandler` bridge from the `@bratsos/workflow-engine-console/node` subpath export:

```typescript
import express from "express";
import {
  createPrismaConsoleReadPort,
  createWorkflowConsole,
} from "@bratsos/workflow-engine-console";
import { toNodeHandler } from "@bratsos/workflow-engine-console/node";

const app = express();
const reader = createPrismaConsoleReadPort(prisma);
const handler = createWorkflowConsole({ reader, authorize });

app.use("/admin/console", toNodeHandler(handler));
```

There are no per-framework wrapper packages; `Request` and `Response` serve as the universal lowest common denominator.

## Mounting inside a transaction (row-level security)

When running multi-tenant engines under PostgreSQL row-level security, instantiate the console reader over the transaction client inside your existing transaction block:

```typescript
import {
  createPrismaConsoleReadPort,
  createWorkflowConsole,
} from "@bratsos/workflow-engine-console";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET(request: Request): Promise<Response> {
  const session = await getSession(request);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_tenant_id = '${session.tenantId}'`,
    );

    const reader = createPrismaConsoleReadPort(tx);
    const handler = createWorkflowConsole({
      reader,
      authorize: () => true, // Already verified via session
    });

    return handler(request);
  });
}

export const POST = GET;
```

When `createPrismaConsoleReadPort` is passed a transaction client (a client instance where `$transaction` is absent), it deliberately does not issue `SET LOCAL statement_timeout`. The reader must not reconfigure the timeout budget of a transaction it did not open. In that scenario, timeout enforcement belongs to the caller who opened the transaction. When handed a root Prisma client, the reader manages its own bounded transaction per request.

## Authorisation

The `authorize` callback is required in production. If omitted, every console action is denied by default. Permissive defaults risk exposing operational runs if configuration is omitted.

Authorisation runs *after* your host application has handled authentication. The console assumes identity is established and evaluates permissions for specific operations. If the `authorize` callback throws an error, the request fails closed and access is denied.

```typescript
import {
  createWorkflowConsole,
  isWriteAction,
  type ConsoleAuthorizeContext,
} from "@bratsos/workflow-engine-console";

const handler = createWorkflowConsole({
  reader,
  authorize: async ({ action, request, runId }: ConsoleAuthorizeContext) => {
    const user = await authenticateUser(request);
    if (!user) return false;

    // Read access for authenticated users, mutations restricted to administrators
    if (isWriteAction(action)) {
      return user.role === "admin";
    }

    return true;
  },
});
```

The action vocabulary uses discrete verbs rather than HTTP methods, enabling fine-grained capability checks:

| Action | Kind | Description |
|---|---|---|
| `runs.read` | Read | List workflow runs with filters and keyset pagination |
| `run.read` | Read | View run details (stages, steps, annotations, logs) and incremental event timeline |
| `queue.read` | Read | View queue health, job counts by status, oldest pending job, and oldest lease |
| `suspended.read` | Read | List suspended stages awaiting resumption or polling deadlines |
| `deadLetters.read` | Read | List undeliverable outbox events routed to the dead-letter queue |
| `workers.read` | Read | List active worker instances inferred from active job leases |
| `costs.read` | Read | View aggregate execution costs and token usage by workflow or by day |
| `run.cancel` | Write | Cancel an active workflow run |
| `run.rerun` | Write | Rerun a workflow run from a designated stage |
| `step.signal` | Write | Complete a pending `waitForSignal` durable step with a payload |
| `deadLetters.replay` | Write | Replay failed outbox events from the dead-letter queue |

## Actions

The console defaults to read-only mode (`actions: false`). Enabling write actions requires `actions: true` and a `kernel` instance:

```typescript
import { createKernel } from "@bratsos/workflow-engine/kernel";
import { createWorkflowConsole } from "@bratsos/workflow-engine-console";

const kernel = createKernel({ /* ... */ });

const handler = createWorkflowConsole({
  reader,
  kernel,
  actions: true,
  authorize: async ({ action }) => {
    // Return boolean based on permissions
    return true;
  },
  onAction: async ({ action, runId, request, result, at }) => {
    auditLogger.info({
      action,
      runId,
      result,
      timestamp: at.toISOString(),
    });
  },
});
```

Mutations never issue direct SQL updates against run records. Instead, writes dispatch standard engine commands through the kernel:
- `run.cancel` dispatches `{ type: "run.cancel", workflowRunId, reason }`
- `run.rerun` dispatches `{ type: "run.redrive", workflowRunId, from, definitionVersion? }` — `fromStageId` in the request body still means "from this stage"; pass `from: { kind: "lastFailure" | "start" | "stage" }` and `definitionVersion: "latest"` to move a run stranded on a version nobody serves
- `step.signal` dispatches `{ type: "step.signal", workflowRunId, stageId, stepId, payload }` — `POST /api/runs/:runId/stages/:stageId/steps/:stepId/signal` with `{ payload }` (optional, defaults to `null`); an unknown run or stage is a 404 and a step that is not a pending signal is a 409, both carrying the kernel's message
- `deadLetters.replay` dispatches `{ type: "plugin.replayDLQ", maxEvents }`

Routing writes through the kernel ensures that execution leases, idempotency guarantees, transition invariants, and outbox publication events remain enforced by the authoritative state machine. The `onAction` hook provides an audit callback invoked immediately after each successful mutation.

## The local dev command

Repositories containing only background workers lack an HTTP application into which the console can be mounted. The package provides a local CLI command to bridge this gap:

```bash
npx workflow-console --config ./console.config.mjs
```

`workflow-console` hosts the identical fetch handler over a local Node.js HTTP server. It is strictly a development tool: it binds exclusively to loopback (`127.0.0.1`) and refuses external interfaces. It includes no authentication mechanisms.

The configuration module must export a `ConsoleDevConfig` object (or a function returning one) via default export or named export `console`:

```javascript
// console.config.mjs
import { PrismaClient } from "@prisma/client";
import { createPrismaConsoleReadPort } from "@bratsos/workflow-engine-console";
import { createKernel } from "@bratsos/workflow-engine/kernel";

const prisma = new PrismaClient();
const kernel = createKernel({ /* ... */ });

export default {
  reader: createPrismaConsoleReadPort(prisma),
  kernel,
  dispose: async () => {
    await prisma.$disconnect();
  },
};
```

### Direct connection escape hatch

For rapid local inspection without writing a config file, `--database-url` can be paired with `--allow-direct-connection`:

```bash
npx workflow-console --database-url postgres://postgres:postgres@localhost:5432/mydb --allow-direct-connection
```

The `--allow-direct-connection` flag requires explicit acknowledgement that connecting directly establishes a separate database session. Application-level row-level security policies will not apply, and the console will read any record visible to the connecting PostgreSQL database role across all tenants.

### CLI options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--config <path>` | string | — | Path to module exporting `{ reader, kernel?, dispose? }` |
| `--database-url <url>` | string | `DATABASE_URL` | Direct PostgreSQL connection string (requires `--allow-direct-connection`) |
| `--allow-direct-connection` | boolean | `false` | Acknowledge that direct connections bypass session-scoped row-level security |
| `--port <n>` | number | `7799` | Port to bind (1–65535) |
| `--host <addr>` | string | `127.0.0.1` | Loopback address to bind (`127.0.0.1`, `localhost`, `::1`) |
| `--actions` | boolean | `false` | Enable write actions; requires `kernel` in `--config` |
| `--poll <ms>` | number | `5000` | UI poll interval in milliseconds |
| `--help`, `-h` | boolean | `false` | Display command help |

## What it shows

The console provides seven operational views:
- **Runs list**: Keyset-paginated list filtered by execution status, workflow ID, workflow type, definition version, and date ranges. Each row carries the run's definition version (shortened, full value on hover) with its redrive count as a `+N` suffix — filtering by version is how "show me everything still pinned to the old version" is answered.
- **Run detail**: Definition version and redrive count alongside the run's timings and cost, plus the complete execution hierarchy including stage timelines, durable step ledger entries (kind, status, attempt, deadline, and the `externalKey` of `run` steps, so an orphaned provider-side effect can be searched for), annotations, execution logs, and outbox event streams. With actions enabled, a step with `kind === "signal"` and `status === "pending"` offers *Deliver signal* with a validated JSON payload box, and a run carrying a pinned version offers *Redrive on latest version*.
- **Queue health**: Job distribution by status, enqueue timestamp of the oldest pending job, oldest active lock duration, and overdue polling stages.
- **Suspended stages**: Stages awaiting external event resumption or deferred polling schedules.
- **Workers**: Active worker instances derived from heartbeat locks on `job_queue`, reporting active execution count, oldest active lock, and last heartbeat age.
- **Dead letters**: Outbox events diverted to the dead-letter queue following repeated publication failures.
- **Costs**: Aggregate execution financial costs and token usage grouped by workflow or by calendar day.

## Performance and the indexes it needs

To maintain performant queries against operational tables without degraded index scans, the workflow engine's Prisma schema includes composite indexes aligned with console queries:
- `workflow_runs(createdAt DESC, id DESC)`
- `workflow_runs(status, createdAt DESC, id DESC)`
- `workflow_runs(workflowId, createdAt DESC, id DESC)`
- `workflow_runs(definitionVersion)` and `workflow_runs(status, workflowId, definitionVersion)` for the version filter
- `job_queue(status, createdAt)`
- `outbox_events(dlqAt)`

When upgrading existing deployments, apply these database migrations before enabling the console to avoid sequential scans over high-volume tables.

### Keyset pagination

Pagination over workflow runs uses keyset pagination via opaque cursors encoding `(createdAt, id)` tuples. Keyset queries translate directly into index range scans:

```sql
WHERE ("createdAt", id) < ($1::timestamptz AT TIME ZONE 'UTC', $2)
ORDER BY "createdAt" DESC, id DESC
LIMIT 51
```

The console deliberately does not compute total record counts and provides no arbitrary page jumping. Executing `COUNT(*)` over multi-million row run tables creates excessive query load; keyset pagination guarantees identical query plans regardless of pagination depth.

### Query timeouts

The read port enforces a query timeout via `statementTimeoutMs` (default: 15000 ms). If a query exceeds this limit, the database cancels execution and the console API responds with an HTTP 504 status:

```json
{
  "error": {
    "code": "query_timeout",
    "message": "runs.list timed out after 15000ms"
  }
}
```

The frontend catches this error and renders an inline warning banner while maintaining filter bar interactivity, allowing operators to narrow search parameters rather than experiencing an unresponsive interface.

## The UI

The frontend is a single-page application built with Preact, compiled at package build time directly into string literals within the distribution bundle. Consumers run no frontend build pipelines, install no client dependencies, introduce no additional packages into their dependency tree, and load no assets from external CDNs.

- **Bundle size**: Approximately 40 kB of JavaScript and 13 kB of CSS uncompressed (roughly 15 kB combined under gzip).
- **Path-agnostic routing**: Navigation routes entirely via the URL fragment (`#/runs`, `#/runs/:id`). The server handler serves identical assets regardless of the mount path without requiring URL rewriting configuration.
- **Adaptive polling**: Refreshes data automatically every 5 seconds by default (`pollIntervalMs`). Polling suspends when browser tabs lose focus. Polling rates can be fixed via `forcePollInterval: true`.
- **Styling isolation**: All stylesheet rules are scoped beneath the `#workflow-console-root` container selector to prevent interference with host application layouts. Both dark and light colour schemes are supported.
- **Content Security Policy**: Hosts enforcing strict CSP rules can provide a nonce via the `cspNonce` configuration option:

```typescript
const handler = createWorkflowConsole({
  reader,
  cspNonce: (request) => request.headers.get("x-csp-nonce") ?? undefined,
});
```

## Serving your own UI / API only

The operational console separates storage queries, API serialization, and UI presentation. `ConsoleReadPort` is a decoupled interface, and the JSON API can be mounted independently if you choose to build custom operational dashboards:

- `GET /api/meta`: System capabilities and runtime configuration
- `GET /api/runs`: Keyset-paginated workflow runs
- `GET /api/runs/:id`: Complete run detail graph
- `GET /api/runs/:id/events`: Incremental outbox event stream
- `GET /api/queue`: Queue metrics and lease telemetry
- `GET /api/suspended`: Stages waiting on external triggers
- `GET /api/dead-letters`: Dead-letter queue messages
- `GET /api/workers`: Active worker instances
- `GET /api/costs`: Token and financial cost aggregations
- `POST /api/runs/:id/cancel`: Cancel an execution
- `POST /api/runs/:id/rerun`: Rerun execution from a stage
- `POST /api/runs/:id/stages/:stageId/steps/:stepId/signal`: Deliver a payload to a pending signal step
- `POST /api/dead-letters/replay`: Replay failed events

## Custom adapters

`ConsoleReadPort` is defined within `@bratsos/workflow-engine-console` rather than added to `@bratsos/workflow-engine`'s `PersistenceCore`. This architecture prevents mandatory console read requirements from complicating third-party storage adapters.

Custom storage backends implement `ConsoleReadPort` and declare supported features via `capabilities`:

```typescript
import type {
  ConsoleCapabilities,
  ConsoleReadPort,
} from "@bratsos/workflow-engine-console";

export class CustomConsoleReadPort implements ConsoleReadPort {
  readonly capabilities: ConsoleCapabilities = {
    runs: true,
    steps: true,
    annotations: false,
    queue: true,
    suspended: false,
    deadLetters: false,
    workers: false,
    costs: false,
  };

  // Implement required read methods...
}
```

The user interface inspects the reader's declared capabilities and omits navigation tabs for unsupported views.

## Testing

For unit and integration testing without a running PostgreSQL instance, import `createInMemoryConsoleReadPort` from the `@bratsos/workflow-engine-console/testing` subpath:

```typescript
import {
  createInMemoryConsoleReadPort,
  type ConsoleFixtures,
} from "@bratsos/workflow-engine-console/testing";
import { createWorkflowConsole } from "@bratsos/workflow-engine-console";

const fixtures: ConsoleFixtures = {
  runs: [
    {
      id: "run-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      workflowId: "order-processing",
      workflowName: "Order Processing",
      workflowType: "order",
      status: "COMPLETED",
      startedAt: new Date(),
      completedAt: new Date(),
      duration: 1200,
      totalCost: 0.04,
      totalTokens: 1500,
      priority: 0,
    },
  ],
};

const reader = createInMemoryConsoleReadPort(fixtures);
const handler = createWorkflowConsole({
  reader,
  authorize: () => true,
});

const response = await handler(new Request("http://localhost/api/runs"));
const data = await response.json();
```

## What it deliberately does not do

The console's scope is explicitly bounded:
- **No authentication system**: Identity verification is delegated entirely to the host application framework.
- **No standalone daemon or container image**: It exists as an embedded handler mounted within an existing application.
- **No separate projection or rollup tables**: Queries execute directly against engine operational tables; historic reporting is limited to retained run rows.
- **No total run counts**: Aggregate counting queries are avoided to preserve database query performance.
- **No streaming transports**: Telemetry updates through interval polling rather than persistent WebSocket or Server-Sent Events connections.
- **No full-text search over payloads**: Arbitrary payload queries across historical runs are omitted to avoid unindexed table scans on operational databases.

## License

MIT
