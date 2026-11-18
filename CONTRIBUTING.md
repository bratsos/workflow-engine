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
`packages/workflow-engine/src/__tests__/12-persistence-adapters/`, plus
`src/__tests__/sqlite8-kernel-{post-commit,concurrency,transaction-reads}.test.ts`) are skipped
unless `DATABASE_URL` is set. They share one database and each truncates the
tables between cases, so `test:pg` runs them with `--no-file-parallelism`; run
any new Postgres-backed file through that script rather than on its own, or the
suites will delete each other's rows and fail in ways that look like adapter
bugs. `test:pg` and `test:sqlite` run with `--hookTimeout=30000` (the Vitest default is 10 s): every case resets the database in a `beforeEach`, and on a shared CI runner that reset has been seen to stall past 10 s. The console's database suites run with the same flags; their heaviest hooks and tests (the SQLite `beforeAll` that generates and pushes the schema, the Postgres reset and the query-plan test) carry longer timeouts of their own. To run them locally:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/workflow_engine_test
export PRISMA_MAJOR=6   # the Prisma major to test: 6, 7 or 8 (default 7); the fixtures live in packages/prisma-fixtures
pnpm --filter @bratsos/workflow-engine run prisma:generate
pnpm --filter @bratsos/workflow-engine run prisma:db-push
pnpm --filter @bratsos/workflow-engine run test:pg
pnpm --filter @bratsos/workflow-engine-host-node exec vitest run src/__tests__/outbox-prisma.test.ts
pnpm --filter @bratsos/workflow-engine-host-serverless exec vitest run src/__tests__/outbox-prisma.test.ts
pnpm --filter @bratsos/workflow-engine-console exec node scripts/build-ui.mjs   # cli.test.ts needs the built UI bundle
pnpm --filter @bratsos/workflow-engine-console exec vitest run --hookTimeout=30000 --testTimeout=30000 src/__tests__/prisma-read-port.postgres.test.ts src/__tests__/cli.test.ts
```

`stats-query-plans.test.ts` (part of `test:pg`) builds its own planner-statistics states, so the role in `DATABASE_URL` must own the engine tables (the role that ran `prisma:db-push` does) and be allowed to delete from `pg_statistic`, which takes a superuser: it runs `ALTER TABLE ... SET (autovacuum_enabled)` and `DELETE FROM pg_statistic` on `workflow_runs`, `workflow_stages`, `job_queue` and `outbox_events`. The `postgres` role of the CI service container and of the local command above is both. As an ordinary non-owner role the file fails with `must be owner of table workflow_runs`.

SQLite conformance uses a temporary real file and does not need `DATABASE_URL`.
Its fixture helpers generate or emit the matching contract and initialise the
file. Set `SQLITE8_KERNEL_SQLITE=1` to include the kernel suites. Build the
engine before the console suite because its Prisma 8 case loads `fromPrisma8`
from the package entry point, and generate the console UI bundle before test
collection. Run it for each Prisma major on Node 24, matching the default rows of the SQLite CI job:

```bash
export SQLITE8_KERNEL_SQLITE=1
PRISMA_MAJOR=6 pnpm --filter @bratsos/workflow-engine run test:sqlite
PRISMA_MAJOR=7 pnpm --filter @bratsos/workflow-engine run test:sqlite
PRISMA_MAJOR=8 pnpm --filter @bratsos/workflow-engine run test:sqlite
pnpm --filter @bratsos/workflow-engine run build
pnpm --filter @bratsos/workflow-engine-console exec node scripts/build-ui.mjs
PRISMA_MAJOR=6 pnpm --filter @bratsos/workflow-engine-console exec vitest run --hookTimeout=30000 --testTimeout=30000 src/__tests__/prisma-read-port.sqlite.test.ts
PRISMA_MAJOR=7 pnpm --filter @bratsos/workflow-engine-console exec vitest run --hookTimeout=30000 --testTimeout=30000 src/__tests__/prisma-read-port.sqlite.test.ts
PRISMA_MAJOR=8 pnpm --filter @bratsos/workflow-engine-console exec vitest run --hookTimeout=30000 --testTimeout=30000 src/__tests__/prisma-read-port.sqlite.test.ts
PRISMA_MAJOR=6 pnpm --filter @bratsos/workflow-engine-host-node exec vitest run src/__tests__/outbox-prisma.test.ts
PRISMA_MAJOR=7 pnpm --filter @bratsos/workflow-engine-host-node exec vitest run src/__tests__/outbox-prisma.test.ts
PRISMA_MAJOR=8 pnpm --filter @bratsos/workflow-engine-host-node exec vitest run src/__tests__/outbox-prisma.test.ts
PRISMA_MAJOR=6 pnpm --filter @bratsos/workflow-engine-host-serverless exec vitest run src/__tests__/outbox-prisma.test.ts
PRISMA_MAJOR=7 pnpm --filter @bratsos/workflow-engine-host-serverless exec vitest run src/__tests__/outbox-prisma.test.ts
PRISMA_MAJOR=8 pnpm --filter @bratsos/workflow-engine-host-serverless exec vitest run src/__tests__/outbox-prisma.test.ts
```

The `sqlite-conformance` job runs those commands for each Prisma major on Node 24,
and on floor rows: Prisma 6 and 7 on 22.12.0, and Prisma 8 on 22.20.0, 24.11.0
and 26.0.0, the lowest releases the docs claim for its SQLite target. The floor
rows exist because Prisma 8 SQLite runs on Node's experimental `node:sqlite`,
which differs between releases (boolean binds, reading text that holds a NUL,
and a required flag before 22.13), so a claimed floor that CI never runs is a
guess. Node 22.11.0, the engine's general floor, has no row: the workspace's
Prisma 7 dev dependency (`prisma@7.10.1`) fails its install below 22.12. To
reproduce a row, switch to that Node (for example `fnm use 22.20.0`), run
`pnpm install` again so Prisma 7's `better-sqlite3` binary matches that Node
major, and run the commands above with the row's `PRISMA_MAJOR`.

### Stored-row compatibility fixtures

The gated `test:sqlite` and `test:pg` suites load committed snapshots from
`packages/workflow-engine/src/__tests__/stored-rows/snapshots/` through the
current Prisma client. They compare every table's column set and each JSON
column's key paths and value types with the newest snapshot. IDs, timestamps,
and other values do not participate in the shape comparison. A shape change
fails with the changed table or JSON path and the capture command.

To add a snapshot after an intentional storage-shape change, provision the
current schema for the selected database, then run. The Postgres database must
be disposable because capture clears its engine tables.

```bash
# PostgreSQL: pass DATABASE_URL inline.
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/workflow_engine_test \
  PRISMA_MAJOR=7 pnpm --filter @bratsos/workflow-engine run capture:stored-rows

