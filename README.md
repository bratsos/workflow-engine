# workflow-engine

Type-safe, distributed workflow engine for AI-orchestrated processes with suspend/resume, parallel execution, and cost tracking.

## Packages

- [`@bratsos/workflow-engine`](./packages/workflow-engine) - Core library ([npm](https://www.npmjs.com/package/@bratsos/workflow-engine))
- [`@bratsos/workflow-engine-host-node`](./packages/workflow-engine-host-node) - Node.js host with process loops, signal handling, and continuous job polling
- [`@bratsos/workflow-engine-host-serverless`](./packages/workflow-engine-host-serverless) - Serverless host for Cloudflare Workers, AWS Lambda, Vercel Edge, etc.

## Architecture

The engine follows a **kernel + host** pattern:

- **Core library** provides the command kernel, stage/workflow definitions, and persistence adapters.
- **Host packages** wrap the kernel with environment-specific process management (polling loops, signal handling, request lifecycles).
- The **kernel** is a pure command dispatcher -- no timers, no signals, no global state -- making it portable across any runtime.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Documentation

See the [package README](./packages/workflow-engine/README.md) for full API documentation and usage examples.

## License

MIT
