# The Operational Console

The `@bratsos/workflow-engine-console` package provides an embeddable operational interface for monitoring runs, inspecting stage and step execution, diagnosing queue health, and dispatching operator interventions. It compiles to a framework-agnostic `(Request) => Promise<Response>` handler with an embedded single-page UI, opening no database connections and running no background daemons of its own. Reads execute through a read port constructed over an existing Prisma client or transaction, ensuring queries run within the host application's session under its row-level security policies. Writes dispatch kernel commands rather than issuing raw SQL. This reference covers mounting the console handler, configuring authorisation, query timeout semantics, keyset pagination requirements, and local development usage.

## Architecture and security model

The console runs embedded inside the host application rather than as a standalone service. The workflow engine stores state in PostgreSQL, where multi-tenant architectures commonly isolate data using row-level security (RLS) policies evaluated against session state (such as `SET LOCAL app.current_tenant_id = '...'`).

A separate dashboard process connecting through its own connection pool establishes a separate database session. In that topology, row-level security cannot be scoped to the caller's session: the dashboard must either connect with a privileged role that bypasses RLS entirely—exposing all tenants' workflow executions to any console operator—or it sees no records at all.

To maintain tenant boundaries, the console never opens its own database connection. You construct its read port (`ConsoleReadPort`) directly from the Prisma client or transaction client your application already holds. Authentication is handled upstream by your application framework; the console's `authorize` callback answers only whether the authenticated principal has permission to perform a specific action within that session.

The order in the host's own request pipeline is therefore: authenticate the
request, open the tenant transaction (or set the session variables) you
already open for the rest of the application, then hand the `Request` to the
console handler. The handler evaluates `authorize({ action, request, runId })`,
runs its reads on the client you gave it, and dispatches any write as a kernel
command.

The package declares `@bratsos/workflow-engine` as a peer dependency and has zero runtime dependencies. It is published as an ES module (`"type": "module"`) under MIT, exporting:
- `.` (main entry point: `createWorkflowConsole`, `createPrismaConsoleReadPort`, types)
- `./node` (`toNodeHandler` bridge for Node.js stream interfaces)
- `./testing` (`createInMemoryConsoleReadPort` for tests)
- `workflow-console` CLI binary (`./dist/cli.js`)

## Setup and mounting

`createWorkflowConsole` accepts an options object and returns a standard Fetch API handler `(request: Request) => Promise<Response>`.

```typescript
export interface WorkflowConsoleOptions {
  /** Reads run on this. Built from the caller's client or transaction. */
  reader: ConsoleReadPort;
  /** Per-request authorisation. Omitted means all actions are denied. */
  authorize?: (context: ConsoleAuthorizeContext) => boolean | Promise<boolean>;
  /** Required only when `actions` is true. */
  kernel?: ConsoleKernel;
  /** Write actions are off unless this is true. Defaults to false. */
  actions?: boolean;
  /** Mount path prefix if the handler cannot derive it from request.url. */
  basePath?: string;
  /** UI poll interval in ms. Defaults to 5000. */
  pollIntervalMs?: number;
  /** Fix the poll interval and hide the UI interval picker. */
  forcePollInterval?: boolean;
  /** Supply a CSP nonce for the injected inline config script. */
  cspNonce?: (request: Request) => string | undefined;
  /** Invoked after each successfully executed write action. */
  onAction?: (event: ConsoleActionEvent) => void | Promise<void>;
}
```

### Next.js App Router

Mount the handler as a catch-all route at `app/admin/console/[[...path]]/route.ts`:

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

    if (action === "run.cancel" || action === "run.rerun" || action === "step.signal" || action === "deadLetters.replay") {
      return session.user.role === "admin";
    }
    return session.user.role === "admin" || session.user.role === "operator";
  },
});

export const GET = handler;
export const POST = handler;
```

### Runtimes with native `Request`/`Response`

Hono, Cloudflare Workers, Deno, and Bun invoke the handler directly:

```typescript
// Hono
app.all("/admin/console/*", (c) => handler(c.req.raw));

