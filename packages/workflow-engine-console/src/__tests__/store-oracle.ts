/**
 * The attempt history against the engine's Prisma store, on whichever
 * database a suite gives it (SQLite or Postgres, Prisma 6, 7 or 8).
 *
 * The in-memory oracle (`stage-attempts.kernel.test.ts`) cannot see what the
 * Prisma store writes differently, such as a stage row's `startedAt`, which
 * it stamps when it creates the row. Here the real kernel runs on the real
 * store, and the page is read through the real Prisma read port and the
 * console handler:
 *  - after every kernel dispatch with nothing removed, where every stage
 *    must have a history;
 *  - at marks in each scenario, rows removed from the end of the run's
 *    outbox by SQL, after which the run writes again: a history shown must
 *    be the one kept in full, or one the stated limit names;
 *  - the stored rows of releases alpha.13 to alpha.20.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createWorkflowConsole } from "../handler";
import { createPrismaConsoleReadPort } from "../prisma-read-port";
import {
  buildStageAttemptHistory,
  type HeldStageEvents,
  mergeStageEvents,
  type StageAttemptHistory,
} from "../stage-attempts";

// Variables, so `tsc` does not pull the engine's source into this typecheck.
const kernelSpecifier = "@bratsos/workflow-engine/kernel";
const persistenceSpecifier = "@bratsos/workflow-engine/persistence";
const engineSpecifier = "@bratsos/workflow-engine";
const storedRows = resolve(
  new URL(".", import.meta.url).pathname,
  "../../../workflow-engine/src/__tests__/stored-rows",
);
const snapshotSpecifier = join(storedRows, "snapshot.ts");

const io = z.object({ v: z.string() });
const schemas = { input: io, output: io, config: z.object({}) };

type Db = "sqlite" | "postgresql";

/** A kernel on the Prisma store of `client`, a clock it can move, and the page. */
export async function storeWorld(client: any, databaseType: Db) {
  const { createKernel, executeJobWithHeartbeat } = await import(
    kernelSpecifier
  );
  const store = await import(persistenceSpecifier);
  const options = { databaseType };
  const jobQueue = store.createPrismaJobQueue(client, {
    ...options,
    workerId: "w",
  });
  const workflows = new Map<string, any>();
  // The kernel's clock: real time plus what the scenarios skip (a step's
  // sleep, a stuck-run threshold). The store stamps its own rows with real
  // time, as a deployment's database and workers do.
  let offset = 0;
  const kernel: any = createKernel({
    persistence: store.createPrismaWorkflowPersistence(client, options),
    jobTransport: jobQueue,
    stepLedger: store.createPrismaStepLedger(client, options),
    blobStore: store.createPrismaBlobStore(client),
    clock: { now: () => new Date(Date.now() + offset) },
    eventSink: { emit: async () => {} },
    registry: { getWorkflow: (id: string) => workflows.get(id) },
  });
  const handler = createWorkflowConsole({
    reader: createPrismaConsoleReadPort(client, { databaseType }),
    authorize: () => true,
  });
  let created = 0;

  const w = {
    client,
    kernel,
    workflows,
    advance: (ms: number) => {
      offset += ms;
    },
    async start(workflowId: string) {
      return (
        await kernel.dispatch({
          type: "run.create",
          idempotencyKey: `store-oracle-${Date.now()}-${++created}`,
          workflowId,
          input: { v: "x" },
        })
      ).workflowRunId as string;
    },
    claim: () =>
      kernel.dispatch({
        type: "run.claimPending",
        workerId: "w",
        maxClaims: 10,
      }),
    async runJobs(max = 20) {
      let ran = 0;
      for (; ran < max; ran++) {
        // Every job is due now: the queue's retry backoff is skipped.
        await client.jobQueue.updateMany({ data: { nextPollAt: null } });
        const job = await jobQueue.dequeue();
        if (!job) break;
        await executeJobWithHeartbeat(kernel, {
          jobTransport: jobQueue,
          job,
          jobHeartbeatIntervalMs: 60_000,
          logPrefix: "[store-oracle]",
        });
      }
      return ran;
    },
    async poll() {
      const polled = await kernel.dispatch({
        type: "stage.pollSuspended",
        maxChecks: 50,
      });
      for (const id of polled.resumedWorkflowRunIds)
        await kernel.dispatch({ type: "run.transition", workflowRunId: id });
      return polled.checked as number;
    },
    /** Claims, jobs and due polls until nothing moves. */
    async drain() {
      for (let round = 0; round < 16; round++) {
        await w.claim();
        const ran = await w.runJobs();
        w.advance(5 * 60_000);
        const checked = await w.poll();
        if (ran === 0 && checked === 0) break;
      }
    },
    redrive: (runId: string, from: unknown = { kind: "lastFailure" }) =>
      kernel.dispatch({ type: "run.redrive", workflowRunId: runId, from }),
    /** The page: the handler's JSON, folded as the page folds it, grouped. */
    async page(runId: string) {
      let held: HeldStageEvents | null = null;
      let body: any;
      for (let read = 0; read < 20; read++) {
        const query = held ? `?stageEventsAfter=${held.lastSequence}` : "";
        const res = await handler(
          new Request(
            `https://console.example/console/api/runs/${runId}${query}`,
          ),
        );
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        body = await res.json();
        held = mergeStageEvents(held, body.stageEvents);
        if (held && !held.more) break;
      }
      const histories = buildStageAttemptHistory({
        redriveCount: body.run.redriveCount,
        runStatus: body.run.status,
        stages: body.stages,
        steps: body.steps,
        stageEvents: {
          events: held!.events,
          coverage: held!.coverage,
          caughtUp: !held!.more,
        },
      });
      const byStage = new Map<string, StageAttemptHistory>();
      for (const s of body.stages) byStage.set(s.stageId, histories.get(s.id)!);
      return { body, byStage };
    },
    /** Rows of the run past `keep` removed, as an operator's SQL would. */
    removeAfter: (runId: string, keep: number) =>
      client.outboxEvent.deleteMany({
        where: { workflowRunId: runId, sequence: { gt: keep } },
      }),
    async rowCount(runId: string) {
      return (
        await client.outboxEvent.findMany({ where: { workflowRunId: runId } })
      ).length as number;
    },
  };
  return w;
}

