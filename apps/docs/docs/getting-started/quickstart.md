---
sidebar_position: 3
title: Quickstart
---

# Quickstart

This guide walks you through setting up and running a complete type-safe workflow using a Node.js worker and Prisma persistence.

---

## 1. Define Your Stages

Stages are the building blocks of workflows. They specify their input, output, and config shapes using Zod.

```typescript
// stages.ts
import { defineStage } from "@bratsos/workflow-engine";
import { z } from "zod";

// Stage 1: Extraction stage
export const extractTextStage = defineStage({
  id: "extract-text",
  name: "Extract Text",
  schemas: {
    input: z.object({ url: z.string().url() }),
    output: z.object({ text: z.string(), wordCount: z.number() }),
    config: z.object({ maxLength: z.number().default(50000) }),
  },
  async execute(ctx) {
    const response = await fetch(ctx.input.url);
    const text = (await response.text()).slice(0, ctx.config.maxLength);
    
    await ctx.log("INFO", "Extraction complete", { length: text.length });
    
    return {
      output: { 
        text, 
        wordCount: text.split(/\s+/).length 
      },
    };
  },
});

// Stage 2: Processing stage
export const analyzeSentimentStage = defineStage({
  id: "analyze-sentiment",
  name: "Analyze Sentiment",
  schemas: {
    input: "none", // Input is read directly from workflowContext
    output: z.object({ sentiment: z.enum(["positive", "negative", "neutral"]) }),
    config: z.object({ scoreThreshold: z.number().default(0.5) }),
  },
  async execute(ctx) {
    // Access the output of extractTextStage in a type-safe way
    const extracted = ctx.require("extract-text");
    
    // Simulate sentiment analysis
    const hasHappyWords = extracted.text.toLowerCase().includes("happy") || extracted.text.toLowerCase().includes("great");
    const sentiment = hasHappyWords ? "positive" : "neutral";

    return {
      output: { sentiment },
    };
  },
});
```

---

## 2. Build Your Workflow

Workflows chain stages together in sequence or parallel using `defineWorkflow`.

```typescript
// workflow.ts
import { defineWorkflow } from "@bratsos/workflow-engine";
import { z } from "zod";
import { extractTextStage, analyzeSentimentStage } from "./stages";

export const documentAnalysisWorkflow = defineWorkflow({
  id: "document-analysis",
  name: "Document Analysis Pipeline",
  description: "Analyzes sentiment of text extracted from a URL",
  input: z.object({ url: z.string().url() }),
})
  .pipe(extractTextStage)
  .pipe(analyzeSentimentStage)
  .build();
```

---

## 3. Initialize the Kernel and Host

The **Kernel** manages the command dispatch loop, database interactions, and state machine. The **Host** polls for and executes jobs.

```typescript
// index.ts
import { createKernel } from "@bratsos/workflow-engine/kernel";
import { createNodeHost } from "@bratsos/workflow-engine-host-node";
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
} from "@bratsos/workflow-engine/persistence/prisma";
import { PrismaClient } from "@prisma/client";
import { documentAnalysisWorkflow } from "./workflow";
import { InMemoryBlobStore, CollectingEventSink } from "@bratsos/workflow-engine/kernel/testing";
import crypto from "crypto";

const prisma = new PrismaClient();

// 1. Setup the pure command kernel
const kernel = createKernel({
  persistence: createPrismaWorkflowPersistence(prisma),
  blobStore: new InMemoryBlobStore(), // Or use S3/GCS adapters in production
  jobTransport: createPrismaJobQueue(prisma),
  eventSink: new CollectingEventSink(),
  clock: { now: () => new Date() },
  registry: {
    getWorkflow: (id) => (id === "document-analysis" ? documentAnalysisWorkflow : undefined),
  },
});

// 2. Wrap it with a Node.js Host process
const host = createNodeHost({
  kernel,
  jobTransport: createPrismaJobQueue(prisma),
  workerId: "worker-1",
});

async function main() {
  // Start the background polling loops
  await host.start();
  console.log("Worker host started successfully.");

  // 3. Dispatch a new workflow run command
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: crypto.randomUUID(),
    workflowId: "document-analysis",
    input: { url: "https://example.com" },
  });

  console.log(`Workflow dispatched: Run ID ${workflowRunId}`);
}

main().catch(console.error);
```
