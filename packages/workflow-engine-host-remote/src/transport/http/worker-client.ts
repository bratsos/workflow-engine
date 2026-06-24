import type {
  ActivityReport,
  ActivityTask,
  HeartbeatRequest,
  HeartbeatResponse,
  LeaseRequest,
  PresignRequest,
  PresignResponse,
} from "../../protocol.js";
import type { WorkerTransport } from "../../transport.js";

export interface HttpWorkerTransportConfig {
  baseUrl: string;
  authToken?: string;
}

/**
 * WorkerTransport implementation that communicates with a remote broker over
 * HTTP. Uses the global `fetch` API (Node 22+). The broker server address is
 * given by `baseUrl` (e.g. "http://127.0.0.1:3000").
 */
export function createHttpWorkerTransport(
  cfg: HttpWorkerTransportConfig,
): WorkerTransport {
  const { baseUrl, authToken } = cfg;

  function authHeaders(): Record<string, string> {
    if (authToken === undefined) return {};
    return { Authorization: `Bearer ${authToken}` };
  }

  /** Returns true only when the URL targets the broker itself (not an external presigned URL). */
  function isBrokerUrl(url: string): boolean {
    return url.startsWith(baseUrl);
  }

  return {
    async lease(req: LeaseRequest): Promise<ActivityTask | null> {
      const res = await fetch(`${baseUrl}/lease`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(req),
      });

      if (res.status === 204) return null;

      if (res.status === 409) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "lease conflict");
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `lease failed: ${res.status}`);
      }

      return (await res.json()) as ActivityTask;
    },

    async report(req: ActivityReport): Promise<void> {
      const res = await fetch(`${baseUrl}/report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(req),
      });

      if (res.status === 409) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "report conflict");
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `report failed: ${res.status}`);
      }
    },

    async heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
      const res = await fetch(`${baseUrl}/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(req),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `heartbeat failed: ${res.status}`);
      }

      return (await res.json()) as HeartbeatResponse;
    },

    async presign(req: PresignRequest): Promise<PresignResponse> {
      const res = await fetch(`${baseUrl}/presign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(req),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `presign failed: ${res.status}`);
      }

      return (await res.json()) as PresignResponse;
    },

    async putBytes(url: string, data: unknown): Promise<void> {
      const isBinary =
        data instanceof Uint8Array || data instanceof ArrayBuffer;
      const headers: Record<string, string> = {
        "Content-Type": isBinary
          ? "application/octet-stream"
          : "application/json",
        ...(isBrokerUrl(url) ? authHeaders() : {}),
      };
      const body = isBinary
        ? data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data
        : JSON.stringify(data);
      const res = await fetch(url, {
        method: "PUT",
        headers,
        body,
      });

      if (!res.ok) {
        const body2 = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body2.error ?? `putBytes failed: ${res.status}`);
      }
    },

    async getBytes(url: string): Promise<unknown> {
      const headers: Record<string, string> = isBrokerUrl(url)
        ? authHeaders()
        : {};
      const res = await fetch(url, {
        method: "GET",
        headers,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `getBytes failed: ${res.status}`);
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.startsWith("application/octet-stream")) {
        return new Uint8Array(await res.arrayBuffer());
      }
      return res.json();
    },
  };
}