type World = Awaited<ReturnType<typeof storeWorld>>;
type Mark = (label: string, runId: string) => Promise<void>;

interface StoreScenario {
  name: string;
  marks: string[];
  run: (w: World, mark: Mark) => Promise<string>;
}

/**
 * The scenarios of the gate that found the store's `startedAt` form, and the
 * redrive that keeps an earlier row CANCELLED. Each run registers workflows
 * of its own, so a stage body's counters start again.
 */
export async function storeScenarios(): Promise<StoreScenario[]> {
  const { defineStage, WorkflowBuilder } = await import(engineSpecifier);
  let serial = 0;
  const stage = (
    id: string,
    body: (ctx: any) => Promise<unknown> = async (ctx) => ({
      output: ctx.input,
    }),
  ) => defineStage({ id, name: id.toUpperCase(), schemas, execute: body });
  const register = (w: World, build: (b: any) => any) => {
    const id = `store-wf-${++serial}`;
    w.workflows.set(
      id,
      build(new WorkflowBuilder(id, id, "d", io, io)).build(),
    );
    return id;
  };
  const failing = (times: number, message: string) => {
    let left = times;
    return async (ctx: any) => {
      if (left-- > 0) throw new Error(message);
      return { output: ctx.input };
    };
  };
  return [
    {
      name: "fails until retries run out, redrive lastFailure twice, redrive from start",
      marks: ["g1", "g2", "g3"],
      async run(w, mark) {
        const wf = register(w, (b) =>
          b.pipe(stage("a")).pipe(stage("b", failing(6, "b down"))),
        );
        const runId = await w.start(wf);
        await w.drain();
        await mark("g1", runId);
        await w.redrive(runId);
        await w.drain();
        await mark("g2", runId);
        await w.redrive(runId);
        await w.drain();
        await mark("g3", runId);
        await w.redrive(runId, { kind: "start" });
        await w.drain();
        return runId;
      },
    },
    {
      name: "parallel member fails while its sibling is queued, redrive, redrive from the sibling",
      marks: ["g1", "g2"],
      async run(w, mark) {
        const wf = register(w, (b) =>
          b
            .parallel([stage("p", failing(3, "p down")), stage("q")])
            .pipe(stage("c")),
        );
        const runId = await w.start(wf);
        await w.drain();
        await mark("g1", runId);
        await w.redrive(runId);
        await w.drain();
        await mark("g2", runId);
        await w.redrive(runId, { kind: "stage", stageId: "q" });
        await w.drain();
        return runId;
      },
    },
    {
      name: "suspended with a poll retry, redrive from the stage, redrive from start",
      marks: ["g1", "g2"],
      async run(w, mark) {
        let replays = 0;
        const wf = register(w, (b) =>
          b
            .pipe(
              stage("s", async (ctx) => {
                await ctx.step.sleep("nap", "1m");
                await ctx.step.run("after", async () => {
                  if (++replays === 1) throw new Error("flaky");
                  return "ok";
                });
                return { output: ctx.input };
              }),
            )
            .pipe(stage("c")),
        );
        const runId = await w.start(wf);
        await w.drain();
        await mark("g1", runId);
        await w.redrive(runId, { kind: "stage", stageId: "s" });
        await w.drain();
        await mark("g2", runId);
        await w.redrive(runId, { kind: "start" });
        await w.drain();
        return runId;
      },
    },
    {
      name: "cancelled while running twice, with redrives",
      marks: ["g1", "g2"],
      async run(w, mark) {
        let runs = 0;
        let runId = "";
        const wf = register(w, (b) =>
          b
            .pipe(
              stage("slow", async (ctx) => {
                runs++;
                await ctx.step.run(`w${runs}`, async () => "x");
                if (runs <= 2)
                  await w.kernel.dispatch({
                    type: "run.cancel",
                    workflowRunId: runId,
                  });
                return { output: ctx.input };
              }),
            )
            .pipe(stage("c")),
        );
        runId = await w.start(wf);
        await w.drain();
        await mark("g1", runId);
        await w.redrive(runId);
        await w.drain();
        await mark("g2", runId);
        await w.redrive(runId, { kind: "start" });
        await w.drain();
        return runId;
      },
    },
    {
      name: "job retry, completed, redrive from start, redrive from the next stage",
      marks: ["g1", "g2"],
      async run(w, mark) {
        const wf = register(w, (b) =>
          b.pipe(stage("a", failing(1, "upstream 503"))).pipe(stage("b")),
        );
        const runId = await w.start(wf);
        await w.drain();
        await mark("g1", runId);
        await w.redrive(runId, { kind: "start" });
        await w.drain();
        await mark("g2", runId);
        await w.redrive(runId, { kind: "stage", stageId: "b" });
        await w.drain();
        return runId;
      },
    },
    {
      name: "suspended, cancelled, redrive from the stage",
      marks: ["g1"],
      async run(w, mark) {
        const wf = register(w, (b) =>
          b
            .pipe(stage("a"))
            .pipe(
              stage("s", async (ctx) => {
                await ctx.step.sleep("nap", "1m");
                return { output: ctx.input };
              }),
            )
            .pipe(stage("c")),
        );
        const runId = await w.start(wf);
        await w.claim();
        await w.runJobs();
        await w.runJobs();
        await w.kernel.dispatch({ type: "run.cancel", workflowRunId: runId });
        await mark("g1", runId);
        await w.redrive(runId, { kind: "stage", stageId: "s" });
        await w.drain();
        return runId;
      },
    },
    {
      name: "stuck-run reap of a suspended stage, redrive",
      marks: ["g1"],
      async run(w, mark) {
        const wf = register(w, (b) =>
          b.pipe(
            stage("nap", async (ctx) => {
              await ctx.step.sleep("nap", "20m");
              return { output: ctx.input };
            }),
          ),
        );
        const runId = await w.start(wf);
        await w.claim();
        await w.runJobs();
        w.advance(30 * 60_000);
        await w.kernel.dispatch({
          type: "run.reapStuck",
          stuckThresholdMs: 5 * 60_000,
        });
        await mark("g1", runId);
        await w.redrive(runId);
        await w.drain();
        return runId;
      },
    },
    {
      name: "cancelled while its first stages were queued, redrive",
      marks: ["g1"],
      async run(w, mark) {
        const wf = register(w, (b) =>
          b.parallel([stage("p"), stage("q")]).pipe(stage("c")),
        );
        const runId = await w.start(wf);
        await w.claim();
        await w.kernel.dispatch({ type: "run.cancel", workflowRunId: runId });
        await mark("g1", runId);
        await w.redrive(runId);
        await w.drain();
        return runId;
      },
    },
    {
      // Two `workflow:started` with no end between: the transition's, which
      // leaves the run PENDING, and the claim's.
      name: "run.transition before the claim, a job of it run before the claim, redrive",
      marks: ["g1"],
      async run(w, mark) {
        const wf = register(w, (b) => b.pipe(stage("a")).pipe(stage("b")));
        const runId = await w.start(wf);
        await w.kernel.dispatch({
          type: "run.transition",
          workflowRunId: runId,
        });
        await w.runJobs(1);
        await w.claim();
        await w.drain();
        await mark("g1", runId);
        await w.redrive(runId, { kind: "start" });
        await w.drain();
        return runId;
      },
    },
    {
      name: "cancelled while b runs, redrive from a later stage c, then from b",
      marks: ["g1", "g2"],
      async run(w, mark) {
        let runs = 0;
        let runId = "";
        const wf = register(w, (b) =>
          b
            .pipe(stage("a"))
            .pipe(
              stage("b", async (ctx) => {
                runs++;
                await ctx.step.run(`w${runs}`, async () => "x");
                if (runs === 1)
                  await w.kernel.dispatch({
                    type: "run.cancel",
                    workflowRunId: runId,
                  });
                return { output: ctx.input };
              }),
            )
            .pipe(stage("c")),
        );
        runId = await w.start(wf);
        await w.drain();
        await mark("g1", runId);
        await w.redrive(runId, { kind: "stage", stageId: "c" });
        await w.drain();
        await mark("g2", runId);
        await w.redrive(runId, { kind: "stage", stageId: "b" });
        await w.drain();
        return runId;
      },
    },
  ];
}

