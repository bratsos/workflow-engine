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

If your workflows leverage AI models, you should install the SDKs of the providers you plan to use:

```bash
# For Google Gemini
npm install @google/genai

# For OpenAI Models
npm install openai

# For Anthropic Claude
npm install @anthropic-ai/sdk

# For Prisma-based database persistence (recommended)
npm install @prisma/client
```
