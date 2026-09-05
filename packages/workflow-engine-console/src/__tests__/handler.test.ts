import { describe, expect, it, vi } from "vitest";
import { ConsoleQueryTimeoutError } from "../errors";
import { createInMemoryConsoleReadPort } from "../in-memory-read-port";
import {
  type ConsoleAction,
  type ConsoleActionEvent,
  createWorkflowConsole,
  type WorkflowConsoleOptions,
} from "../index";
import type { ConsoleReadPort } from "../read-port";

const T0 = new Date("2026-01-01T00:00:00.000Z");

function fixtureReader() {
  return createInMemoryConsoleReadPort({
    runs: [
      {
        id: "run-1",
        createdAt: T0,
        updatedAt: T0,
        workflowId: "wf-a",
        workflowName: "Workflow A",
        workflowType: "standard",
        status: "RUNNING",
        startedAt: T0,
        completedAt: null,
        duration: null,
        totalCost: 0.25,
        totalTokens: 40,
        priority: 5,
      },
    ],
  });
}

function build(overrides: Partial<WorkflowConsoleOptions> = {}) {
  return createWorkflowConsole({
    reader: fixtureReader(),
    authorize: () => true,
    ...overrides,
  });
}

/** `Response.json()` is `unknown`; every assertion below reads a known shape. */
const body = async (response: Response): Promise<any> => response.json();

const get = (path: string) =>
  new Request(`https://app.example.com${path}`, { method: "GET" });
