import { defineStage, WorkflowBuilder } from "@bratsos/workflow-engine";
import { createKernel } from "@bratsos/workflow-engine/kernel";
import { CollectingEventSink, FakeClock, NoopScheduler } from "@bratsos/workflow-engine/kernel/testing";
import { InMemoryJobQueue, InMemoryWorkflowPersistence } from "@bratsos/workflow-engine/testing";
import { z } from "zod";
import type { InMemoryObjectStore } from "../object-store.js";
import { defineRemoteStage } from "../orchestrator/define-remote-stage.js";
import type { OrchestratorTransport } from "../transport.js";

// A "heavy" stage: writes a large artifact to scoped storage, returns its KEY in output.
export const heavyStage = defineStage({
  id: "heavy",
  name: "Heavy",
  schemas: {
    input: z.object({ seed: z.number() }),
    output: z.object({ artifactKey: z.string(), size: z.number() }),
    config: z.object({}),
  },
  async execute(ctx) {
    const key = ctx.storage.getStageKey("heavy", "blob.json");
    const payload = { data: new Array(ctx.input.seed).fill("x") };
    await ctx.storage.save(key, payload);
    return { output: { artifactKey: key, size: payload.data.length } };
  },
});

// A core (trusted) stage: reads the upstream key from workflowContext, loads the blob via blobStore.
export function makeCoreStage(blobStore: { get(key: string): Promise<unknown> }) {
  return defineStage({
    id: "core",
    name: "Core",
    schemas: {
      input: z.object({ artifactKey: z.string(), size: z.number() }),
      output: z.object({ doubled: z.number() }),
      config: z.object({}),
    },
    async execute(ctx) {
      const blob = (await blobStore.get(ctx.input.artifactKey)) as { data: unknown[] };
      return { output: { doubled: blob.data.length * 2 } };
    },
  });
}

export interface Orchestrator {
  kernel: ReturnType<typeof createKernel>;
  persistence: InMemoryWorkflowPersistence;
  jobQueue: InMemoryJobQueue;
  clock: FakeClock;
  workflowId: string;
}

export function buildOrchestrator(transport: OrchestratorTransport, objectStore: InMemoryObjectStore): Orchestrator {
  const persistence = new InMemoryWorkflowPersistence();
  const jobQueue = new InMemoryJobQueue();
  const clock = new FakeClock(new Date(0));
  const coreStage = makeCoreStage(objectStore);

  const workflow = new WorkflowBuilder(
    "media",
    "Media",
    "remote heavy + core",
    z.object({ seed: z.number() }),
    z.object({ doubled: z.number() }),
  )
    .pipe(defineRemoteStage(heavyStage, transport, { pollIntervalMs: 100, maxWaitMs: 60_000 }))
    .pipe(coreStage)
    .build();

  const kernel = createKernel({
    persistence,
    blobStore: objectStore, // same instance the worker writes to
    jobTransport: jobQueue,
    eventSink: new CollectingEventSink(),
    scheduler: new NoopScheduler(),
    clock,
    registry: { getWorkflow: (id: string) => (id === "media" ? workflow : undefined) },
  });

  return { kernel, persistence, jobQueue, clock, workflowId: "media" };
}
