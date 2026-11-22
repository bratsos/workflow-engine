/**
 * A run's start writes exactly one `workflow:started`, before the run's first
 * `stage:*` event, whichever of `run.claimPending` and `run.transition` moves
 * the run from PENDING to RUNNING first. A `run.transition` of a run that was
 * never claimed used to start the first group and leave the run PENDING, and
 * the claim then wrote a second `workflow:started`. Through kernel.dispatch on
 * the in-memory ports and, with SQLITE8_KERNEL_SQLITE=1 or DATABASE_URL, on
 * the Prisma ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../core/stage-factory.js";
import { WorkflowBuilder } from "../core/workflow.js";
import { createKernel } from "../kernel/kernel.js";
import {
  CollectingEventSink,
  InMemoryBlobStore,
} from "../kernel/testing/index.js";
import type { WorkflowPersistence } from "../persistence/interface.js";
import {
  InMemoryJobQueue,
  InMemoryWorkflowPersistence,
} from "../testing/index.js";
import {
  type KernelDatabase,
  kernelDatabase,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";

const schema = z.object({});
const stage = (id: string) =>
  defineStage({
    id,
    name: id,
    schemas: { input: schema, output: schema, config: schema },
    async execute() {
      return { output: {} };
    },
  });
const workflow = new WorkflowBuilder(
  "started-once",
  "Started once",
  "started-once",
  schema,
  schema,
)
  .pipe(stage("a"))
  .pipe(stage("b"))
  .build();

const FINISHED = [
  "workflow:created",
  "workflow:started",
  "stage:started",
  "stage:started",
  "workflow:completed",
];

describe(`workflow:started on ${realDatabase ? (sqlite ? "SQLite" : "Postgres") : "memory"}`, () => {
  let db: KernelDatabase | undefined;
  let persistence: WorkflowPersistence;
  let kernel: ReturnType<typeof createKernel>;

  beforeAll(async () => {
    if (realDatabase) db = await kernelDatabase();
  }, 120_000);
  beforeEach(async () => {
    await db?.reset();
    persistence = db?.persistence ?? new InMemoryWorkflowPersistence();
    kernel = createKernel({
      persistence,
      jobTransport: db?.jobTransport ?? new InMemoryJobQueue(),
      blobStore: db?.blobStore ?? new InMemoryBlobStore(),
      eventSink: new CollectingEventSink(),
      clock: { now: () => new Date() },
      registry: { getWorkflow: () => workflow },
    });
  });
  afterAll(async () => {
    await db?.close();
  });

  const create = async () =>
    (
      await kernel.dispatch({
        type: "run.create",
        workflowId: workflow.id,
        input: {},
        idempotencyKey: crypto.randomUUID(),
      })
    ).workflowRunId;
  const transition = (workflowRunId: string) =>
    kernel.dispatch({ type: "run.transition", workflowRunId });
  const claim = () =>
    kernel.dispatch({ type: "run.claimPending", workerId: "w" });
  const execute = (workflowRunId: string, stageId: string) =>
    kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: workflow.id,
      stageId,
      config: {},
    });
  /** The run's lifecycle events in the order they were written. */
  const events = async (workflowRunId: string) =>
    (await persistence.getUnpublishedOutboxEvents(1000))
      .filter((row) => row.workflowRunId === workflowRunId)
      .sort((x, y) => x.sequence - y.sequence)
      .map((row) => row.eventType)
      .filter((type) =>
        ["workflow:", "stage:started"].some((prefix) =>
          type.startsWith(prefix),
        ),
      );

  const schedules: Record<
    string,
    (id: string) => Promise<{ claimed: number }>
  > = {
    "claim, then transition": async (id) => {
      const { claimed } = await claim();
      await execute(id, "a");
      await transition(id);
      await execute(id, "b");
      await transition(id);
      return { claimed: claimed.length };
    },
    "transition, then claim": async (id) => {
      await transition(id);
      const { claimed } = await claim();
      await execute(id, "a");
      await transition(id);
      await execute(id, "b");
      await transition(id);
      return { claimed: claimed.length };
    },
    "transition, the first job, then claim": async (id) => {
      await transition(id);
      await execute(id, "a");
      const { claimed } = await claim();
      await transition(id);
      await execute(id, "b");
      await transition(id);
      return { claimed: claimed.length };
    },
    "transition twice, then claim": async (id) => {
      await transition(id);
      await transition(id);
      const { claimed } = await claim();
      await execute(id, "a");
      await transition(id);
      await execute(id, "b");
      await transition(id);
      return { claimed: claimed.length };
    },
  };

  it.each(
    Object.entries(schedules),
  )("writes one workflow:started before the first stage event: %s", async (name, schedule) => {
    const id = await create();
    const { claimed } = await schedule(id);

    expect(await events(id)).toEqual(FINISHED);
    expect((await persistence.getRun(id))?.status).toBe("COMPLETED");
    // A claim that comes after the transition has nothing left to claim.
    expect(claimed).toBe(name.startsWith("claim") ? 1 : 0);
  });

  it("moves a run to RUNNING when run.transition starts it", async () => {
    const id = await create();
    expect((await transition(id)).action).toBe("advanced");

    const run = (await persistence.getRun(id))!;
    expect(run.status).toBe("RUNNING");
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(await events(id)).toEqual(["workflow:created", "workflow:started"]);
  });

  it("writes one workflow:started when the two handlers race for a run", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await create();
      await Promise.all([transition(id), claim()]);
      await execute(id, "a");
      await transition(id);
      await execute(id, "b");
      await transition(id);

      expect(await events(id)).toEqual(FINISHED);
    }
  });

  it("writes one more workflow:started for a redrive", async () => {
    const id = await create();
    await claim();
    await execute(id, "a");
    await transition(id);
    await execute(id, "b");
    await transition(id);
    await kernel.dispatch({
      type: "run.redrive",
      workflowRunId: id,
      from: { kind: "start" },
    });

    expect(await events(id)).toEqual([...FINISHED, "workflow:started"]);
  });
});
