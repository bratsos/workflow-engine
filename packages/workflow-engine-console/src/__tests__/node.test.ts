/**
 * The Node adapter, over a real `node:http` server.
 *
 * This is the path the `workflow-console` dev command takes, and the one
 * Express and Fastify take, so it is worth proving end to end rather than
 * by inspection: a real socket, a real request line, a real body.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorkflowConsole } from "../handler";
import { createInMemoryConsoleReadPort } from "../in-memory-read-port";
import { toNodeHandler } from "../node";

const T0 = new Date("2026-01-01T00:00:00.000Z");

const dispatch = vi.fn(async () => ({ cancelled: true }));

const handler = createWorkflowConsole({
  reader: createInMemoryConsoleReadPort({
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
        totalCost: 0,
        totalTokens: 0,
        priority: 5,
      },
    ],
  }),
  kernel: { dispatch },
  actions: true,
  authorize: () => true,
});

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("expected a TCP address");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("over node:http", () => {
  it("serves the document and the asset it points at", async () => {
    const page = await fetch(`${origin}/console`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();

    const script = /src="(\/console\/assets\/app\.[a-f0-9]+\.js)"/.exec(
      html,
    )?.[1];
    const style = /href="(\/console\/assets\/app\.[a-f0-9]+\.css)"/.exec(
      html,
    )?.[1];
    expect(script).toBeDefined();
    expect(style).toBeDefined();

    const asset = await fetch(`${origin}${script}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    // The compiled SPA really is in there, not a placeholder.
    expect((await asset.text()).length).toBeGreaterThan(10_000);

    const css = await fetch(`${origin}${style}`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("answers the JSON API at the same mount point", async () => {
    const response = await fetch(`${origin}/console/api/runs`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      runs: Array<{ id: string }>;
    };
    expect(payload.runs.map((run) => run.id)).toEqual(["run-1"]);
  });

  it("carries a POST body through to the kernel", async () => {
    dispatch.mockClear();
    const response = await fetch(`${origin}/console/api/runs/run-1/rerun`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromStageId: "stage-2" }),
    });
    expect(response.status).toBe(200);
    expect(dispatch).toHaveBeenCalledWith({
      type: "run.redrive",
      workflowRunId: "run-1",
      from: { kind: "stage", stageId: "stage-2" },
    });
  });

  it("mounts under a deeper path without being told where it is", async () => {
    const response = await fetch(`${origin}/a/b/c/console/api/meta`);
    expect(response.status).toBe(200);
    const meta = (await response.json()) as { basePath: string };
    expect(meta.basePath).toBe("/a/b/c/console");
  });
});