// Cloudflare Workers / Bun fetch handler
export default {
  fetch(request: Request) {
    return handler(request);
  },
};
```

### Express, Fastify, and `node:http`

Runtimes using Node.js `IncomingMessage` and `ServerResponse` streams use `toNodeHandler` from `@bratsos/workflow-engine-console/node`:

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

### Scoping within an existing transaction

When evaluating queries under active row-level security session variables, instantiate `createPrismaConsoleReadPort` over the active transaction client:

```typescript
export async function GET(request: Request): Promise<Response> {
  const session = await getSession(request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  return prisma.$transaction(async (tx) => {
    // Parameterised: the tenant id comes from the session, never from the URL.
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${session.tenantId}, true)`;

    const reader = createPrismaConsoleReadPort(tx);
    const handler = createWorkflowConsole({
      reader,
      authorize: () => true, // Identity and tenant already checked
    });

    return handler(request);
  });
}

export const POST = GET;
```

## Authorisation

Authorisation is **denied by default**. If the `authorize` option is omitted, every action is rejected with an HTTP 403 response. If the `authorize` callback throws an error, the catch block fails closed and access is denied. Only an explicit return value of `true` allows the action.

The reason for this design is security in multi-tenant environments: a permissive default would leak tenant execution data to anyone accessing an unconfigured route if a developer forgot a line of configuration.

The action vocabulary consists of discrete capability strings rather than HTTP verbs:

```typescript
export const CONSOLE_ACTIONS = [
  "runs.read",
  "run.read",
  "queue.read",
  "suspended.read",
  "deadLetters.read",
  "workers.read",
  "costs.read",
  "run.cancel",
  "run.rerun",
  "step.signal",
  "deadLetters.replay",
] as const;

export type ConsoleAction = (typeof CONSOLE_ACTIONS)[number];

export const WRITE_ACTIONS: readonly ConsoleAction[] = [
  "run.cancel",
  "run.rerun",
  "step.signal",
  "deadLetters.replay",
] as const;
```

The callback receives a `ConsoleAuthorizeContext`:

```typescript
export interface ConsoleAuthorizeContext {
  action: ConsoleAction;
  request: Request;
  runId?: string; // Defined for run-scoped actions: "run.read", "run.cancel", "run.rerun", "step.signal"
  stageId?: string; // Defined for "step.signal"
  stepId?: string; // Defined for "step.signal"
}
```

## Actions and kernel dispatch

Write actions are disabled by default (`actions: false`). Setting `actions: true` requires passing a `kernel` instance. If `actions: true` is passed without a `kernel`, the constructor throws an error immediately:

```
createWorkflowConsole: `actions: true` needs a `kernel` to dispatch to. Console writes go through kernel commands, never SQL.
```

The console never executes direct `UPDATE` or `DELETE` SQL statements against database tables. All state modifications dispatch commands through the engine's kernel:

- `"run.cancel"`: Dispatches `{ type: "run.cancel", workflowRunId, reason }`
- `"run.rerun"`: Dispatches `{ type: "run.redrive", workflowRunId, from, definitionVersion? }`
- `"step.signal"`: Dispatches `{ type: "step.signal", workflowRunId, stageId, stepId, payload }`
- `"deadLetters.replay"`: Dispatches `{ type: "plugin.replayDLQ", maxEvents }`

`POST /runs/:id/rerun` takes `fromStageId` (which becomes `from: { kind: "stage", stageId }`), or a `from` of `{ kind: "lastFailure" | "start" | "stage" }`, and an optional `definitionVersion` — `"latest"` or a registered version. One of `fromStageId` or `from` is required, and a malformed `from` is a 400 rather than a fall back to the default mode: an operator who asked to restart a whole run must not silently get a retry of one stage.

The `definitionVersion` argument is what makes a **stranded run** recoverable from the console. A run pinned to a version no deployment serves any more is claimed by nobody, and the only thing that moves it is a redrive that re-pins it — see [13-definition-versioning.md](13-definition-versioning.md). The UI exposes this as *Redrive on latest version* on any run that carries a pinned version. The console dispatched the deprecated `run.rerunFrom` until 1.0.0-alpha.11; that command refuses a `CANCELLED` run and has no way to express a re-pin, so neither was reachable from the console.

`POST /runs/:runId/stages/:stageId/steps/:stepId/signal` completes a `waitForSignal` durable step from the console — the human-approval case, where the thing a stage is waiting on is an operator. The body is `{ payload: <json> }`; `payload` is optional and defaults to `null`. The kernel's refusals map to HTTP statuses rather than a 500: an unknown run or stage is a 404, and a step that is not a pending signal (previously used as a `run` step, or already failed) is a 409 carrying the kernel's message. Signalling an already-completed step is idempotent and returns `alreadyCompleted: true`. `StepSummary` carries `kind`, `status`, `deadlineAt` and `externalKey`, so the UI offers *Deliver signal* only on a step with `kind === "signal"` and `status === "pending"`, and shows the external key on `run` steps. A custom `ConsoleKernel` must accept `step.signal`.

Bypassing SQL updates ensures that execution leases, state machine transitions, idempotency checks, and outbox event emissions are preserved by the authoritative engine kernel.

When an action succeeds, the optional `onAction` callback is invoked for audit logging:

```typescript
export interface ConsoleActionEvent {
  action: ConsoleAction;
  runId?: string;
  request: Request;
  result: unknown;
  at: Date;
}
```

## The read port and query timeouts

All database queries are executed via the `ConsoleReadPort` interface:

```typescript
export interface ConsoleReadPort {
  readonly capabilities: ConsoleCapabilities;
  listRuns(query: RunListQuery): Promise<RunListPage>;
  getRunDetail(runId: string, options?: RunDetailOptions): Promise<RunDetail | null>;
  listRunEvents(runId: string, afterSequence: number, limit?: number): Promise<RunEvent[]>;
  getQueueHealth(): Promise<QueueHealth>;
  listSuspendedStages(limit?: number): Promise<SuspendedStage[]>;
  listDeadLetters(limit?: number): Promise<DeadLetter[]>;
  listWorkers(): Promise<WorkerInstance[]>;
  getCosts(query: CostQuery): Promise<CostBucket[]>;
}

export interface ConsoleCapabilities {
  runs: boolean;
  steps: boolean;
  annotations: boolean;
  queue: boolean;
  suspended: boolean;
  deadLetters: boolean;
  workers: boolean;
  costs: boolean;
}
```

The `capabilities` object indicates which features the underlying storage adapter supports. If a capability is `false`, the UI hides the corresponding navigation tabs and panels rather than displaying empty states or errors:
- If `runs` is `false`, the runs view tab is hidden.
- If `deadLetters` is `false`, the dead-letters tab is hidden.
- If `costs` is `false`, the costs tab is hidden.
- In the queue view, `queue`, `suspended`, and `workers` conditionally toggle their respective sections. If all three are `false`, the queue navigation link is omitted.

The Prisma implementation is built using `createPrismaConsoleReadPort`:

```typescript
export interface PrismaConsoleReadPortOptions {
  statusEnumName?: string;     // Defaults to "Status"
  statementTimeoutMs?: number; // Defaults to 15000; 0 disables
  now?: () => Date;            // Defaults to () => new Date()
}

export function createPrismaConsoleReadPort(
  prisma: ConsolePrismaClient,
  options?: PrismaConsoleReadPortOptions,
): ConsoleReadPort;
```

### Statement timeout behaviour

`statementTimeoutMs` defaults to 15,000 ms. Timeout management differs depending on the client supplied:
- **Root Prisma client**: When passed a root client (where `$transaction` is present), the read port wraps requests in a single transaction and executes `SET LOCAL statement_timeout = <ms>`. Running multi-query pages (like run detail) in one transaction prevents holding multiple connection pool slots and provides a consistent snapshot.
- **Transaction client**: When passed an active transaction client (where `$transaction` is absent), the read port **skips** `SET LOCAL statement_timeout`. It does not override the timeout budget of a transaction opened by the caller.

If a query exceeds the limit, PostgreSQL cancels the statement with SQLSTATE `57014`. The read port catches this and throws `ConsoleQueryTimeoutError`:

```typescript
export class ConsoleQueryTimeoutError extends Error {
  readonly code = "query_timeout" as const;
  constructor(
    readonly query: string,
    readonly timeoutMs: number,
    options?: { cause?: unknown },
  );
}
```

The console handler converts this error into an HTTP 504 response with error code `"query_timeout"`. The UI catches the 504 and renders an inline warning banner while leaving the search filter controls interactive, allowing the operator to narrow filters without hanging the browser.

## Keyset pagination and indexes

The runs list uses keyset pagination on `(createdAt, id)` in descending order (newest first).

The cursor is an opaque base64url string encoding `createdAt.toISOString()|id`. There is deliberately no total count (`COUNT(*)`) and no numeric page navigation (`page=2`). On large production databases containing millions of runs, running `COUNT(*)` or high-offset queries (`OFFSET 50000`) forces expensive sequential table scans. Keyset pagination ensures every page query executes as a bounded index range scan:

```sql
WHERE ("createdAt", id) < ($1::timestamptz AT TIME ZONE 'UTC', $2)
ORDER BY "createdAt" DESC, id DESC
LIMIT 51
```

To support console queries efficiently, ensure the following composite indexes from the package's reference Prisma schema are present in your database:
- `workflow_runs(createdAt DESC, id DESC)`
- `workflow_runs(status, createdAt DESC, id DESC)`
- `workflow_runs(workflowId, createdAt DESC, id DESC)`
- `job_queue(status, createdAt)`
- `outbox_events(dlqAt)`

## Testing

For unit and integration tests, import `createInMemoryConsoleReadPort` from the `@bratsos/workflow-engine-console/testing` subpath export:

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
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:01:00Z"),
      workflowId: "order-workflow",
      workflowName: "Order Workflow",
      workflowType: "order",
      status: "COMPLETED",
      startedAt: new Date("2026-01-01T00:00:01Z"),
      completedAt: new Date("2026-01-01T00:00:10Z"),
      duration: 9000,
      totalCost: 0.02,
      totalTokens: 500,
      priority: 0,
    },
  ],
};

