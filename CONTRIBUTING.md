# Contributing

## Setup

```bash
pnpm install
```

Requires Node.js >= 22.11 and pnpm (see `packageManager` in `package.json` for the exact version). Prisma 8 SQLite needs the target-specific Node floor listed in [Prisma Setup](apps/docs/docs/persistence/prisma-setup.md#2-sqlite-setup-prisma-6-7-and-8); the engine's general Node engine remains 22.11.

## Everyday commands

```bash
pnpm verify          # lint + typecheck + test + build (what CI runs)
pnpm build       # build all packages
pnpm test        # test all packages
pnpm typecheck   # typecheck all packages
pnpm lint        # biome check
pnpm lint:fix     # biome check --write
```

Postgres-backed persistence tests (`prisma-postgres-conformance.test.ts`,
`sql-enqueue.test.ts` and, on Prisma 8 only, `from-prisma8.test.ts`, all under
`packages/workflow-engine/src/__tests__/12-persistence-adapters/`) are skipped
unless `DATABASE_URL` is set. They share one database and each truncates the
tables between cases, so `test:pg` runs them with `--no-file-parallelism`; run
any new Postgres-backed file through that script rather than on its own, or the
suites will delete each other's rows and fail in ways that look like adapter
bugs. To run them locally:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/workflow_engine_test
export PRISMA_MAJOR=6   # the Prisma major to test: 6, 7 or 8 (default 7); the fixtures live in packages/prisma-fixtures
pnpm --filter @bratsos/workflow-engine run prisma:generate
pnpm --filter @bratsos/workflow-engine run prisma:db-push
pnpm --filter @bratsos/workflow-engine run test:pg
pnpm --filter @bratsos/workflow-engine-console exec node scripts/build-ui.mjs   # cli.test.ts needs the built UI bundle
pnpm --filter @bratsos/workflow-engine-console exec vitest run src/__tests__/prisma-read-port.postgres.test.ts src/__tests__/cli.test.ts
```

SQLite conformance uses a temporary real file and does not need `DATABASE_URL`.
Its fixture helpers generate or emit the matching contract and initialise the
file. Build the engine before the console suite because its Prisma 8 case loads
`fromPrisma8` from the package entry point. Run it for each Prisma major:

```bash
PRISMA_MAJOR=6 pnpm --filter @bratsos/workflow-engine run test:sqlite
PRISMA_MAJOR=7 pnpm --filter @bratsos/workflow-engine run test:sqlite
PRISMA_MAJOR=8 pnpm --filter @bratsos/workflow-engine run test:sqlite
pnpm --filter @bratsos/workflow-engine run build
PRISMA_MAJOR=6 pnpm --filter @bratsos/workflow-engine-console exec vitest run src/__tests__/prisma-read-port.sqlite.test.ts
PRISMA_MAJOR=7 pnpm --filter @bratsos/workflow-engine-console exec vitest run src/__tests__/prisma-read-port.sqlite.test.ts
PRISMA_MAJOR=8 pnpm --filter @bratsos/workflow-engine-console exec vitest run src/__tests__/prisma-read-port.sqlite.test.ts
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
