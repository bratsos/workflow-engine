import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { Broker } from "../../broker/broker.js";
import type { InMemoryObjectStore } from "../../object-store.js";
import { ActivityReportSchema, LeaseRequestSchema } from "./schemas.js";

/** Returns true for absolute http/https URLs (S3, R2, MinIO). False for mem:// or relative. */
function isAbsoluteHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

export interface BrokerServerDeps {
  broker: Broker;
  objectStore: InMemoryObjectStore;
  /** Bearer token required on every request. If omitted, NO auth is enforced — dev/local use only. */
  authToken?: string;
  publicBaseUrl?: string;
}

export interface IncomingRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** Present when Content-Type is application/octet-stream; body will be null in that case. */
  rawBody?: Uint8Array;
}

export interface HandlerResponse {
  status: number;
  json?: unknown;
  /** If set, serve as application/octet-stream instead of JSON. */
  binary?: Uint8Array;
}

function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length check first (timingSafeEqual throws on length mismatch); leaking
  // length is acceptable.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Pure handler function — no node:http dependency. Routes incoming requests
 * to broker methods and returns a structured response. Unit-testable without
 * binding a real server port.
 */
export async function handleBrokerRequest(
  deps: BrokerServerDeps,
  req: IncomingRequest,
): Promise<HandlerResponse> {
  // Auth check: if a token is configured, require a matching Bearer header.
  if (deps.authToken !== undefined) {
    const authHeader = req.headers["authorization"];
    const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const provided = raw?.startsWith("Bearer ") ? raw.slice(7) : undefined;
    if (!tokensMatch(provided, deps.authToken)) {
      return { status: 401, json: { error: "unauthorized" } };
    }
  }

  const { method, path: reqPath } = req;

  // POST /lease
  if (method === "POST" && reqPath === "/lease") {
    const parsed = LeaseRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return {
        status: 400,
        json: { error: "invalid request", details: parsed.error.issues },
      };
    }
    try {
      const task = await deps.broker.lease(parsed.data);
      if (task === null) {
        return { status: 204 };
      }
      return { status: 200, json: task };
    } catch (err) {
      return {
        status: 409,
        json: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // POST /report
  if (method === "POST" && reqPath === "/report") {
    const parsed = ActivityReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return {
        status: 400,
        json: { error: "invalid request", details: parsed.error.issues },
      };
    }
    try {
      await deps.broker.report(parsed.data);
      return { status: 200, json: { ok: true } };
    } catch (err) {
      return {
        status: 409,
        json: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // POST /heartbeat
  if (method === "POST" && reqPath === "/heartbeat") {
    if (req.body === null || typeof req.body !== "object") {
      return { status: 400, json: { error: "invalid request body" } };
    }
    const body = req.body as { taskId?: string; leaseToken?: string };
    if (!body.taskId || !body.leaseToken) {
      return { status: 400, json: { error: "taskId and leaseToken required" } };
    }
    const result = await deps.broker.heartbeat({
      taskId: body.taskId,
      leaseToken: body.leaseToken,
    });
    return { status: 200, json: result };
  }

  // POST /presign
  if (method === "POST" && reqPath === "/presign") {
    if (req.body === null || typeof req.body !== "object") {
      return { status: 400, json: { error: "invalid request body" } };
    }
    const body = req.body as {
      taskId?: string;
      leaseToken?: string;
      relKey?: string;
      op?: string;
    };
    if (!body.taskId || !body.leaseToken || !body.relKey || !body.op) {
      return {
        status: 400,
        json: { error: "taskId, leaseToken, relKey and op required" },
      };
    }
    if (body.op !== "put" && body.op !== "get") {
      return { status: 400, json: { error: 'op must be "put" or "get"' } };
    }
    try {
      const presignResp = await deps.broker.presign({
        taskId: body.taskId,
        leaseToken: body.leaseToken,
        relKey: body.relKey,
        op: body.op,
      });
      // If the presigner returned an absolute http(s):// URL (S3/R2/MinIO), return
      // it as-is so the worker writes DIRECTLY to the object store (no /blob hop).
      // Only wrap mem:// urls in the /blob shim for the in-memory dev/test case.
      let blobUrl: string;
      if (isAbsoluteHttpUrl(presignResp.url)) {
        blobUrl = presignResp.url;
      } else if (deps.publicBaseUrl) {
        blobUrl = `${deps.publicBaseUrl}/blob?u=${encodeURIComponent(presignResp.url)}`;
      } else {
        // No publicBaseUrl was configured or derivable (e.g. handleBrokerRequest
        // called directly, outside createBrokerHttpServer's Host-header
        // derivation). Minting a portless "http://127.0.0.1" URL here would be
        // silently unusable — fail loudly instead.
        return {
          status: 500,
          json: {
            error:
              "publicBaseUrl is not configured; cannot construct a blob URL for a non-absolute presigned URL",
          },
        };
      }
      return { status: 200, json: { url: blobUrl } };
    } catch (err) {
      // Should-fix 2: expected broker rejections (fenced lease, deadline
      // exceeded, out-of-prefix) → 409 Conflict, consistent with /lease and
      // /report. A 500 is reserved for genuinely unexpected errors.
      return {
        status: 409,
        json: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // GET /blob?u=<memUrl>
  if (method === "GET" && reqPath.startsWith("/blob")) {
    const memUrl = extractBlobParam(reqPath);
    if (!memUrl) {
      return { status: 400, json: { error: "missing u= query param" } };
    }
    try {
      const data = await deps.objectStore.getViaUrl(memUrl);
      if (data instanceof Uint8Array) {
        return { status: 200, binary: data };
      }
      return { status: 200, json: data };
    } catch (err) {
      return {
        status: 400,
        json: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // PUT /blob?u=<memUrl>
  if (method === "PUT" && reqPath.startsWith("/blob")) {
    const memUrl = extractBlobParam(reqPath);
    if (!memUrl) {
      return { status: 400, json: { error: "missing u= query param" } };
    }
    try {
      const payload = req.rawBody !== undefined ? req.rawBody : req.body;
      await deps.objectStore.putViaUrl(memUrl, payload);
      return { status: 200, json: { ok: true } };
    } catch (err) {
      return {
        status: 400,
        json: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  return { status: 404, json: { error: "not found" } };
}

function extractBlobParam(reqPath: string): string | null {
  const qIdx = reqPath.indexOf("?");
  if (qIdx === -1) return null;
  const qs = reqPath.slice(qIdx + 1);
  const params = new URLSearchParams(qs);
  return params.get("u");
}

/**
 * Thin node:http wrapper around handleBrokerRequest. The returned server can
 * be used as:
 *   server.listen(0)   // ephemeral port (tests)
 *   server.listen(3000)
 */
export function createBrokerHttpServer(deps: BrokerServerDeps): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(deps, server, req, res);
  });
  return server;
}

async function handleRequest(
  deps: BrokerServerDeps,
  server: http.Server,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    // Collect request body.
    const bodyBuf = await readBody(req);
    const contentType = (req.headers["content-type"] ?? "").toString();
    const isBinaryRequest = contentType.startsWith("application/octet-stream");

    let body: unknown = null;
    let rawBody: Uint8Array | undefined;

    if (isBinaryRequest) {
      rawBody = new Uint8Array(bodyBuf);
    } else if (bodyBuf.length > 0) {
      try {
        body = JSON.parse(bodyBuf.toString("utf8"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
    }

    // Derive publicBaseUrl from Host header if not provided at construction.
    let resolvedDeps = deps;
    if (!deps.publicBaseUrl) {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const host = req.headers["host"] ?? `127.0.0.1:${addr.port}`;
        resolvedDeps = {
          ...deps,
          publicBaseUrl: `http://${host}`,
        };
      }
    }

    const incoming: IncomingRequest = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
      rawBody,
    };

    const result = await handleBrokerRequest(resolvedDeps, incoming);

    if (result.status === 204) {
      res.writeHead(204);
      res.end();
      return;
    }

    if (result.binary !== undefined) {
      res.writeHead(result.status, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(result.binary.byteLength),
      });
      res.end(result.binary);
      return;
    }

    const payload = JSON.stringify(result.json ?? null);
    res.writeHead(result.status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch (err) {
    const msg = JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(msg);
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