const project = (history: StageAttemptHistory) =>
  history.available
    ? history.attempts.map((a) => ({
        trigger: a.trigger,
        outcome: a.outcome,
        executed: a.executed,
        events: a.events.map((e) => e.eventType),
        error: a.error,
      }))
    : null;

/** The executions the stage row counts: neither re-deliveries nor their lost predecessors. */
const counted = (history: StageAttemptHistory) =>
  history.available
    ? history.attempts
        .filter((a) => a.trigger !== "redelivery")
        .map((a) => [a.trigger, a.executed, a.error])
    : null;

export interface StoreOracleResult {
  /** Page reads made after a dispatch with nothing removed. */
  samples: number;
  /** Stages read as unavailable at such a moment: each a false statement. */
  unavailableWithNothingRemoved: string[];
  removals: number;
  /** A history shown that differs from the one kept in full, outside the stated limit. */
  outside: string[];
  /** Inside the limit, but the row's attempt count could have shown it. */
  visible: string[];
  /** Inside the limit (rows removed from the end, a re-delivery hidden). */
  limit: string[];
}

/** Runs every scenario on the store, with nothing removed and with removals from the end. */
export async function runStoreOracle(w: World): Promise<StoreOracleResult> {
  const result: StoreOracleResult = {
    samples: 0,
    unavailableWithNothingRemoved: [],
    removals: 0,
    outside: [],
    visible: [],
    limit: [],
  };
  const dispatch = w.kernel.dispatch.bind(w.kernel);
  for (const scenario of await storeScenarios()) {
    // Nothing removed: the page after every dispatch.
    let watched = "";
    let busy = false;
    w.kernel.dispatch = async (command: any) => {
      const out = await dispatch(command);
      if (command.type === "run.create") watched = out.workflowRunId;
      if (watched && !busy) {
        busy = true;
        try {
          const { body, byStage } = await w.page(watched);
          result.samples++;
          for (const s of body.stages) {
            const h = byStage.get(s.stageId)!;
            if (!h.available)
              result.unavailableWithNothingRemoved.push(
                `${scenario.name} | after ${command.type} | run ${body.run.status} | ${s.stageId} ${s.status} a=${s.attempt} | ${h.reason}/${h.mismatch ?? h.runMismatch ?? ""}`,
              );
          }
        } finally {
          busy = false;
        }
      }
      return out;
    };
    const sizes: Record<string, number> = {};
    let keptRun = "";
    try {
      keptRun = await scenario.run(w, async (label, runId) => {
        sizes[label] = await w.rowCount(runId);
      });
    } finally {
      w.kernel.dispatch = dispatch;
    }
    const truth = (await w.page(keptRun)).byStage;

    // Rows removed from the end at one mark, then the run writes again.
    for (const label of scenario.marks) {
      const n = sizes[label]!;
      const keeps = [
        ...new Set([0, 1, 2, Math.floor(n / 2), n - 2, n - 1]),
      ].filter((k) => k >= 0 && k < n);
      for (const keep of keeps) {
        const runId = await scenario.run(w, async (at, id) => {
          if (at === label) await w.removeAfter(id, keep);
        });
        result.removals++;
        const got = (await w.page(runId)).byStage;
        for (const [stageId, g] of got) {
          const t = truth.get(stageId);
          if (!g.available || !t) continue;
          if (JSON.stringify(project(g)) === JSON.stringify(project(t)))
            continue;
          const finding = `${scenario.name} | ${label}: rows after ${keep} of ${n} removed | ${stageId}\n      shown: ${JSON.stringify(project(g))}\n      kept:  ${JSON.stringify(project(t))}`;
          // Everything gone is not a removal from the end with the head kept.
          if (keep === 0) {
            result.outside.push(finding);
            continue;
          }
          result.limit.push(finding);
          if (
            !t.available ||
            JSON.stringify(counted(g)) !== JSON.stringify(counted(t))
          )
            result.visible.push(finding);
        }
      }
    }
  }
  return result;
}