const post = (path: string, body?: unknown) =>
  new Request(`https://app.example.com${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("authorisation", () => {
  it("denies everything when no authorize callback was supplied", async () => {
    const handler = createWorkflowConsole({ reader: fixtureReader() });
    for (const path of [
      "/console/api/runs",
      "/console/api/runs/run-1",
      "/console/api/queue",
      "/console/api/dead-letters",
      "/console/api/workers",
      "/console/api/costs",
      "/console/api/suspended",
    ]) {
      const response = await handler(get(path));
      expect(response.status, path).toBe(403);
    }
  });

  it("denies when the host's callback throws, rather than allowing", async () => {
    const handler = build({
      authorize: () => {
        throw new Error("the host's auth code has a bug");
      },
    });
    expect((await handler(get("/console/api/runs"))).status).toBe(403);
  });

  it("denies when the callback returns anything other than true", async () => {
    const handler = build({
      authorize: () => "yes" as unknown as boolean,
    });
    expect((await handler(get("/console/api/runs"))).status).toBe(403);
  });

  it("passes the action verb and run id to the callback", async () => {
    const seen: Array<{ action: ConsoleAction; runId?: string }> = [];
    const handler = build({
      authorize: ({ action, runId }) => {
        seen.push({ action, runId });
        return true;
      },
    });
    await handler(get("/console/api/runs"));
    await handler(get("/console/api/runs/run-1"));
    await handler(get("/console/api/queue"));
    expect(seen).toEqual([
      { action: "runs.read", runId: undefined },
      { action: "run.read", runId: "run-1" },
      { action: "queue.read", runId: undefined },
    ]);
  });

  it("can grant one view without granting the others", async () => {
    const handler = build({
      authorize: ({ action }) => action === "queue.read",
    });
    expect((await handler(get("/console/api/queue"))).status).toBe(200);
    expect((await handler(get("/console/api/runs"))).status).toBe(403);
  });
});

describe("read-only by default", () => {
  it("refuses writes with 405 when actions are not enabled", async () => {
    const handler = build();
    for (const request of [
      post("/console/api/runs/run-1/cancel"),
      post("/console/api/runs/run-1/rerun", { fromStageId: "s1" }),
      post("/console/api/runs/run-1/stages/approve/steps/wait/signal"),
      post("/console/api/dead-letters/replay"),
    ]) {
      const response = await handler(request);
      expect(response.status).toBe(405);
      expect((await body(response)).error.code).toBe("read_only");
    }
  });

  it("reports readOnly in /api/meta", async () => {
    const response = await build()(get("/console/api/meta"));
    expect((await body(response)).readOnly).toBe(true);
  });

  it("refuses to be constructed with actions but no kernel", () => {
    expect(() =>
      createWorkflowConsole({
        reader: fixtureReader(),
        actions: true,
        authorize: () => true,
      }),
    ).toThrow(/kernel/);
  });
});

describe("actions dispatch kernel commands, never SQL", () => {
  function withKernel(authorize?: WorkflowConsoleOptions["authorize"]) {
    const dispatch = vi.fn(async () => ({ cancelled: true }));
    const events: ConsoleActionEvent[] = [];
    const handler = createWorkflowConsole({
      reader: fixtureReader(),
      kernel: { dispatch },
      actions: true,
      authorize: authorize ?? (() => true),
      onAction: (event) => {
        events.push(event);
      },
    });
    return { handler, dispatch, events };
  }

  it("maps cancel to the run.cancel command", async () => {
    const { handler, dispatch } = withKernel();
    const response = await handler(
      post("/console/api/runs/run-1/cancel", { reason: "operator" }),
    );
    expect(response.status).toBe(200);
    expect(dispatch).toHaveBeenCalledWith({
      type: "run.cancel",
      workflowRunId: "run-1",
      reason: "operator",
    });
  });

  it("maps rerun to run.redrive and still requires a stage by default", async () => {
    const { handler, dispatch } = withKernel();
    expect(
      (await handler(post("/console/api/runs/run-1/rerun", {}))).status,
    ).toBe(400);
    await handler(post("/console/api/runs/run-1/rerun", { fromStageId: "s2" }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "run.redrive",
      workflowRunId: "run-1",
      from: { kind: "stage", stageId: "s2" },
    });
  });

  it("redrives a stranded run onto the latest definition version", async () => {
    // The rescue path: a run pinned to a version no host serves is only
    // reachable through `definitionVersion`, which `run.rerunFrom` had no
    // way to express.
    const { handler, dispatch } = withKernel();
    await handler(
      post("/console/api/runs/run-1/rerun", {
        from: { kind: "lastFailure" },
        definitionVersion: "latest",
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "run.redrive",
      workflowRunId: "run-1",
      from: { kind: "lastFailure" },
      definitionVersion: "latest",
    });
  });

  it("rejects a malformed redrive mode rather than falling back to the default", async () => {
    const { handler } = withKernel();
    for (const body of [
      { from: { kind: "whenever" } },
      { from: { kind: "stage" } },
      { from: "start" },
      { fromStageId: "s2", definitionVersion: "" },
    ]) {
      expect(
        (await handler(post("/console/api/runs/run-1/rerun", body))).status,
      ).toBe(400);
    }
  });

  it("maps dead-letter replay to plugin.replayDLQ", async () => {
    const { handler, dispatch } = withKernel();
    await handler(post("/console/api/dead-letters/replay", { maxEvents: 25 }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "plugin.replayDLQ",
      maxEvents: 25,
    });
  });

  it("gates each write on its own action verb", async () => {
    const { handler, dispatch } = withKernel(
      ({ action }) => action === "run.cancel",
    );
    expect((await handler(post("/console/api/runs/run-1/cancel"))).status).toBe(
      200,
    );
    const denied = await handler(post("/console/api/dead-letters/replay"));
    expect(denied.status).toBe(403);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("reports every allowed write to onAction", async () => {
    const { handler, events } = withKernel();
    await handler(post("/console/api/runs/run-1/cancel"));
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("run.cancel");
    expect(events[0]?.runId).toBe("run-1");
    expect(events[0]?.result).toEqual({ cancelled: true });
  });

  it("does not reach the kernel for a denied write", async () => {
    const { handler, dispatch, events } = withKernel(() => false);
    expect((await handler(post("/console/api/runs/run-1/cancel"))).status).toBe(
      403,
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});

describe("delivering a durable-step signal", () => {
  const SIGNAL_PATH =
    "/console/api/runs/run-1/stages/approve/steps/wait/signal";

  function withKernel(
    options: {
      authorize?: WorkflowConsoleOptions["authorize"];
      dispatch?: (command: { type: string }) => Promise<unknown>;
    } = {},
  ) {
    const dispatch = vi.fn(
      options.dispatch ??
        (async () => ({ signalled: true, ok: true, alreadyCompleted: false })),
    );
    const events: ConsoleActionEvent[] = [];
    const handler = createWorkflowConsole({
      reader: fixtureReader(),
      kernel: { dispatch },
      actions: true,
      authorize: options.authorize ?? (() => true),
      onAction: (event) => {
        events.push(event);
      },
    });
    return { handler, dispatch, events };
  }

  it("dispatches step.signal with the payload and returns the kernel result", async () => {
    const { handler, dispatch } = withKernel();
    const response = await handler(
      post(SIGNAL_PATH, { payload: { approved: true, by: "ops" } }),
    );
    expect(response.status).toBe(200);
    expect((await body(response)).result).toEqual({
      signalled: true,
      ok: true,
      alreadyCompleted: false,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "step.signal",
      workflowRunId: "run-1",
      stageId: "approve",
      stepId: "wait",
      payload: { approved: true, by: "ops" },
    });
  });

  it("defaults the payload to null when none is sent", async () => {
    const { handler, dispatch } = withKernel();
    await handler(post(SIGNAL_PATH));
    await handler(post(SIGNAL_PATH, {}));
    expect(dispatch).toHaveBeenCalledTimes(2);
    for (const call of dispatch.mock.calls) {
      expect(call[0]).toMatchObject({ type: "step.signal", payload: null });
    }
  });

  it("decodes the run, stage and step ids from the path", async () => {
    const { handler, dispatch } = withKernel();
    await handler(
      post(
        "/console/api/runs/run%2F1/stages/approve%20it/steps/wait%3Aok/signal",
      ),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowRunId: "run/1",
        stageId: "approve it",
        stepId: "wait:ok",
      }),
    );
  });

  it("is gated on its own action verb, scoped to the run, stage and step", async () => {
    const seen: Array<{
      action: ConsoleAction;
      runId?: string;
      stageId?: string;
      stepId?: string;
    }> = [];
    const { handler, dispatch } = withKernel({
      authorize: ({ action, runId, stageId, stepId }) => {
        seen.push({ action, runId, stageId, stepId });
        return action === "run.cancel";
      },
    });
    expect((await handler(post(SIGNAL_PATH))).status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
    expect(seen).toEqual([
      {
        action: "step.signal",
        runId: "run-1",
        stageId: "approve",
        stepId: "wait",
      },
    ]);
  });

  it("rejects a body that is not JSON before reaching the kernel", async () => {
    const { handler, dispatch } = withKernel();
    const response = await handler(
      new Request(`https://app.example.com${SIGNAL_PATH}`, {
        method: "POST",
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
    expect((await body(response)).error.code).toBe("bad_request");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("answers 404 when the kernel cannot find the run or stage", async () => {
    const { handler, events } = withKernel({
      dispatch: async () => {
        throw new Error("Workflow stage run-1/approve not found");
      },
    });
    const response = await handler(post(SIGNAL_PATH));
    expect(response.status).toBe(404);
    expect((await body(response)).error).toEqual({
      code: "not_found",
      message: "Workflow stage run-1/approve not found",
    });
    expect(events).toHaveLength(0);
  });

  it.each([
    'Durable step "wait" was previously used as run and cannot receive a signal',
    'Durable signal step "wait" has failed and cannot receive a signal',
  ])("answers 409 when the ledger refuses the signal: %s", async (message) => {
    const { handler } = withKernel({
      dispatch: async () => {
        throw new Error(message);
      },
    });
    const response = await handler(post(SIGNAL_PATH));
    expect(response.status).toBe(409);
    expect((await body(response)).error).toEqual({ code: "conflict", message });
  });

  it("leaves any other kernel failure as a 500", async () => {
    const { handler } = withKernel({
      dispatch: async () => {
        throw new Error("step.signal requires a configured StepLedger");
      },
    });
    expect((await handler(post(SIGNAL_PATH))).status).toBe(500);
  });

  it("reports the delivered signal to onAction with its step scope", async () => {
    const { handler, events } = withKernel();
    await handler(post(SIGNAL_PATH, { payload: 42 }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "step.signal",
      runId: "run-1",
      stageId: "approve",
      stepId: "wait",
      result: { signalled: true, ok: true, alreadyCompleted: false },
    });
  });
});

