---
sidebar_position: 1
title: Overview
---

# Migrations Overview

This section contains step-by-step upgrade and migration guides for `@bratsos/workflow-engine` packages.

---

## Upgrade Process

When upgrading the packages, follow this process to check for breaking changes, database schema updates, or API refactors:

### Step 1: Detect Your Version Delta
Compare your currently installed version (check `package.json` in your node modules or use `npm list @bratsos/workflow-engine`) with the target upgrade version.
* Migration guides are published for **minor and major version bumps** (e.g. `0.7` to `0.8`, `0.13` to `1.0`).
* Patch releases (e.g. `0.10.1` to `0.10.2`) only contain bug fixes and do not require code changes or database migrations.
* The 1.0 alphas are one guide: `1.0.0-alpha.x` → `1.0.0-alpha.y` upgrades are covered by the database checklist in the 0.13 → 1.0 guide, which is kept current with every alpha (each statement is idempotent, so re-running it is safe).
* `npx workflow-engine-codemod --from <version>` flags the removed APIs in your code with a pointer to the relevant guide.

### Step 2: Build the Ordered Migration Chain
If you are upgrading across multiple minor versions (e.g., `0.7.0` to `0.10.0`), you must apply the migration guides **sequentially**:
1. Apply the `0.7` to `0.8` migration (run database schema updates, change deprecated code).
2. Apply the `0.8` to `0.9` migration.
3. Apply the `0.9` to `0.10` migration.

### Step 3: Run Database Migrations
If a version bump introduces a database schema change (like adding a table or modifying columns):
1. Update your `prisma/schema.prisma` file with the new models.
2. Generate and apply the migration locally:
   ```bash
   npx prisma migrate dev --name upgrade-workflow-engine
   ```
3. Regenerate the client:
   ```bash
   npx prisma generate
   ```

---

## Available Migration Guides

Follow the guides below to migrate your code:

* [Migrating from 0.13 to 1.0](./migrate-0.13-to-1.0.md) (Latest — the `1.0.0-alpha.x` line, installed with the `@alpha` tag)
* [Migrating from 0.12 to 0.13](./migrate-0.12-to-0.13.md)
* [Migrating from 0.11 to 0.12](./migrate-0.11-to-0.12.md)
* [Migrating from 0.10 to 0.11](./migrate-0.10-to-0.11.md)
* [Migrating from 0.9 to 0.10](./migrate-0.9-to-0.10.md)
* [Migrating from 0.8 to 0.9](./migrate-0.8-to-0.9.md)
* [Migrating from 0.7 to 0.8](./migrate-0.7-to-0.8.md)