/**
 * The stored rows of every release since alpha.13 (`stored-rows/snapshots`),
 * written into this database and read through the page: one line per stage.
 */
export async function readStoredRows(w: World) {
  const { decodeValue, parseModelShapes } = await import(snapshotSpecifier);
  const shapes = parseModelShapes(
    readFileSync(resolve(storedRows, "../../../prisma/schema.prisma"), "utf8"),
  );
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".json")) files.push(path);
    }
  };
  walk(join(storedRows, "snapshots"));
  const rows = (snapshot: any, model: string) => {
    const allowed = new Set<string>(shapes[model].columns);
    return (snapshot.tables[model] ?? []).map((encoded: unknown) =>
      Object.fromEntries(
        Object.entries(decodeValue(encoded) as Record<string, unknown>).filter(
          ([column]) => allowed.has(column),
        ),
      ),
    );
  };
  const lines: {
    file: string;
    scenario: string;
    stage: string;
    read: string;
  }[] = [];
  for (const file of files.sort()) {
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    const runs = rows(snapshot, "WorkflowRun");
    const ids = runs.map((r: any) => r.id as string);
    const clear = async () => {
      for (const id of ids) {
        await w.client.outboxEvent.deleteMany({ where: { workflowRunId: id } });
        await w.client.workflowRun.deleteMany({ where: { id } });
      }
    };
    await clear();
    try {
      for (const model of [
        "WorkflowRun",
        "WorkflowStage",
        "WorkflowStep",
        "OutboxEvent",
      ]) {
        const data = rows(snapshot, model);
        const delegate = model[0]!.toLowerCase() + model.slice(1);
        if (data.length > 0) await w.client[delegate].createMany({ data });
      }
      for (const id of ids) {
        const { body, byStage } = await w.page(id);
        for (const s of body.stages) {
          const h = byStage.get(s.stageId)!;
          lines.push({
            file: file.slice(storedRows.length + "/snapshots/".length),
            scenario: snapshot.metadata.scenario,
            stage: `${s.stageId} ${s.status} a=${s.attempt}`,
            read: h.available
              ? `available ${h.attempts.map((a) => `${a.trigger}:${a.outcome}`).join(",")}`
              : `unavailable ${h.reason}/${h.mismatch ?? h.runMismatch ?? ""}`,
          });
        }
      }
    } finally {
      await clear();
    }
  }
  return { files: files.length, lines };
}