# SQLite: the capture script creates a temporary database and current schema.
SQLITE8_KERNEL_SQLITE=1 PRISMA_MAJOR=7 \
  pnpm --filter @bratsos/workflow-engine run capture:stored-rows
```

Commit the generated JSON files with the change. Do not edit captured rows by
hand. Historical snapshots must be captured by the release named in their
metadata; new snapshots record their capture time, and older snapshots derive
it from the newest lifecycle timestamp in their rows. Replays use that time
for the kernel clock so durable waits are tested at the point they were
captured.

After a release, create an isolated worktree at the package release tag and
capture the canonical `<version>` snapshot from that build. Set
`STORED_ROWS_SNAPSHOT_LABEL=<version>` to select the released label explicitly;
the capture refuses to overwrite any existing snapshot path whose label has a
release tag. In the same change, commit the new `<version>` directory and
delete the preceding `<version>+next` directory.

```bash
VERSION=1.0.0-alpha.21
git worktree add --detach .lane/release-capture "@bratsos/workflow-engine@$VERSION"
cd .lane/release-capture
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/workflow_engine_test \
  PRISMA_MAJOR=7 STORED_ROWS_SNAPSHOT_LABEL="$VERSION" \
  pnpm --filter @bratsos/workflow-engine run capture:stored-rows
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

`.github/workflows/ci.yml` runs lint, build, typecheck, and tests across a Node 22/24 matrix, plus a separate job that runs the Postgres conformance suite against a real `postgres:16` service container, and a `sqlite-conformance` job that runs the SQLite suites against a real file for each Prisma major (Node 24, plus the floor rows described under SQLite conformance above).
