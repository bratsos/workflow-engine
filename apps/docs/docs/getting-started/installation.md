---
sidebar_position: 2
title: Installation
---

# Installation

To install **workflow-engine** and its associated packages, ensure your project meets the requirements below.

## Requirements

* **Node.js** >= 22.11.0 (uses modern JavaScript features and runtime patterns)
* **TypeScript** >= 5.0.0 (for full type-inference support)
* **Zod** >= 4.0.0 (peer dependency used for type validation schemas)
* **PostgreSQL** >= 14 or **SQLite** (for Prisma persistence)

---

## Installing Packages

You can install the core engine along with the required peer dependency, `zod`.

### 1. Core Engine
Install `@bratsos/workflow-engine` and `zod`:

```bash
# Using npm
npm install @bratsos/workflow-engine zod

# Using pnpm
pnpm add @bratsos/workflow-engine zod

# Using yarn
yarn add @bratsos/workflow-engine zod
```

### 2. Choose Your Host Runtime
Install the host package that matches your operational environment:

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

---

## Optional Peer Dependencies

If your workflows leverage AI models with Anthropic or OpenAI, install the corresponding AI SDK provider packages:

```bash
# For Anthropic Claude (native or batch)
npm install @ai-sdk/anthropic

# For OpenAI Models (native or batch)
npm install @ai-sdk/openai

# For Prisma-based database persistence (recommended)
npm install @prisma/client
```

> **Note:** `@ai-sdk/google` is included as a direct dependency of `@bratsos/workflow-engine`. OpenRouter models and batch processing communicate via direct HTTP transport and require no additional SDK.
