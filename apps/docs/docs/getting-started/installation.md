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
* **PostgreSQL** >= 14 or **SQLite** (for Prisma persistence)

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
Install the host package that matches your operational environment. The host packages are versioned independently of the engine and are not on the `alpha` tag; each release depends on the engine release it was built against:

* **Node.js Host** (for long-running daemon workers):
  ```bash
  npm install @bratsos/workflow-engine-host-node
  ```
* **Serverless Host** (for Cloudflare Workers, AWS Lambda, Vercel Edge, etc.):
  ```bash
  npm install @bratsos/workflow-engine-host-serverless
  ```
* **Remote Host** (for credential-free remote execution environments):
  ```bash
  npm install @bratsos/workflow-engine-host-remote
  ```

### 3. Optional: the operational console
`@bratsos/workflow-engine-console` is an embeddable run console — a `(Request) => Promise<Response>` handler plus a prebuilt UI. Nothing in the engine depends on it; see [The embeddable console](../console/overview.md).

```bash
npm install @bratsos/workflow-engine-console
```

---

## Optional Peer Dependencies

If your workflows leverage AI models with Anthropic or OpenAI, install the corresponding AI SDK provider packages:

```bash
# For Anthropic Claude (native or batch)
npm install @ai-sdk/anthropic

# For OpenAI Models (native or batch)
npm install @ai-sdk/openai

# For Prisma-based database persistence (recommended); Prisma 6 or 7
npm install @prisma/client
```

> **Note:** `@ai-sdk/google` and `@openrouter/ai-sdk-provider` are direct dependencies of `@bratsos/workflow-engine`; OpenRouter's Batch API is called over plain HTTP and needs no additional SDK. The Prisma adapters never import `@prisma/client` themselves — you pass them the client you generated, so Prisma 7's `prisma-client` generator with a custom `output` works unchanged. The engine also ships its reference schema at `node_modules/@bratsos/workflow-engine/prisma/schema.prisma`; see [Prisma Setup](../persistence/prisma-setup.md).
