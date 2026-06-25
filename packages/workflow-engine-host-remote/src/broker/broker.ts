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
  /**
   * Fix 3: Version-pinning (and the lease version gate) require BOTH the broker
   * AND the worker/proxy to set `stageCodeVersion`. If the broker leaves it
   * unset, version-pinning is disabled — the broker will accept any
   * `pinnedVersion` without mismatch checking and the lease gate is skipped.
   *
   * Note: if a submit request carries `req.pinnedVersion` but the broker has no
   * `stageCodeVersion`, the mismatch check is silently skipped (no failure).
   * This is the correct default behaviour — a broker without version config
   * should not reject tasks — but it means pinning is effectively disabled until
   * both sides are configured.
   */
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
    const taskId = req.taskId ?? this.generateId();
    const now = this.now();

    // Idempotent (Revision 2): task already exists (ANY status) — return the
    // existing record's deadline WITHOUT calling store.create. This prevents
    // two concurrent "unknown" re-registers from clobbering an ASSIGNED or
    // REPORTED task.
    const existing = await this.store.get(taskId);
    if (existing) {
      return {
        taskId,
        pollConfig: {
          pollInterval: req.pollInterval,
          maxWaitTime: req.maxWaitTime,
          nextPollAt: new Date(now + req.pollInterval),
        },
        deadlineAt: existing.deadline,
        stageCodeVersion: this.stageCodeVersion,
      };
    }

    // Absolute deadline (Revision 1): honour a caller-supplied deadlineAt so the
    // deadline is set ONCE at first submit and never reset on re-register.
    const deadline = req.deadlineAt ?? now + req.maxWaitTime;

    // A re-register may legitimately fail at create-time for two reasons:
    //  - Revision 4: the proxy pinned a version that no longer matches the
    //    broker's (a deploy changed stage code mid-suspension).
    //  - Revision 3: the original absolute deadline has already passed, so the
    //    task must NOT be re-queued for a worker — it goes straight to FAILED.
    // Version mismatch takes precedence as the more actionable cause.
    const versionMismatch =
      req.pinnedVersion !== undefined &&
      this.stageCodeVersion !== undefined &&
      req.pinnedVersion !== this.stageCodeVersion;
    const deadlinePassed = req.deadlineAt !== undefined && now > deadline;
    const createFailureError = versionMismatch
      ? "stage code version changed during suspension (deploy) — cannot safely resume"
      : deadlinePassed
        ? "remote activity deadline exceeded"
        : null;

    await this.store.create({
      taskId,
      workflowRunId: req.workflowRunId,
      stageId: req.stageId,
      stageName: req.stageName,
      stageNumber: req.stageNumber,
      status: createFailureError !== null ? "FAILED" : "PENDING",
      leaseToken: null,
      leasedAt: null,
      attempt: 0,
      deadline,
      createdAt: now,
      payload: {
        input: req.input,
        config: req.config,
        resumeState: req.resumeState,
        workflowContext: req.workflowContext,
      },
      report: null,
      failureError: createFailureError,
      artifactPrefix: req.artifactPrefix,
    });
    return {
      taskId,
      pollConfig: {
        pollInterval: req.pollInterval,
        maxWaitTime: req.maxWaitTime,
        nextPollAt: new Date(now + req.pollInterval),
      },
      deadlineAt: deadline,
      stageCodeVersion: this.stageCodeVersion,
    };
  }

  async lease(req: LeaseRequest): Promise<ActivityTask | null> {
    if (
      this.stageCodeVersion !== undefined &&
      req.stageCodeVersion !== this.stageCodeVersion
    ) {
      throw new Error(
        `stage code version mismatch: worker=${req.stageCodeVersion} broker=${this.stageCodeVersion}`,
      );
    }
    const leaseToken = this.generateId();
    const now = this.now();
    const task = await this.store.claimNext(req.stageIds, leaseToken, now);
    if (!task) return null;

    // Should-fix 1: a task claimed from the store may already be past its
    // deadline (e.g. it was PENDING but never picked up in time). A worker
    // should never start work that cannot be reported. Mark it FAILED
    // immediately and return null so the worker is not handed a dead task.
    // The next poll() / checkCompletion() will see the FAILED status.
    if (now > task.deadline) {
      const deadlineError = "remote activity deadline exceeded";
      await this.store.update(task.taskId, {
        status: "FAILED",
        leaseToken: null,
        leasedAt: null,
        failureError: deadlineError,
      });
      return null;
    }

    return this.toActivityTask(task);
  }

  async report(req: ActivityReport): Promise<void> {
    const task = await this.requireFencedTask(req.taskId, req.leaseToken);
    if (this.now() > task.deadline) {
      throw new Error("activity deadline exceeded");
    }
    await this.store.update(task.taskId, { status: "REPORTED", report: req });
  }

  /**
   * Refresh the lease timestamp so that a still-running, heartbeating worker is
   * NOT reaped by the stale-lease sweep in `poll()`. Each heartbeat resets
   * `leasedAt` to "now", giving the worker another full `staleLeaseMs` window
   * before the next sweep can release the lease.
   *
   * Invariant: the worker's `heartbeatMs` MUST be less than the broker's
   * `staleLeaseMs` (safe margin: heartbeatMs ≤ staleLeaseMs / 4) so that at
   * least one heartbeat fires within every stale-lease window.
   *
   * Note: heartbeats do NOT extend the absolute `deadlineAt`. The deadline is
   * set once at submit time and is unaffected by heartbeat activity.
   */
  async heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    const task = await this.store.get(req.taskId);
    if (
      !task ||
      task.leaseToken !== req.leaseToken ||
      task.status !== "ASSIGNED" ||
      this.now() > task.deadline
    ) {
      return { ok: false, cancel: true };
    }
    // Refresh leasedAt — prevents the stale-lease sweep from releasing this
    // lease while the worker is actively running and heartbeating.
    await this.store.update(task.taskId, { leasedAt: this.now() });
    return { ok: true, cancel: false };
  }

  async poll(taskId: string): Promise<PollResponse> {
    const task = await this.store.get(taskId);
    // Unknown (Revision 4 of state model): the broker has no record of this
    // task — typically because it restarted and lost its in-memory store. The
    // proxy treats "unknown" as a signal to re-register from the claim-checked
    // payload, rather than failing the run.
    if (!task)
      return { state: "unknown", logs: [], annotations: [], progress: [] };

    // deadline first — terminal
    if (task.status !== "REPORTED" && this.now() > task.deadline) {
      const deadlineError =
        task.failureError ?? "remote activity deadline exceeded";
      if (task.status !== "FAILED") {
        await this.store.update(taskId, {
          status: "FAILED",
          failureError: deadlineError,
        });
      }
      return {
        state: "failed",
        logs: [],
        annotations: [],
        progress: [],
        error: deadlineError,
      };
    }

    // stale lease → re-lease to PENDING (crash recovery)
    if (
      task.status === "ASSIGNED" &&
      task.leasedAt !== null &&
      this.now() - task.leasedAt > this.staleLeaseMs
    ) {
      await this.store.update(taskId, {
        status: "PENDING",
        leaseToken: null,
        leasedAt: null,
      });
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
      return {
        state: "failed",
        logs: [],
        annotations: [],
        progress: [],
        error: task.failureError ?? undefined,
      };
    }
    return {
      state: task.status === "ASSIGNED" ? "assigned" : "pending",
      logs: [],
      annotations: [],
      progress: [],
    };
  }

  async presign(req: PresignRequest): Promise<PresignResponse> {
    const task = await this.requireFencedTask(req.taskId, req.leaseToken);
    if (this.now() > task.deadline) {
      throw new Error("activity deadline exceeded");
    }
    const prefix = this.prefixFor(task);
    if (!req.relKey.startsWith(prefix)) {
      throw new Error(
        `presign key out of scope: ${req.relKey} not under prefix ${prefix}`,
      );
    }
    const ttl = Math.max(0, task.deadline - this.now());
    const url =
      req.op === "put"
        ? await this.presigner.presignPut(req.relKey, ttl)
        : await this.presigner.presignGet(req.relKey, ttl);
    return { url };
  }

  private async requireFencedTask(
    taskId: string,
    leaseToken: string,
  ): Promise<TaskRecord> {
    const task = await this.store.get(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.leaseToken !== leaseToken) {
      throw new Error(`lease fenced: token for ${taskId} is stale`);
    }
    if (task.status !== "ASSIGNED") {
      throw new Error(`task ${taskId} is not ASSIGNED (status=${task.status})`);
    }
    return task;
  }

  private prefixFor(task: TaskRecord): string {
    // Revision 5: prefer the proxy-supplied artifactPrefix (aligned with the
    // engine's stage storage key) so reruns reuse the same artifact namespace.
    return task.artifactPrefix !== undefined
      ? `${task.artifactPrefix}/${task.taskId}/`
      : `remote-activity/${task.workflowRunId}/${task.stageId}/${task.taskId}/`;
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
