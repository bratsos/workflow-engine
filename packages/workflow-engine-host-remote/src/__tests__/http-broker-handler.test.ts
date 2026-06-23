/**
 * Unit tests for handleBrokerRequest — NO node:http, NO network.
 * A real Broker + InMemoryObjectStore + InMemoryBrokerStore are used so the
 * happy-path tests prove end-to-end correctness through real broker logic.
 */
import { FakeClock } from "@bratsos/workflow-engine/kernel/testing";
import { describe, expect, it } from "vitest";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
import type { SubmitRequest } from "../protocol.js";
import type {
  BrokerServerDeps,
  IncomingRequest,
} from "../transport/http/broker-server.js";
import { handleBrokerRequest } from "../transport/http/broker-server.js";

function makeSetup(opts: { authToken?: string } = {}) {
  const clock = new FakeClock(new Date(0));
  const os = new InMemoryObjectStore(clock);
  const broker = new Broker({
    store: new InMemoryBrokerStore(),
    presigner: os,
    clock,
    stageCodeVersion: "v1",
  });
  const deps: BrokerServerDeps = {
    broker,
    objectStore: os,
    authToken: opts.authToken,
    publicBaseUrl: "http://127.0.0.1:9999",
  };
  return { deps, broker, os, clock };
}

function req(
  method: string,
  path: string,
  body: unknown = null,
  headers: Record<string, string> = {},
): IncomingRequest {
  return { method, path, headers, body };
}

function bearerReq(
  method: string,
  path: string,
  body: unknown,
  token: string,
): IncomingRequest {
  return req(method, path, body, { authorization: `Bearer ${token}` });
}

/** Submit a task to the broker and return its taskId. */
async function submitTask(broker: Broker, seed = 1): Promise<string> {
  const submitReq: SubmitRequest = {
    workflowRunId: `run-${seed}`,
    stageId: "heavy",
    stageName: "Heavy",
    stageNumber: 0,
    input: { seed },
    config: {},
    workflowContext: {},
    pollInterval: 1000,
    maxWaitTime: 60_000,
  };
  const res = await broker.submit(submitReq);
  return res.taskId;
}

describe("handleBrokerRequest — auth", () => {
  it("returns 401 when token is configured and header is missing", async () => {
    const { deps } = makeSetup({ authToken: "secret" });
    const res = await handleBrokerRequest(deps, req("POST", "/lease", {}));
    expect(res.status).toBe(401);
    expect((res.json as { error: string }).error).toBe("unauthorized");
  });

  it("returns 401 when token is wrong", async () => {
    const { deps } = makeSetup({ authToken: "secret" });
    const res = await handleBrokerRequest(
      deps,
      bearerReq("POST", "/lease", {}, "wrong"),
    );
    expect(res.status).toBe(401);
  });

  it("passes through when token is correct", async () => {
    const { deps } = makeSetup({ authToken: "secret" });
    // Lease with correct token — no tasks queued → 204.
    const res = await handleBrokerRequest(
      deps,
      bearerReq(
        "POST",
        "/lease",
        { workerId: "w1", stageIds: ["heavy"], stageCodeVersion: "v1" },
        "secret",
      ),
    );
    expect(res.status).toBe(204);
  });

  it("allows all requests when no authToken is configured", async () => {
    const { deps } = makeSetup();
    const res = await handleBrokerRequest(
      deps,
      req("POST", "/lease", {
        workerId: "w1",
        stageIds: ["heavy"],
        stageCodeVersion: "v1",
      }),
    );
    expect(res.status).toBe(204);
  });
});

describe("handleBrokerRequest — lease", () => {
  it("returns 204 when no task is available", async () => {
    const { deps } = makeSetup();
    const res = await handleBrokerRequest(
      deps,
      req("POST", "/lease", {
        workerId: "w1",
        stageIds: ["heavy"],
        stageCodeVersion: "v1",
      }),
    );
    expect(res.status).toBe(204);
  });

  it("returns 200 ActivityTask when a task is pending", async () => {
    const { deps, broker } = makeSetup();
    const taskId = await submitTask(broker);

    const res = await handleBrokerRequest(
      deps,
      req("POST", "/lease", {
        workerId: "w1",
        stageIds: ["heavy"],
        stageCodeVersion: "v1",
      }),
    );
    expect(res.status).toBe(200);
    const task = res.json as { taskId: string; stageId: string };
    expect(task.taskId).toBe(taskId);
    expect(task.stageId).toBe("heavy");
  });

  it("returns 409 on stage code version mismatch", async () => {
    const { deps } = makeSetup();
    const res = await handleBrokerRequest(
      deps,
      req("POST", "/lease", {
        workerId: "w1",
        stageIds: ["heavy"],
        stageCodeVersion: "v2", // broker is "v1"
      }),
    );
    expect(res.status).toBe(409);
    expect((res.json as { error: string }).error).toMatch(/version mismatch/);
  });
});

