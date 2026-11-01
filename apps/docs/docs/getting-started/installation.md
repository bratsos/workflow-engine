---
sidebar_position: 2
title: Installation
---

# Installation

To install **workflow-engine** and its associated packages, ensure your project meets the requirements below.

## Requirements

* **Node.js** >= 22.11.0 (uses modern JavaScript features and runtime patterns)
* **TypeScript** >= 5.0.0 (for full type-inference support)
* **Zod** ^4.1 (peer dependency used for type validation schemas)
* **PostgreSQL** >= 14, or **SQLite** for Prisma persistence on Prisma 6, 7 and 8
* **Prisma 7** needs Node.js 22.12+ or 24+ with this engine (Prisma 7 rejects Node 23)
* **Prisma 8** additionally needs an ES module project (`"type": "module"`) and TypeScript >= 5.9. PostgreSQL uses Node.js 22.18+, 24.11+ or 26+ and requires PostgreSQL >= 15; SQLite uses Node.js 22.20+, 24.11+ or 26+.

---

## Installing Packages

These pages describe **1.0**, which is published under the npm `alpha` dist-tag as `1.0.0-alpha.x`. A bare `npm install @bratsos/workflow-engine` resolves the `latest` tag, which is still the 0.13 line, so name the tag explicitly. Upgrading from 0.13? Read [Migrating from 0.13 to 1.0](../migrations/migrate-0.13-to-1.0.md) first.

### 1. Core Engine
Install `@bratsos/workflow-engine` and `zod`:

```bash
# Using npm
npm install @bratsos/workflow-engine@alpha zod

# Using pnpm
pnpm add @bratsos/workflow-engine@alpha zod

# Using yarn
yarn add @bratsos/workflow-engine@alpha zod
```

### 2. Choose Your Host Runtime
Install the host package that matches your operational environment. The host packages are versioned independently of the engine and have their own `alpha` tag; each release depends on the engine release it was built against. Name the tag: a bare install resolves `latest`, which is still a 0.x host, and brings a second, 0.13 copy of the engine next to yours.

* **Node.js Host** (for long-running daemon workers):
  ```bash
  npm install @bratsos/workflow-engine-host-node@alpha
  ```
* **Serverless Host** (for Cloudflare Workers, AWS Lambda, Vercel Edge, etc.):
  ```bash
  npm install @bratsos/workflow-engine-host-serverless@alpha
  ```
* **Remote Host** (for credential-free remote execution environments):
  ```bash
  npm install @bratsos/workflow-engine-host-remote@alpha
  ```

### 3. Optional: the operational console
`@bratsos/workflow-engine-console` is an embeddable run console — a `(Request) => Promise<Response>` handler plus a prebuilt UI. Nothing in the engine depends on it; see [The embeddable console](../console/overview.md).

```bash
npm install @bratsos/workflow-engine-console
```

Unlike the packages above, the console is installed **without** `@alpha`: its `latest` tag is the current 1.0 alpha, and its `alpha` tag is an old version that does not install (`EUNSUPPORTEDPROTOCOL`). Its version must match the engine's alpha exactly, because it peers on that one version; with `@bratsos/workflow-engine@alpha` installed they match, and a different engine alpha fails with `ERESOLVE`.

---

## Module Format and Bundlers

* **ES modules.** All five packages are ES modules (`"type": "module"`) with `import` conditions only. From a CommonJS project, `require()` of them works on Node.js 22.18, 24.22 and 26.13 (the versions tested) and fails with `ERR_REQUIRE_ESM` on 22.11.0.
* **TypeScript in a CommonJS project.** `moduleResolution: "node10"` cannot resolve the `/kernel` and `/persistence/prisma` entry points (TS2307), and `node16` rejects a CommonJS file that imports them (TS1479). Use `nodenext` for `module` and `moduleResolution`, with TypeScript 5.9+. ES module projects work with `bundler` or `nodenext`.
* **Bundlers.** The engine loads `@ai-sdk/openai` and `@ai-sdk/anthropic` lazily with `import()`, so a bundler that bundles the engine has to resolve both. Without them esbuild stops with `Could not resolve "@ai-sdk/openai"` and a Next.js 16 build with `Module not found: Can't resolve '@ai-sdk/openai'`. Install both packages, or keep the engine out of the bundle: `serverExternalPackages` in Next.js, `--external:@ai-sdk/openai --external:@ai-sdk/anthropic` in esbuild.

---

## Optional Peer Dependencies

If your workflows leverage AI models with Anthropic or OpenAI, install the corresponding AI SDK provider packages:

```bash
# For Anthropic Claude (native or batch)
npm install @ai-sdk/anthropic

# For OpenAI Models (native or batch)
npm install @ai-sdk/openai

# For Prisma-based database persistence (recommended): Prisma 7 is the default path
npm install @prisma/client@7 @prisma/adapter-pg@7
npm install -D prisma@7
```

The engine supports Prisma 6, 7 and 8. Install `prisma` as a local dependency: `npx prisma` without a local install runs Prisma 8, so a Prisma 6 or 7 project that skips it runs the wrong major.

**Prisma 6** takes the same commands with `@6` and no adapter. It receives only security patches until 2026-11-19 (Prisma's [release status](https://www.prisma.io/docs/orm/release-status)), so start new projects on 7.

```bash
npm install @prisma/client@6
npm install -D prisma@6
```

For SQLite on Prisma 6 or 7, changing only `provider` is not enough: use the full shipped-schema conversion, Prisma 6's `connection_limit=1`, or Prisma 7's `@prisma/adapter-better-sqlite3`. Follow the [clean-room SQLite setup](../persistence/prisma-setup.md#2-sqlite-setup-prisma-6-7-and-8).

**Prisma 8** is a release candidate with its own short path. Pin `prisma@8.0.0-rc.29` with the matching target package: `@prisma/orm-postgres@8.0.0-rc.21` or `@prisma/orm-sqlite@8.0.0-rc.21`. There is no `@prisma/client` on Prisma 8. The Postgres target needs Node.js 22.18+, 24.11+ or 26+, TypeScript 5.9+ and PostgreSQL 15+.

```bash
npm install --save-exact @prisma/orm-postgres@8.0.0-rc.21
npm install --save-dev --save-exact prisma@8.0.0-rc.29
npm install temporal-polyfill   # a peer of @prisma/orm-postgres; yarn classic and pnpm without auto-install-peers skip it
```

For SQLite, install `@prisma/orm-sqlite@8.0.0-rc.21` instead of `@prisma/orm-postgres`; `temporal-polyfill` is not part of that SQLite install path. Follow [Prisma 8 SQLite setup](../persistence/prisma-setup.md#2-sqlite-setup-prisma-6-7-and-8) for the ESM project, SQLite contract, database file and client. Wrap either target with `fromPrisma8(db)`; SQLite-aware adapters take `{ databaseType: "sqlite" }`.

> **Note:** `@ai-sdk/google` and `@openrouter/ai-sdk-provider` are direct dependencies of `@bratsos/workflow-engine`; OpenRouter's Batch API is called over plain HTTP and needs no additional SDK. The Prisma adapters never import `@prisma/client` themselves — you pass them the client you generated, so Prisma 7's `prisma-client` generator with a custom `output` works unchanged. The engine also ships its reference schema at `node_modules/@bratsos/workflow-engine/prisma/schema.prisma` (Prisma 6 and 7) and its Prisma 8 contract at `node_modules/@bratsos/workflow-engine/prisma/contract.prisma`; see [Prisma Setup](../persistence/prisma-setup.md).
