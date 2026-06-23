import type { ActivityReport } from "../protocol.js";

export type TaskStatus = "PENDING" | "ASSIGNED" | "REPORTED" | "FAILED";

export interface TaskPayload {
  input: unknown;
  config: unknown;
  resumeState?: unknown;
  workflowContext: Record<string, unknown>;
}

export interface TaskRecord {
  taskId: string;
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  status: TaskStatus;
  leaseToken: string | null;
  leasedAt: number | null;
  attempt: number;
  deadline: number; // epoch ms
  createdAt: number; // epoch ms
  payload: TaskPayload;
  report: ActivityReport | null;
  failureError: string | null;
}

export interface BrokerStore {
  create(rec: TaskRecord): Promise<void>;
  get(taskId: string): Promise<TaskRecord | null>;
  update(taskId: string, patch: Partial<TaskRecord>): Promise<void>;
  /** Atomically claim the oldest PENDING task whose stageId is in `stageIds`. */
  claimNext(
    stageIds: string[],
    leaseToken: string,
    now: number,
  ): Promise<TaskRecord | null>;
}

export class InMemoryBrokerStore implements BrokerStore {
  private readonly tasks = new Map<string, TaskRecord>();

  async create(rec: TaskRecord): Promise<void> {
    this.tasks.set(rec.taskId, { ...rec });
  }

  async get(taskId: string): Promise<TaskRecord | null> {
    const t = this.tasks.get(taskId);
    return t ? { ...t } : null;
  }

  async update(taskId: string, patch: Partial<TaskRecord>): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`task ${taskId} not found`);
    this.tasks.set(taskId, { ...t, ...patch });
  }

  async claimNext(
    stageIds: string[],
    leaseToken: string,
    now: number,
  ): Promise<TaskRecord | null> {
    const candidates = [...this.tasks.values()]
      .filter((t) => t.status === "PENDING" && stageIds.includes(t.stageId))
      .sort((a, b) => a.createdAt - b.createdAt);
    const next = candidates[0];
    if (!next) return null;
    const updated: TaskRecord = {
      ...next,
      status: "ASSIGNED",
      leaseToken,
      leasedAt: now,
      attempt: next.attempt + 1,
    };
    this.tasks.set(next.taskId, updated);
    return { ...updated };
  }
}
