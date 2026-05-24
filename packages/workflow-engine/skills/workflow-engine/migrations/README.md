---
name: workflow-engine-upgrade-router
description: Use when the user wants to upgrade @bratsos/workflow-engine in their project. Detects the installed version, identifies the prior version, and loads the relevant migration guides to walk the user through code/schema changes.
---

# @bratsos/workflow-engine upgrade router

This skill activates when a user says things like:
- "upgrade my project to the latest workflow-engine version"
- "I just bumped workflow-engine, walk me through the migration"
- "what do I need to change after upgrading workflow-engine?"

The router's job is to figure out **which migration guides to apply**, in order, given the version delta. The user should already have run their package manager's upgrade command before invoking this — if not, ask them to do that first or do it for them. See "Package manager reference" below for the right command per ecosystem.

## Step 0 — Detect the project layout

Before reading versions, figure out **what package manager** the project uses and **whether it's a monorepo**. This determines where to look in steps 1 and 2.

### Package manager — check in this order

| Signal | Manager |
|---|---|
| `pnpm-lock.yaml` exists | pnpm |
| `bun.lockb` or `bun.lock` exists | bun |
| `yarn.lock` exists AND `.yarnrc.yml` exists | yarn berry (v2+, may use PnP — no node_modules) |
| `yarn.lock` exists, no `.yarnrc.yml` | yarn classic (v1) |
| `package-lock.json` exists | npm |
| None of the above | ask the user; default to npm |

```bash
ls pnpm-lock.yaml bun.lockb bun.lock yarn.lock package-lock.json .yarnrc.yml 2>/dev/null
```

### Monorepo detection

```bash
# pnpm workspaces
cat pnpm-workspace.yaml 2>/dev/null

# npm / yarn workspaces (look for `workspaces` field in root package.json)
grep -A 5 '"workspaces"' package.json 2>/dev/null

# Turborepo / Nx (also signal "this is a monorepo")
ls turbo.json nx.json 2>/dev/null
```

If it's a monorepo, run `grep -rl '@bratsos/workflow-engine' --include=package.json` from the repo root to find every workspace that depends on the package. Migrations apply to each — but **schema migrations** (Prisma) only run once, against whichever workspace owns the database.

## Step 1 — Detect the currently installed version

The `version` field in the installed `package.json` is authoritative. Don't trust the root `package.json`'s declared range (`^0.7.0` etc.) — it tells you what's allowed, not what's resolved.

### By package manager

```bash
# pnpm — works in workspaces too; --filter scopes to a specific workspace
pnpm list @bratsos/workflow-engine --depth 0 --json

# pnpm in a specific workspace
pnpm --filter <workspace-name> list @bratsos/workflow-engine --depth 0 --json

# npm
npm list @bratsos/workflow-engine --depth 0 --json

# yarn classic
yarn list --pattern @bratsos/workflow-engine --depth 0

# yarn berry (works with PnP — no node_modules required)
yarn info @bratsos/workflow-engine --json | head -5

# bun
bun pm ls | grep '@bratsos/workflow-engine'
```

### Fallback: read `package.json` directly

```bash
# Standard (hoisted) install — pnpm, npm, yarn classic, bun
cat node_modules/@bratsos/workflow-engine/package.json | grep '"version"'

# pnpm non-hoisted / strict — package lives under each consumer
cat packages/<workspace>/node_modules/@bratsos/workflow-engine/package.json
```

### Yarn Berry with PnP

PnP setups have no `node_modules` directory. Use `yarn info` or read `.pnp.cjs`:

```bash
yarn info @bratsos/workflow-engine | grep version
# or, if yarn isn't available:
grep -A 2 '"@bratsos/workflow-engine' .pnp.cjs | head -5
```

### Can't find it?

Ask the user to run their package manager's install command:

| Manager | Install / refresh command |
|---|---|
| pnpm | `pnpm install` |
| npm | `npm install` |
| yarn classic | `yarn install` |
| yarn berry | `yarn install` |
| bun | `bun install` |

In monorepos, also confirm the user is in the right directory (root vs. a specific workspace).

## Step 2 — Detect the previous version

Three strategies, in order of preference. **Bun users**: skip strategy 1 if the lockfile is `bun.lockb` (binary) — go straight to strategy 2 or 3.

### Strategy 1 — Git diff on the lockfile (preferred)

Use the lockfile that matches the project's package manager:

```bash
# pnpm
git log -p -- pnpm-lock.yaml | grep -B 1 -A 2 "'@bratsos/workflow-engine" | head -30

# npm
git log -p -- package-lock.json | grep -B 1 -A 2 '"@bratsos/workflow-engine' | head -30

# yarn classic
git log -p -- yarn.lock | grep -B 1 -A 2 '"@bratsos/workflow-engine' | head -30

# yarn berry — same file as classic, different format
git log -p -- yarn.lock | grep -B 1 -A 4 '@bratsos/workflow-engine' | head -40

# bun text lockfile (bun.lock — newer versions)
git log -p -- bun.lock | grep -B 1 -A 2 '@bratsos/workflow-engine' | head -30

# bun binary lockfile (bun.lockb) — cannot grep; use Strategy 2
```

Look at the most recent commit touching the dependency. The `-` line is the previous version; the `+` line is the new one.

### Strategy 2 — Diff against the project root's `package.json`

Lockfile-agnostic; works even with `bun.lockb`:

```bash
git log -p -- package.json | grep '"@bratsos/workflow-engine' | head -10

# In a monorepo, also check the workspace package.json files
git log -p -- 'packages/*/package.json' | grep '"@bratsos/workflow-engine' | head -10
```

If the project's declared dep is a pinned version (e.g., `"0.7.0"`), this gives you the previous pin directly. If it's a range (`"^0.7.0"`), the range itself may not have changed across the upgrade — fall back to Strategy 3.

### Strategy 3 — Check the working tree before commit

If the upgrade hasn't been committed yet, both versions may still be visible in the unstaged diff:

```bash
git diff HEAD -- pnpm-lock.yaml package-lock.json yarn.lock bun.lock package.json
```

### Strategy 4 — Ask the user

Last resort: "Before the upgrade, what version of `@bratsos/workflow-engine` were you on?" — quoting the installed version (from Step 1) helps frame the question.

If the previous version is older than 0.7.0, warn the user that some migration guides may not exist yet (we only started writing them at 0.7→0.8).

## Step 3 — List available migrations

Look in the installed package's skill directory:

```
node_modules/@bratsos/workflow-engine/skills/workflow-engine/migrations/
```

Files are named `migrate-X.Y-to-A.B.md` (semver-tagged). Each one is a self-contained guide for one version step.

## Step 4 — Build the ordered migration chain

If the user upgraded `0.6.0 → 0.8.0`, you need to apply migrations in order:
1. `migrate-0.6-to-0.7.md`
2. `migrate-0.7-to-0.8.md`

Sort migration files by their source version (the `X.Y` part), filter to those whose source version is `>= previousVersion` and target version is `<= installedVersion`. Apply in ascending order.

### Skipping over patch releases

We only ship migration guides at minor/major version bumps. If the user went `0.7.3 → 0.7.5`, there's nothing to migrate — that's a patch release and no schema/API changes apply. Confirm with the user that they don't see breaking behavior; otherwise, refer them to the changelog.

## Step 5 — Walk through each migration

For each migration file, in order:

1. Read the full migration doc.
2. Surface the **Required actions** section to the user — these are non-optional.
3. Apply schema changes if the migration includes them (Prisma migrations, etc.) — confirm with the user before running `prisma migrate dev` or equivalent.
4. Apply code changes — usually with grep + edit, occasionally manual review.
5. Note any **Deprecations** — these don't break the current version but the user should plan to address them.
6. Verify by running the project's tests if available.

### Monorepo: applying code changes across workspaces

If you detected a monorepo in Step 0 and multiple workspaces depend on `@bratsos/workflow-engine`, the **code** changes apply to each of them. Use grep at the repo root to find all call sites:

```bash
grep -rln 'workflow-engine' --include='*.ts' --include='*.tsx' --include='*.js' \
  packages/ apps/ src/ 2>/dev/null
```

Apply the migration's recommended edits per workspace. Run typecheck per workspace if the project supports it:

```bash
pnpm -r typecheck       # all workspaces
pnpm --filter <ws> typecheck   # one workspace
```

**Schema migrations are different.** Prisma migrations live with the workspace that owns the database — usually one specific package. Run `prisma migrate dev` only in that workspace.

## Step 6 — Final check

After all migrations applied, run typecheck and the test suite. Use the project's package manager:

| Manager | Typecheck | Test |
|---|---|---|
| pnpm | `pnpm typecheck` (or `pnpm -r typecheck` in a monorepo) | `pnpm test` (or `pnpm -r test`) |
| npm | `npm run typecheck` | `npm test` |
| yarn classic | `yarn typecheck` | `yarn test` |
| yarn berry | `yarn typecheck` | `yarn test` |
| bun | `bun run typecheck` | `bun test` |

If the project doesn't define these scripts, fall back to `npx tsc --noEmit` for typecheck. Surface any **Bug fixes** sections from the migration docs — these describe behavior changes the user may want to verify against.

## Package manager reference — upgrade commands

If the user hasn't run the upgrade yet, run it for them:

| Manager | Upgrade to latest published version |
|---|---|
| pnpm | `pnpm update @bratsos/workflow-engine --latest` |
| npm | `npm install @bratsos/workflow-engine@latest` |
| yarn classic | `yarn upgrade @bratsos/workflow-engine --latest` |
| yarn berry | `yarn up @bratsos/workflow-engine` |
| bun | `bun update @bratsos/workflow-engine --latest` |

In a monorepo, if the package is a dependency of multiple workspaces, the upgrade typically updates all of them at once for pnpm/yarn/npm workspaces. Bun: confirm by re-running Step 1 against each workspace afterward.

## Convention for writing new migration docs

Each `migrate-X.Y-to-A.B.md` file uses this structure:

```markdown
# Migrating from X.Y to A.B

## Summary
One paragraph: what changed and why.

## Required actions
Checklist of non-optional steps. Schema migrations, breaking API changes.

## New features
What's available that wasn't before. Optional to adopt.

## Deprecations
What's marked deprecated. Still works in this version, removed in a later one.

## Bug fixes
Behavior changes the user might notice. Not breaking, but worth knowing.

## Code examples
Before/after snippets for the most common patterns.
```

## Maintainer note

When publishing a new minor/major version of `@bratsos/workflow-engine`:
1. Write `migrations/migrate-PREV-to-CURRENT.md` before tagging the release.
2. Bundle the whole `migrations/` directory in the published npm package — consumers need the full history to walk multi-version upgrades.
3. Update this router doc if the convention changes.
