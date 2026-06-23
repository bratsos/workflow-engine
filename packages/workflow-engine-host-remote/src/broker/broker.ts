import type { Clockish, ObjectStorePresigner } from "../object-store.js";
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
} from "../protocol.js";
import type { BrokerStore, TaskRecord } from "./store.js";

export interface BrokerConfig {
  store: BrokerStore;
  presigner: ObjectStorePresigner;
  clock: Clockish;
  staleLeaseMs?: number;
  stageCodeVersion?: string;
  generateId?: () => string;
}

export class Broker {
  private readonly store: BrokerStore;
  private readonly presigner: ObjectStorePresigner;
  private readonly clock: Clockish;
  private readonly staleLeaseMs: number;
  private readonly stageCodeVersion: string | undefined;
  private readonly generateId: () => string;

  constructor(cfg: BrokerConfig) {
    this.store = cfg.store;
    this.presigner = cfg.presigner;
    this.clock = cfg.clock;
    this.staleLeaseMs = cfg.staleLeaseMs ?? 60_000;
    this.stageCodeVersion = cfg.stageCodeVersion;
    this.generateId = cfg.generateId ?? (() => crypto.randomUUID());
  }

  private now(): number {
    return this.clock.now().getTime();
  }

  async submit(req: SubmitRequest): Promise<SubmitResponse> {
    const taskId = this.generateId();
    const now = this.now();
    await this.store.create({
      taskId,
      workflowRunId: req.workflowRunId,
      stageId: req.stageId,
      stageName: req.stageName,
      stageNumber: req.stageNumber,
      status: "PENDING",
      leaseToken: null,
      leasedAt: null,
      attempt: 0,
      deadline: now + req.maxWaitTime,
      createdAt: now,
      payload: {
        input: req.input,
        config: req.config,
        resumeState: req.resumeState,
        workflowContext: req.workflowContext,
      },
      report: null,
      failureError: null,
    });
    return {
      taskId,
      pollConfig: {
        pollInterval: req.pollInterval,
        maxWaitTime: req.maxWaitTime,
        nextPollAt: new Date(now + req.pollInterval),
      },
    };
  }

  async lease(req: LeaseRequest): Promise<ActivityTask | null> {
    if (this.stageCodeVersion !== undefined && req.stageCodeVersion !== this.stageCodeVersion) {
      throw new Error(
        `stage code version mismatch: worker=${req.stageCodeVersion} broker=${this.stageCodeVersion}`,
      );
    }
    const leaseToken = this.generateId();
    const task = await this.store.claimNext(req.stageIds, leaseToken, this.now());
    if (!task) return null;
    return this.toActivityTask(task);
  }

  async report(req: ActivityReport): Promise<void> {
    const task = await this.requireFencedTask(req.taskId, req.leaseToken);
    await this.store.update(task.taskId, { status: "REPORTED", report: req });
  }

  async heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    const task = await this.store.get(req.taskId);
    if (!task || task.leaseToken !== req.leaseToken || task.status !== "ASSIGNED") {
      return { ok: false, cancel: true };
    }
    await this.store.update(task.taskId, { leasedAt: this.now() });
    return { ok: true, cancel: false };
  }

  async poll(taskId: string): Promise<PollResponse> {
    const task = await this.store.get(taskId);
    if (!task) return { state: "failed", logs: [], annotations: [], progress: [] };

    // deadline first — terminal
    if (task.status !== "REPORTED" && this.now() > task.deadline) {
      if (task.status !== "FAILED") {
        await this.store.update(taskId, { status: "FAILED", failureError: "activity deadline exceeded" });
      }
      return { state: "failed", logs: [], annotations: [], progress: [] };
    }

    // stale lease → re-lease to PENDING (crash recovery)
    if (task.status === "ASSIGNED" && task.leasedAt !== null && this.now() - task.leasedAt > this.staleLeaseMs) {
      await this.store.update(taskId, { status: "PENDING", leaseToken: null, leasedAt: null });
      return { state: "pending", logs: [], annotations: [], progress: [] };
    }

    if (task.status === "REPORTED" && task.report) {
      const r = task.report;
      return {
        state: "reported",
        outcome: r.outcome,
        logs: r.logs,
        annotations: r.annotations,
        progress: r.progress,
      };
    }
    if (task.status === "FAILED") {
      return { state: "failed", logs: [], annotations: [], progress: [] };
    }
    return { state: task.status === "ASSIGNED" ? "assigned" : "pending", logs: [], annotations: [], progress: [] };
  }

  async presign(req: PresignRequest): Promise<PresignResponse> {
    const task = await this.requireFencedTask(req.taskId, req.leaseToken);
    const prefix = this.prefixFor(task);
    if (!req.relKey.startsWith(prefix)) {
      throw new Error(`presign key out of scope: ${req.relKey} not under prefix ${prefix}`);
    }
    const ttl = Math.max(0, task.deadline - this.now());
    const url =
      req.op === "put"
        ? await this.presigner.presignPut(req.relKey, ttl)
        : await this.presigner.presignGet(req.relKey, ttl);
    return { url };
  }

  private async requireFencedTask(taskId: string, leaseToken: string): Promise<TaskRecord> {
    const task = await this.store.get(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.leaseToken !== leaseToken) {
      throw new Error(`lease fenced: token for ${taskId} is stale`);
    }
    return task;
  }

  private prefixFor(task: TaskRecord): string {
    return `remote-activity/${task.workflowRunId}/${task.stageId}/${task.taskId}/`;
  }

  private toActivityTask(task: TaskRecord): ActivityTask {
    const prefix = this.prefixFor(task);
    return {
      taskId: task.taskId,
      leaseToken: task.leaseToken as string,
      workflowRunId: task.workflowRunId,
      stageId: task.stageId,
      stageName: task.stageName,
      stageNumber: task.stageNumber,
      attempt: task.attempt,
      input: task.payload.input,
      config: task.payload.config,
      resumeState: task.payload.resumeState,
      workflowContext: task.payload.workflowContext,
      grant: {
        prefix,
        expiresAt: new Date(task.deadline).toISOString(),
        presignEndpoint: "broker://presign",
      },
      deadline: new Date(task.deadline).toISOString(),
    };
  }
}
