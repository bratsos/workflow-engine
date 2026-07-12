---
sidebar_position: 1
title: Introduction
slug: /
---

# Introduction

**workflow-engine** is a type-safe, Postgres-native workflow engine specifically built for AI pipelines. It allows developers to define, run, and scale multi-stage workflows as a lightweight library directly inside their existing application database using Prisma, rather than managing a complex external stateful service.

---

## The Three Differentiators

Unlike general-purpose workflow orchestrators, **workflow-engine** is tailored specifically for the ergonomics and economics of modern AI applications:

### 1. Batch-API Economics with Suspend/Resume
AI LLM provider batch APIs (like OpenAI Batch or Google Batch) offer a **50% discount** compared to standard synchronous calls, but they run asynchronously and can take hours or days to complete. 
* **workflow-engine** natively supports workflow suspension and resumption. 
* When a stage triggers an LLM batch, the engine releases the execution lease and suspends the workflow.
* A background cron checks completion status and resumes the workflow where it left off, allowing you to build reliable, ultra-low-cost AI pipelines.

### 2. Provenance Annotations
AI pipelines need deep auditability—why was a decision made? Which agent made it? Which prompt version was used?
* The engine provides **provenance annotations** via `ctx.annotate()` out-of-the-box.
* These annotations are saved atomically as part of the stage-completion database transaction, ensuring durable, queryable records of every prompt, decision, and system trigger.

### 3. Library-Not-A-Service (Postgres-Native)
Most workflow engines (e.g., Temporal, Inngest, Prefect) require a dedicated, separate server cluster or a SaaS subscription.
* **workflow-engine** is a **pure library** running on your own PostgreSQL or SQLite database using Prisma.
* Your workflow state lives right alongside your application data. There are no additional server instances to provision, no network hops to external workflow clusters, and no specialized infrastructure to learn.

---

## When to Use vs. Alternatives

| Feature / Scenario | Temporal | Inngest | workflow-engine |
| :--- | :--- | :--- | :--- |
| **Architecture** | Heavy centralized server + workers | Event broker + HTTP handlers (SaaS) | **Postgres-native library + hosts** |
| **Hosting Model** | Self-hosted cluster or Temporal Cloud | Inngest Cloud / SaaS | **Direct npm library inside your app** |
| **Type Safety** | Runtime dependencies | JSON schemas | **End-to-end Zod TypeScript inference** |
| **AI Focus** | Generic orchestrator | Generic orchestrator | **Native token/cost tracking & Batch APIs** |
| **Best For** | Massive-scale, language-heterogeneous enterprise pipelines | Event-driven serverless architectures | **Type-safe Node/Edge AI workflows on Postgres** |