const reader = createInMemoryConsoleReadPort(fixtures, {
  capabilities: { costs: false },
});

const handler = createWorkflowConsole({
  reader,
  authorize: () => true,
});

const response = await handler(new Request("http://localhost/api/runs"));
const data = await response.json();
```

## The local dev CLI

Worker-only codebases lack an HTTP application into which the console handler can be mounted. The package provides a local development CLI command:

```bash
npx workflow-console --config ./console.config.mjs
```

The CLI starts a local Node.js HTTP server hosting the console handler. It is strictly a local development utility:
- **Loopback binding only**: It binds exclusively to `127.0.0.1`, `localhost`, `::1`, or `[::1]`. It explicitly refuses non-loopback network interfaces because it ships with no authentication mechanism.
- **Config module**: The `--config` path points to an ES module exporting a `ConsoleDevConfig` object (or function returning one) via default export or named export `console`:

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

### Direct connection flag

The CLI supports direct database connection strings via `--database-url`, but requires the `--allow-direct-connection` acknowledgement flag:

```bash
npx workflow-console --database-url postgres://localhost:5432/db --allow-direct-connection
```

`--allow-direct-connection` explicitly acknowledges that establishing a direct connection creates a separate database session that bypasses application-level row-level security. The console will read all records visible to that database role across all tenants.

### Command-line flags

| Flag | Argument | Default | Description |
|---|---|---|---|
| `--config` | `<path>` | — | Path to module exporting `{ reader, kernel?, dispose? }` |
| `--database-url` | `<url>` | — | PostgreSQL connection URL; requires `--allow-direct-connection` |
| `--allow-direct-connection` | — | `false` | Acknowledge that direct connections bypass session-scoped RLS policies |
| `--port` | `<n>` | `7799` | Port to bind (1–65535) |
| `--host` | `<addr>` | `127.0.0.1` | Loopback address (`127.0.0.1`, `localhost`, `::1`, `[::1]`) |
| `--actions` | — | `false` | Enable write operations (requires `kernel` in `--config`) |
| `--poll` | `<ms>` | `5000` | UI poll interval in milliseconds |
| `--help`, `-h` | — | `false` | Display command help |