describe("handleBrokerRequest — report", () => {
  it("returns 200 { ok: true } on a valid report", async () => {
    const { deps, broker } = makeSetup();
    await submitTask(broker);

    // Lease the task first.
    const leaseRes = await handleBrokerRequest(
      deps,
      req("POST", "/lease", {
        workerId: "w1",
        stageIds: ["heavy"],
        stageCodeVersion: "v1",
      }),
    );
    const task = leaseRes.json as { taskId: string; leaseToken: string };

    const reportBody = {
      taskId: task.taskId,
      leaseToken: task.leaseToken,
      outcome: { kind: "completed", output: { x: 1 } },
      logs: [],
      annotations: [],
      progress: [],
    };
    const res = await handleBrokerRequest(
      deps,
      req("POST", "/report", reportBody),
    );
    expect(res.status).toBe(200);
    expect((res.json as { ok: boolean }).ok).toBe(true);
  });

  it("returns 409 when lease token is stale (fenced report)", async () => {
    const { deps, broker } = makeSetup();
    await submitTask(broker);

    await handleBrokerRequest(
      deps,
      req("POST", "/lease", {
        workerId: "w1",
        stageIds: ["heavy"],
        stageCodeVersion: "v1",
      }),
    );

    const badReport = {
      taskId: "non-existent-task",
      leaseToken: "bad-token",
      outcome: { kind: "completed", output: {} },
      logs: [],
      annotations: [],
      progress: [],
    };
    const res = await handleBrokerRequest(
      deps,
      req("POST", "/report", badReport),
    );
    expect(res.status).toBe(409);
  });
});

describe("handleBrokerRequest — heartbeat", () => {
  it("returns 200 with ok:true for a valid lease", async () => {
    const { deps, broker } = makeSetup();
    await submitTask(broker);

    const leaseRes = await handleBrokerRequest(
      deps,
      req("POST", "/lease", {
        workerId: "w1",
        stageIds: ["heavy"],
        stageCodeVersion: "v1",
      }),
    );
    const task = leaseRes.json as { taskId: string; leaseToken: string };

    const hbRes = await handleBrokerRequest(
      deps,
      req("POST", "/heartbeat", {
        taskId: task.taskId,
        leaseToken: task.leaseToken,
      }),
    );
    expect(hbRes.status).toBe(200);
    const hb = hbRes.json as { ok: boolean; cancel: boolean };
    expect(hb.ok).toBe(true);
    expect(hb.cancel).toBe(false);
  });
});

describe("handleBrokerRequest — presign", () => {
  it("returns a blob HTTP URL for a valid PUT presign request", async () => {
    const { deps, broker } = makeSetup();
    await submitTask(broker);

    const leaseRes = await handleBrokerRequest(
      deps,
      req("POST", "/lease", {
        workerId: "w1",
        stageIds: ["heavy"],
        stageCodeVersion: "v1",
      }),
    );
    const task = leaseRes.json as {
      taskId: string;
      leaseToken: string;
      grant: { prefix: string };
    };

    const presignRes = await handleBrokerRequest(
      deps,
      req("POST", "/presign", {
        taskId: task.taskId,
        leaseToken: task.leaseToken,
        relKey: `${task.grant.prefix}artifact.json`,
        op: "put",
      }),
    );
    expect(presignRes.status).toBe(200);
    const { url } = presignRes.json as { url: string };
    // URL must be an absolute http URL pointing at the blob endpoint.
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:9999\/blob\?u=/);
    // The mem:// url must be encoded in the query string.
    expect(url).toContain(encodeURIComponent("mem://put/"));
  });
});

describe("handleBrokerRequest — blob", () => {
  it("PUT then GET round-trips data through the object store via HTTP URLs", async () => {
    const { deps, broker } = makeSetup();
    await submitTask(broker);

    // Lease to get a grant.
    const leaseRes = await handleBrokerRequest(
      deps,
      req("POST", "/lease", {
        workerId: "w1",
        stageIds: ["heavy"],
        stageCodeVersion: "v1",
      }),
    );
    const task = leaseRes.json as {
      taskId: string;
      leaseToken: string;
      grant: { prefix: string };
    };

    // Presign a PUT.
    const presignRes = await handleBrokerRequest(
      deps,
      req("POST", "/presign", {
        taskId: task.taskId,
        leaseToken: task.leaseToken,
        relKey: `${task.grant.prefix}data.json`,
        op: "put",
      }),
    );
    const { url: putUrl } = presignRes.json as { url: string };

    // PUT via blob endpoint (simulate what the worker does over HTTP).
    const payload = { data: ["x", "y", "z"] };
    const putReq: IncomingRequest = {
      method: "PUT",
      path: `/blob?u=${new URL(putUrl).searchParams.get("u")}`,
      headers: {},
      body: payload,
    };
    const putRes = await handleBrokerRequest(deps, putReq);
    expect(putRes.status).toBe(200);

    // Presign a GET for the same key.
    const presignGetRes = await handleBrokerRequest(
      deps,
      req("POST", "/presign", {
        taskId: task.taskId,
        leaseToken: task.leaseToken,
        relKey: `${task.grant.prefix}data.json`,
        op: "get",
      }),
    );
    const { url: getUrl } = presignGetRes.json as { url: string };

    // GET via blob endpoint.
    const getReq: IncomingRequest = {
      method: "GET",
      path: `/blob?u=${new URL(getUrl).searchParams.get("u")}`,
      headers: {},
      body: null,
    };
    const getRes = await handleBrokerRequest(deps, getReq);
    expect(getRes.status).toBe(200);
    expect(getRes.json).toEqual(payload);
  });
});

describe("handleBrokerRequest — unknown route", () => {
  it("returns 404 for unknown paths", async () => {
    const { deps } = makeSetup();
    const res = await handleBrokerRequest(deps, req("GET", "/unknown"));
    expect(res.status).toBe(404);
  });
});
