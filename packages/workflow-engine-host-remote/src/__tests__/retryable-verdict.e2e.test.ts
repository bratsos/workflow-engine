/**
 * retryable-verdict.e2e.test.ts
 *
 * The worker's retry verdict reaches `job.execute`: an error that
 * `isRetryableStageError` rejects, raised by a stage on a remote worker, is
 * not retried per job attempts. The worker talks to the broker over the real
 * HTTP transport pair (`createHttpWorkerTransport` against
 * `createBrokerHttpServer`, real sockets and JSON); the kernel runs the stage
 * through `RemoteExecutor`.
 */
import type { AddressInfo } from "node:net";
import {
  defineStage,
  NonRetryableError,
  WorkflowBuilder,
} from "@bratsos/workflow-engine";
import { createKernel } from "@bratsos/workflow-engine/kernel";
import {
  CollectingEventSink,
  FakeClock,
} from "@bratsos/workflow-engine/kernel/testing";
import {
  InMemoryJobQueue,
  InMemoryWorkflowPersistence,
} from "@bratsos/workflow-engine/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { z as zodV3 } from "zod/v3";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
import { createRemoteExecutor } from "../orchestrator/remote-executor.js";
import { createBrokerHttpServer } from "../transport/http/broker-server.js";
import { createHttpWorkerTransport } from "../transport/http/worker-client.js";
import {
  createInProcessTransport,
  type WorkerTransport,
} from "../transport.js";
import { type RemoteStage } from "../worker/run-activity.js";
import { createActivityWorker } from "../worker/worker.js";
import { buildOrchestrator, heavyStage } from "./fixtures.js";

class QuotaError extends Error {
  constructor() {
    super("over quota");
    this.name = "QuotaError";
  }
}

function stageThatThrows(id: string, make: () => unknown) {
  return defineStage({
    id,
    name: id,
    schemas: {
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      config: z.object({}),
    },
    async execute() {
      throw make();
    },
  });
}

let teardowns: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of teardowns) await close();
  teardowns = [];
});

/** Runs one stage on a worker that talks to the broker over real HTTP. */
async function runOverHttp(
  stage: ReturnType<typeof stageThatThrows>,
  // Lets a test make the worker behave like one that predates the verdict.
  wrapWorker: (t: WorkerTransport) => WorkerTransport = (t) => t,
) {
  const clock = new FakeClock(new Date(0));
  const objectStore = new InMemoryObjectStore(clock);
  const broker = new Broker({
    store: new InMemoryBrokerStore(),
    presigner: objectStore,
    clock,
    stageCodeVersion: "v1",
    staleLeaseMs: 60_000,
  });
  const { orchestrator } = createInProcessTransport(broker, objectStore);

  const server = createBrokerHttpServer({ broker, objectStore });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  const worker = createActivityWorker({
    registry: new Map<string, RemoteStage>([[stage.id, stage]]),
    transport: wrapWorker(
      createHttpWorkerTransport({ baseUrl: `http://127.0.0.1:${port}` }),
    ),
    workerId: "http-worker",
    stageIds: [stage.id],
    stageCodeVersion: "v1",
    idleDelayMs: 5,
    // The server closes while the loop is mid-poll: not a failure of the test.
    onError: () => {},
  });
  worker.start();
  teardowns.push(
    () => worker.stop(),
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  const persistence = new InMemoryWorkflowPersistence();
  const workflow = new WorkflowBuilder(
    "wf",
    "Verdict",
    "",
    z.object({}),
    z.object({ ok: z.boolean() }),
  )
    .pipe(stage)
    .build();
  const kernel = createKernel({
    persistence,
    blobStore: objectStore,
    jobTransport: new InMemoryJobQueue(),
    eventSink: new CollectingEventSink(),
    clock,
    registry: {
      getWorkflow: (id: string) => (id === "wf" ? workflow : undefined),
    },
    executor: createRemoteExecutor(orchestrator, {
      pollIntervalMs: 100,
      maxWaitMs: 60_000,
      pollEveryMs: 5,
    }),
  });
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: "verdict",
    workflowId: "wf",
    input: {},
  });
  await kernel.dispatch({ type: "run.claimPending", workerId: "orch" });

  // Attempt 1 of 3: whether the failure is retried is the verdict's to decide.
  const result = await kernel.dispatch({
    type: "job.execute",
    workflowRunId,
    workflowId: "wf",
    stageId: stage.id,
    config: {},
    attempt: 1,
    maxAttempts: 3,
  });
  const record = await persistence.getStage(workflowRunId, stage.id);
  return { result, record };
}

