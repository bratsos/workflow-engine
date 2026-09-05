# workflow-engine

A TypeScript library that runs durable, multi-stage workflows in **your own
Postgres**. No server to deploy, no vendor: install it, hand it a Prisma
client, and run it from a Node process, a serverless function or a cron
trigger. Workflow state lives in tables beside your application's tables.

Built for pipelines whose expensive steps are model calls, so what it takes
seriously is suspending across hours, per-call cost, and provider batch
endpoints:

- **The kernel can run inside your transaction.** It is a pure command
  dispatcher with no connection of its own, so building its persistence port
  over a Prisma transaction client puts the whole tick on your session — where
  a `SET LOCAL` for your tenant and your row-level security policies apply.
- **Provider batch APIs are durable steps.** `ctx.step.ai.map` submits to
  OpenAI Batch, Anthropic Message Batches, Google/Vertex batch or OpenRouter
  `:batch`, suspends and releases its lease, and resumes from the step ledger —
  adopting an in-flight batch rather than paying for a second one after a
  crash.
- **Cost is a column, not a trace.** Tokens and cost land on
  `WorkflowRun.totalCost` in the same transaction as the stage that spent
  them, priced from the endpoint actually used (batch prices for a batch call,
  not a flat 50% off), so the next stage can gate on spend.
- **Schema problems fail before submit.** A schema no provider dialect can
  express raises `UnportableSchemaError` naming the path and the keyword,
  rather than a provider 400 — or, on Anthropic, a batch that reports its
  validation errors a day later.

It is alpha, TypeScript-only, and the pipeline shape is linear execution
groups rather than an arbitrary DAG. The
[introduction](https://github.com/bratsos/workflow-engine/blob/main/apps/docs/docs/getting-started/intro.md)
says what it deliberately does not do, and where another project is the better
choice.

## Packages

- [`@bratsos/workflow-engine`](./packages/workflow-engine) - Core library ([npm](https://www.npmjs.com/package/@bratsos/workflow-engine))
- [`@bratsos/workflow-engine-host-node`](./packages/workflow-engine-host-node) - Node.js host with process loops, signal handling, and continuous job polling
- [`@bratsos/workflow-engine-host-serverless`](./packages/workflow-engine-host-serverless) - Serverless host for Cloudflare Workers, AWS Lambda, Vercel Edge, etc.
- [`@bratsos/workflow-engine-host-remote`](./packages/workflow-engine-host-remote) - Credential-free remote activity workers -- run a stage on a separate machine that never sees your database or provider credentials
- [`@bratsos/workflow-engine-console`](./packages/workflow-engine-console) - Optional embeddable operational console: a `(Request) => Promise<Response>` handler plus a prebuilt UI you mount in your own app, reading through your own Prisma client or transaction (runs, step ledger, signals, redrive, dead letters, costs)

## Architecture

The engine follows a **kernel + host** pattern:

- **Core library** provides the command kernel, stage/workflow definitions, durable steps (`ctx.step.*`, backed by a step ledger), and persistence adapters.
- **Host packages** wrap the kernel with environment-specific process management (polling loops, signal handling, request lifecycles, job lease heartbeats that abort a cancelled stage).
- The **kernel** is a pure command dispatcher -- no timers, no signals, no global state -- making it portable across any runtime.
- The **console** is optional and nothing in the engine depends on it.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Documentation

See the [package README](./packages/workflow-engine/README.md) for full API documentation and usage examples. The agent skill under `packages/workflow-engine/skills/workflow-engine/` carries the reference (durable steps, definition versioning, redrive, large payloads, the console) and the `migrate-0.13-to-1.0.md` upgrade guide.

## License

MIT
