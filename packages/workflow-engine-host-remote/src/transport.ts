import type { Broker } from "./broker/broker.js";
import type { InMemoryObjectStore } from "./object-store.js";
import type {
  ActivityReport,
  ActivityTask,
  HeartbeatRequest,
  HeartbeatResponse,
  LeaseRequest,
  PollResponse,
  PresignRequest,
  PresignResponse,
  SubmitRequest,
  SubmitResponse,
} from "./protocol.js";

export interface OrchestratorTransport {
  submit(req: SubmitRequest): Promise<SubmitResponse>;
  poll(taskId: string): Promise<PollResponse>;
}

export interface WorkerTransport {
  lease(req: LeaseRequest): Promise<ActivityTask | null>;
  report(req: ActivityReport): Promise<void>;
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  presign(req: PresignRequest): Promise<PresignResponse>;
  putBytes(url: string, data: unknown): Promise<void>;
  getBytes(url: string): Promise<unknown>;
}

/**
 * Wires both transports directly to one Broker + object store (no network) —
 * for tests and the in-process example. The HTTP adapter (follow-on) keeps the
 * same interfaces.
 */
export function createInProcessTransport(
  broker: Broker,
  objectStore: InMemoryObjectStore,
): { orchestrator: OrchestratorTransport; worker: WorkerTransport } {
  return {
    orchestrator: {
      submit: (req) => broker.submit(req),
      poll: (taskId) => broker.poll(taskId),
    },
    worker: {
      lease: (req) => broker.lease(req),
      report: (req) => broker.report(req),
      heartbeat: (req) => broker.heartbeat(req),
      presign: (req) => broker.presign(req),
      putBytes: (url, data) => objectStore.putViaUrl(url, data),
      getBytes: (url) => objectStore.getViaUrl(url),
    },
  };
}
