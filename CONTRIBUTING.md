# Contributing

## Setup

```bash
pnpm install
```

Requires Node.js >= 22.11 and pnpm (see `packageManager` in `package.json` for the exact version).

## Everyday commands

```bash
pnpm verify          # lint + typecheck + test + build (what CI runs)
pnpm build       # build all packages
pnpm test        # test all packages
pnpm typecheck   # typecheck all packages
pnpm lint        # biome check
pnpm lint:fix     # biome check --write
```

Postgres-backed persistence tests (`packages/workflow-engine/src/__tests__/12-persistence-adapters/prisma-postgres-conformance.test.ts`) are skipped unless `DATABASE_URL` is set. To run them locally:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/workflow_engine_test
pnpm --filter @bratsos/workflow-engine run prisma:generate
pnpm --filter @bratsos/workflow-engine run prisma:db-push
pnpm --filter @bratsos/workflow-engine run test:pg
```

## Package layout

This is a pnpm monorepo (`packages/*`):

- `workflow-engine` -- core library: command kernel, stage/workflow definitions, Prisma persistence adapters.
- `workflow-engine-host-node` -- Node.js host (polling loops, signal handling) for long-running worker processes.
- `workflow-engine-host-serverless` -- platform-agnostic serverless host (Cloudflare Workers, AWS Lambda, Vercel Edge, etc.).
- `workflow-engine-host-remote` -- credential-free remote activity workers, for running a stage on a separate machine.

## Making changes

1. Create a branch, make your change, add/update tests.
2. Run `pnpm verify` before opening a PR.
3. Add a changeset for any change that should ship in a release:

   ```bash
   pnpm changeset
   ```

   Pick the affected package(s) and a semver bump (patch/minor/major), and describe the change. Commit the generated file under `.changeset/`.

4. Open a PR against `main`. The `changesets/action` release workflow opens (or updates) a "Version Packages" PR from accumulated changesets; merging that PR publishes to npm.

## CI

`.github/workflows/ci.yml` runs lint, build, typecheck, and tests across a Node 22/24 matrix, plus a separate job that runs the Postgres conformance suite against a real `postgres:16` service container.
