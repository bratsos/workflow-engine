/**
 * Kernel Tests: engine.stats command
 *
 * The command reads active work through the optional
 * `Persistence.getActiveWorkStats` and `JobTransport.getJobStats` methods and
 * turns timestamps into ages on the kernel clock. A port without its method
 * reports its sections as unavailable instead of failing.
 */

import { describe, expect, it } from "vitest";
import { createKernel } from "../../kernel/kernel.js";
import type { JobTransport, Persistence } from "../../kernel/ports.js";
import { createSpillingJobTransport } from "../../kernel/spill.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
} from "../../kernel/testing/index.js";
import {
  InMemoryJobQueue,
  InMemoryWorkflowPersistence,
} from "../../testing/index.js";

function setup(
  overrides: {
    persistence?: (p: InMemoryWorkflowPersistence) => Persistence;
    jobTransport?: (q: InMemoryJobQueue) => JobTransport;
  } = {},
) {
  const clock = new FakeClock();
  const now = () => clock.now();
  const persistence = new InMemoryWorkflowPersistence({ now });
  const jobQueue = new InMemoryJobQueue({ workerId: "stats-worker", now });
  const kernel = createKernel({
    persistence: overrides.persistence?.(persistence) ?? persistence,
    jobTransport: overrides.jobTransport?.(jobQueue) ?? jobQueue,
    blobStore: new InMemoryBlobStore(),
    eventSink: new CollectingEventSink(),
    clock,
    registry: { getWorkflow: () => undefined },
  });
  return { kernel, clock, persistence, jobQueue };
}

/** The same port with one optional method hidden, as a custom adapter without it would be. */
function without<T extends object>(port: T, method: keyof T): T {
  return Object.assign(Object.create(port), { [method]: undefined });
}

async function seedActiveWork(
  persistence: InMemoryWorkflowPersistence,
  jobQueue: InMemoryJobQueue,
  clock: FakeClock,
) {
  const t0 = clock.now();
  await persistence.createRun({
    id: "run-pending",
    workflowId: "wf",
    workflowName: "wf",
    workflowType: "wf",
    input: {},
  });
  const stage = await persistence.createStage({
    workflowRunId: "run-pending",
    stageId: "stage-suspended",
    stageName: "Suspended",
    stageNumber: 1,
    executionGroup: 1,
    status: "SUSPENDED",
  });
  await persistence.updateStage(stage.id, {
    nextPollAt: new Date(t0.getTime() + 30_000),
  });
  await jobQueue.enqueue({
    workflowRunId: "run-pending",
    workflowId: "wf",
    stageId: "stage-suspended",
  });
  await persistence.appendOutboxEvents([
    {
      workflowRunId: "run-pending",
      eventType: "workflow:created",
      payload: {},
      causationId: "cmd-1",
      occurredAt: t0,
    },
  ]);
}

describe("kernel: engine.stats", () => {
  it("reports active work with ages measured on the kernel clock, and writes nothing", async () => {
    const { kernel, clock, persistence, jobQueue } = setup();
    await seedActiveWork(persistence, jobQueue, clock);
    clock.advance(120_000);

    const stats = await kernel.dispatch({ type: "engine.stats" });

    expect(stats).toEqual({
      at: clock.now(),
      runs: {
        available: true,
        byStatus: { PENDING: 1, RUNNING: 0, SUSPENDED: 0 },
        oldestPendingAgeMs: 120_000,
      },
      stages: {
        available: true,
        byStatus: { PENDING: 0, RUNNING: 0, SUSPENDED: 1 },
        suspendedDue: 1,
        mostOverdueMs: 90_000,
      },
      jobs: {
        available: true,
        byStatus: { PENDING: 1, RUNNING: 0, SUSPENDED: 0 },
        oldestPendingAgeMs: 120_000,
      },
      outbox: {
        available: true,
        unpublished: 1,
        oldestUnpublishedAgeMs: 120_000,
        deadLettered: 0,
      },
    });

    // Read-only: no outbox event from the command, and no idempotency key.
    expect(await persistence.getUnpublishedOutboxEvents()).toHaveLength(1);
  });

  it("reports null ages and zero counts when there is no active work", async () => {
    const { kernel } = setup();

    const stats = await kernel.dispatch({ type: "engine.stats" });

    expect(stats.runs).toEqual({
      available: true,
      byStatus: { PENDING: 0, RUNNING: 0, SUSPENDED: 0 },
      oldestPendingAgeMs: null,
    });
    expect(stats.stages).toMatchObject({
      suspendedDue: 0,
      mostOverdueMs: null,
    });
    expect(stats.outbox).toMatchObject({ oldestUnpublishedAgeMs: null });
  });

  it("marks runs, stages and outbox unavailable when the persistence lacks getActiveWorkStats", async () => {
    const { kernel, clock, persistence, jobQueue } = setup({
      persistence: (p) => without(p, "getActiveWorkStats"),
    });
    await seedActiveWork(persistence, jobQueue, clock);

    const stats = await kernel.dispatch({ type: "engine.stats" });

    expect(stats.runs).toEqual({ available: false });
    expect(stats.stages).toEqual({ available: false });
    expect(stats.outbox).toEqual({ available: false });
    expect(stats.jobs).toMatchObject({ available: true });
  });

  it("marks jobs unavailable when the transport lacks getJobStats", async () => {
    const { kernel, clock, persistence, jobQueue } = setup({
      jobTransport: (q) => without(q, "getJobStats"),
    });
    await seedActiveWork(persistence, jobQueue, clock);

    const stats = await kernel.dispatch({ type: "engine.stats" });

    expect(stats.jobs).toEqual({ available: false });
    expect(stats.runs).toMatchObject({ available: true });
  });

  it("keeps the jobs figures when the transport is wrapped by createSpillingJobTransport", async () => {
    const { kernel, clock, persistence, jobQueue } = setup({
      jobTransport: (q) =>
        createSpillingJobTransport(q, { blobStore: new InMemoryBlobStore() }),
    });
    await seedActiveWork(persistence, jobQueue, clock);

    const stats = await kernel.dispatch({ type: "engine.stats" });

    expect(stats.jobs).toMatchObject({
      available: true,
      byStatus: { PENDING: 1, RUNNING: 0, SUSPENDED: 0 },
    });
  });

  it("does not make a wrapped transport claim getJobStats the inner one lacks", () => {
    const inner = without(new InMemoryJobQueue(), "getJobStats");

    expect(
      createSpillingJobTransport(inner, { blobStore: new InMemoryBlobStore() })
        .getJobStats,
    ).toBeUndefined();
  });
});