describe("mounting at any path", () => {
  it.each([
    ["/", ""],
    ["/console", "/console"],
    ["/admin/ops/console", "/admin/ops/console"],
    ["/admin/ops/console/", "/admin/ops/console"],
  ])("derives the base path from %s", async (mount, expected) => {
    const response = await build()(get(`${mount}api/meta`.replace("//", "/")));
    // The document and the API agree on the base path they were reached at.
    const meta = await build()(
      get(`${expected === "" ? "" : expected}/api/meta`),
    ).then(body);
    expect(meta.basePath).toBe(expected);
    expect(response.status).toBe(200);
  });

  it("serves the document at the mount root and points assets at the same base", async () => {
    const response = await build()(get("/admin/ops/console"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    // Never cached: it carries the mount path and the feature flags.
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain('href="/admin/ops/console/assets/app.');
    expect(html).toContain('src="/admin/ops/console/assets/app.');
  });

  it("serves a hashed asset immutably and 404s an unknown one", async () => {
    const html = await build()(get("/console")).then((r) => r.text());
    const asset = /\/console\/assets\/(app\.[a-f0-9]+\.js)/.exec(html)?.[1];
    expect(asset).toBeDefined();
    const response = await build()(get(`/console/assets/${asset}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect((await build()(get("/console/assets/nope.js"))).status).toBe(404);
  });

  it("honours an explicit basePath when one is given", async () => {
    const handler = build({ basePath: "/fixed" });
    const meta = await handler(get("/fixed/api/meta")).then(body);
    expect(meta.basePath).toBe("/fixed");
  });
});

describe("the injected config", () => {
  it("carries the mount path, read-only state and capabilities so the SPA boots without a round trip", async () => {
    const reader = createInMemoryConsoleReadPort(
      {},
      { capabilities: { costs: false } },
    );
    const html = await createWorkflowConsole({
      reader,
      authorize: () => true,
      pollIntervalMs: 2500,
    })(get("/console")).then((r) => r.text());
    const json = /id="workflow-console-config">([^<]*)</.exec(html)?.[1];
    expect(json).toBeDefined();
    const config = JSON.parse(json!);
    expect(config).toMatchObject({
      basePath: "/console",
      readOnly: true,
      pollIntervalMs: 2500,
    });
    expect(config.capabilities.costs).toBe(false);
  });

  it("puts a CSP nonce on the scripts when the host supplies one", async () => {
    const html = await build({ cspNonce: () => "n0nce" })(get("/console")).then(
      (r) => r.text(),
    );
    expect(html).toContain('nonce="n0nce"');
  });

  it("escapes a payload that would otherwise close the script block", async () => {
    const reader = fixtureReader();
    const html = await createWorkflowConsole({
      reader,
      authorize: () => true,
      basePath: "</script><script>alert(1)</script>",
    })(get("/console")).then((r) => r.text());
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("query parameters", () => {
  it("rejects an unknown status rather than silently ignoring the filter", async () => {
    const response = await build()(get("/console/api/runs?status=EXPLODED"));
    expect(response.status).toBe(400);
    expect((await body(response)).error.code).toBe("bad_request");
  });

  it("accepts repeated and comma-separated statuses", async () => {
    const reader = fixtureReader();
    const spy = vi.spyOn(reader, "listRuns");
    const handler = createWorkflowConsole({ reader, authorize: () => true });
    await handler(
      get("/console/api/runs?status=RUNNING,failed&status=PENDING"),
    );
    expect(spy.mock.calls[0]?.[0].filters?.status).toEqual([
      "RUNNING",
      "FAILED",
      "PENDING",
    ]);
  });

  it("passes a definition version filter through to the reader", async () => {
    const reader = fixtureReader();
    const spy = vi.spyOn(reader, "listRuns");
    const handler = createWorkflowConsole({ reader, authorize: () => true });
    await handler(get("/console/api/runs?definitionVersion=sha256-abcdef"));
    expect(spy.mock.calls[0]?.[0].filters?.definitionVersion).toBe(
      "sha256-abcdef",
    );
  });

  it("rejects an unparseable date", async () => {
    expect((await build()(get("/console/api/runs?from=soon"))).status).toBe(
      400,
    );
  });

  it("rejects an unknown cost bucketing", async () => {
    expect((await build()(get("/console/api/costs?by=hour"))).status).toBe(400);
  });
});

describe("failure modes", () => {
  it("answers a cancelled query with 504 and a query_timeout code, not a hang", async () => {
    const reader = fixtureReader();
    vi.spyOn(reader, "listRuns").mockRejectedValue(
      new ConsoleQueryTimeoutError("runs.list", 15000),
    );
    const response = await createWorkflowConsole({
      reader,
      authorize: () => true,
    })(get("/console/api/runs"));
    expect(response.status).toBe(504);
    expect((await body(response)).error.code).toBe("query_timeout");
  });

  it("404s a run that does not exist", async () => {
    expect((await build()(get("/console/api/runs/nope"))).status).toBe(404);
  });

  it("404s an unknown API route", async () => {
    expect((await build()(get("/console/api/nope"))).status).toBe(404);
  });

  it("turns an unexpected reader failure into a 500 envelope", async () => {
    const reader: ConsoleReadPort = fixtureReader();
    vi.spyOn(reader, "getQueueHealth").mockRejectedValue(new Error("boom"));
    const response = await createWorkflowConsole({
      reader,
      authorize: () => true,
    })(get("/console/api/queue"));
    expect(response.status).toBe(500);
    expect((await body(response)).error.code).toBe("internal_error");
  });
});

describe("serialisation", () => {
  it("sends dates as ISO strings", async () => {
    const payload = await build()(get("/console/api/runs")).then(body);
    expect(payload.runs[0].createdAt).toBe(T0.toISOString());
  });
});