describe("remote worker retry verdict over the HTTP transport pair", () => {
  it.each([
    [
      "a NonRetryableError",
      () => new NonRetryableError("card revoked"),
      "NonRetryableError: card revoked",
    ],
    [
      "a Zod error",
      () => z.number().parse("not a number"),
      expect.stringContaining("ZodError"),
    ],
    [
      "a Zod error from another copy of zod",
      () => zodV3.number().parse("not a number"),
      expect.stringContaining("ZodError"),
    ],
  ])(
    "fails the stage without a retry on %s",
    async (_name, make, message) => {
      const { result, record } = await runOverHttp(stageThatThrows("s", make));

      expect(result).toMatchObject({
        outcome: "failed",
        error: message,
        retryable: false,
        willRetry: false,
      });
      expect(record).toMatchObject({ status: "FAILED" });
    },
    30_000,
  );

  it("still retries an error the classifier allows, with the text a local stage records", async () => {
    const { result, record } = await runOverHttp(
      stageThatThrows("s", () => new QuotaError()),
    );

    expect(result).toMatchObject({
      outcome: "failed",
      error: "QuotaError: over quota",
      willRetry: true,
    });
    expect(result.retryable).toBeUndefined();
    expect(record).toMatchObject({
      status: "PENDING",
      errorMessage: "QuotaError: over quota",
    });
  }, 30_000);

  it("keeps today's behaviour for a worker that sends no verdict", async () => {
    const { result } = await runOverHttp(
      stageThatThrows("s", () => new NonRetryableError("card revoked")),
      (transport) => ({
        ...transport,
        report: (report) => {
          const { outcome } = report;
          if (outcome.kind !== "failed") return transport.report(report);
          // What a worker that predates the verdict sends.
          return transport.report({
            ...report,
            outcome: { kind: "failed", error: outcome.error },
          });
        },
      }),
    );

    expect(result).toMatchObject({
      outcome: "failed",
      error: "card revoked",
      willRetry: true,
    });
  }, 30_000);
});

describe("a defineRemoteStage proxy", () => {
  it("fails the stage on a failed outcome whose message is empty", async () => {
    const clock = new FakeClock(new Date(0));
    const objectStore = new InMemoryObjectStore(clock);
    const broker = new Broker({
      store: new InMemoryBrokerStore(),
      presigner: objectStore,
      clock,
      stageCodeVersion: "v1",
      staleLeaseMs: 60_000,
    });
    const { orchestrator, worker: workerTransport } = createInProcessTransport(
      broker,
      objectStore,
    );
    const orch = buildOrchestrator(orchestrator, objectStore, clock);
    const worker = createActivityWorker({
      registry: new Map<string, RemoteStage>([
        [
          "heavy",
          {
            ...heavyStage,
            async execute() {
              throw new NonRetryableError();
            },
          } as RemoteStage,
        ],
      ]),
      transport: workerTransport,
      workerId: "w1",
      stageIds: ["heavy"],
      stageCodeVersion: "v1",
    });

    const { workflowRunId } = await orch.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "empty-failure",
      workflowId: orch.workflowId,
      input: { seed: 1 },
    });
    await orch.kernel.dispatch({ type: "run.claimPending", workerId: "orch" });
    const job = (await orch.jobQueue.dequeue())!;
    expect(
      await orch.kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: orch.workflowId,
        stageId: job.stageId,
        config: {},
      }),
    ).toMatchObject({ outcome: "suspended" });
    expect(await worker.processOne()).toBe(true);
    const suspended = (
      await orch.persistence.getStagesByRun(workflowRunId)
    )[0]!;
    await orch.persistence.updateStage(suspended.id, {
      nextPollAt: new Date(clock.now().getTime() - 1),
    });

    const poll = await orch.kernel.dispatch({ type: "stage.pollSuspended" });

    expect(poll.failed).toBe(1);
    expect(
      await orch.persistence.getStage(workflowRunId, "heavy"),
    ).toMatchObject({ status: "FAILED", errorMessage: "NonRetryableError" });
  });
});
