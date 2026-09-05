import { ConsoleBadRequestError } from "./errors";
import {
  ALL_CAPABILITIES,
  type AnnotationSummary,
  CONSOLE_STATUSES,
  type ConsoleCapabilities,
  type ConsoleReadPort,
  type ConsoleStatus,
  type CostBucket,
  type CostQuery,
  clampLimit,
  type DeadLetter,
  decodeCursor,
  encodeCursor,
  type LogEntry,
  type QueueHealth,
  type RunDetail,
  type RunDetailOptions,
  type RunEvent,
  type RunListPage,
  type RunListQuery,
  type RunSummary,
  type StageSummary,
  type StepSummary,
  type SuspendedStage,
  type WorkerInstance,
} from "./read-port";

/** Mutable fixture store. Every array defaults to empty. */
export interface ConsoleFixtures {
  runs?: Array<
    Omit<RunSummary, "definitionVersion" | "redriveCount"> & {
      definitionVersion?: string | null;
      redriveCount?: number;
      input?: unknown;
      output?: unknown;
      config?: unknown;
      metadata?: unknown;
    }
  >;
  stages?: StageSummary[];
  steps?: StepSummary[];
  annotations?: AnnotationSummary[];
  logs?: LogEntry[];
  events?: RunEvent[];
  /** job_queue rows, reduced to what the console reads off them. */
  jobs?: Array<{
    id: string;
    workflowRunId: string;
    stageId: string;
    status: ConsoleStatus;
    createdAt: Date;
    workerId?: string | null;
    lockedAt?: Date | null;
    nextPollAt?: Date | null;
  }>;
}

export interface InMemoryConsoleReadPortOptions {
  now?: () => Date;
  capabilities?: Partial<ConsoleCapabilities>;
}

type FixtureRun = NonNullable<ConsoleFixtures["runs"]>[number];

function toRunSummary(run: FixtureRun): RunSummary {
  return {
    id: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    workflowType: run.workflowType,
    status: run.status,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    duration: run.duration ?? null,
    totalCost: run.totalCost ?? 0,
    totalTokens: run.totalTokens ?? 0,
    priority: run.priority ?? 0,
    definitionVersion: run.definitionVersion ?? null,
    redriveCount: run.redriveCount ?? 0,
  };
}

export class InMemoryConsoleReadPort implements ConsoleReadPort {
  readonly capabilities: ConsoleCapabilities;
  readonly fixtures: Required<ConsoleFixtures>;
  private readonly now: () => Date;

  constructor(
    fixtures?: ConsoleFixtures,
    options?: InMemoryConsoleReadPortOptions,
  ) {
    this.fixtures = {
      runs: fixtures?.runs ?? [],
      stages: fixtures?.stages ?? [],
      steps: fixtures?.steps ?? [],
      annotations: fixtures?.annotations ?? [],
      logs: fixtures?.logs ?? [],
      events: fixtures?.events ?? [],
      jobs: fixtures?.jobs ?? [],
    };
    this.capabilities = {
      ...ALL_CAPABILITIES,
      ...options?.capabilities,
    };
    this.now = options?.now ?? (() => new Date());
  }

  async listRuns(query: RunListQuery): Promise<RunListPage> {
    const sorted = [...this.fixtures.runs].sort((a, b) => {
      const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });

    let cursor: { createdAt: Date; id: string } | null = null;
    if (query.cursor !== undefined && query.cursor !== "") {
      cursor = decodeCursor(query.cursor);
      if (cursor === null) {
        throw new ConsoleBadRequestError("Invalid cursor.");
      }
    }

    const statuses = query.filters?.status;
    const workflowId = query.filters?.workflowId;
    const workflowType = query.filters?.workflowType;
    const definitionVersion = query.filters?.definitionVersion;
    const createdAfter = query.filters?.createdAfter;
    const createdBefore = query.filters?.createdBefore;

    const matched = sorted.filter((run) => {
      if (cursor !== null) {
        // In SQL: ("createdAt", id) < (cursor.createdAt, cursor.id). Drop runs not strictly less.
        const runTime = run.createdAt.getTime();
        const cursorTime = cursor.createdAt.getTime();
        if (runTime > cursorTime) return false;
        if (runTime === cursorTime && !(run.id < cursor.id)) return false;
      }

      if (
        statuses !== undefined &&
        statuses.length > 0 &&
        !statuses.includes(run.status)
      ) {
        return false;
      }
      if (workflowId !== undefined && run.workflowId !== workflowId) {
        return false;
      }
      if (workflowType !== undefined && run.workflowType !== workflowType) {
        return false;
      }
      if (
        definitionVersion !== undefined &&
        run.definitionVersion !== definitionVersion
      ) {
        return false;
      }
      if (
        createdAfter !== undefined &&
        run.createdAt.getTime() < createdAfter.getTime()
      ) {
        return false;
      }
      if (
        createdBefore !== undefined &&
        run.createdAt.getTime() >= createdBefore.getTime()
      ) {
        return false;
      }

      return true;
    });

    const limit = clampLimit(query.limit);
    const hasNextPage = matched.length > limit;
    const returnedRuns = hasNextPage ? matched.slice(0, limit) : matched;
    const runs = returnedRuns.map(toRunSummary);

    const last = runs.at(-1);
    const nextCursor =
      hasNextPage && last !== undefined
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null;

    return { runs, nextCursor };
  }

  async getRunDetail(
    runId: string,
    options?: RunDetailOptions,
  ): Promise<RunDetail | null> {
    const rawRun = this.fixtures.runs.find((r) => r.id === runId);
    if (!rawRun) return null;

    const stages = this.fixtures.stages
      .filter((stage) => stage.workflowRunId === runId)
      .slice()
      .sort((a, b) => {
        if (a.stageNumber !== b.stageNumber) {
          return a.stageNumber - b.stageNumber;
        }
        return a.stageId < b.stageId ? -1 : a.stageId > b.stageId ? 1 : 0;
      });

    const stageNumberById = new Map<string, number>();
    for (const stage of stages) {
      stageNumberById.set(stage.id, stage.stageNumber);
    }

    const stepLimit = clampLimit(options?.stepLimit, 200);
    const matchingSteps = this.fixtures.steps
      .filter((step) => stageNumberById.has(step.stageRecordId))
      .slice()
      .sort((a, b) => {
        const stageNumA = stageNumberById.get(a.stageRecordId)!;
        const stageNumB = stageNumberById.get(b.stageRecordId)!;
        if (stageNumA !== stageNumB) {
          return stageNumA - stageNumB;
        }
        return a.seq - b.seq;
      });

    const annotationLimit = clampLimit(options?.annotationLimit, 200);
    const matchingAnnotations = this.fixtures.annotations
      .filter((ann) => ann.workflowRunId === runId)
      .slice()
      .sort((a, b) => {
        const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });

    const logLimit = clampLimit(options?.logLimit, 200);
    const matchingLogs = this.fixtures.logs
      .filter((log) => log.workflowRunId === runId)
      .slice()
      .sort((a, b) => {
        const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });

    const eventLimit = clampLimit(options?.eventLimit, 200);
    const matchingEvents = this.fixtures.events
      .filter((evt) => evt.workflowRunId === runId)
      .slice()
      .sort((a, b) => a.sequence - b.sequence);

    const steps = matchingSteps.slice(0, stepLimit);
    const annotations = matchingAnnotations.slice(0, annotationLimit);
    const logs = matchingLogs.slice(0, logLimit);
    const events = matchingEvents.slice(0, eventLimit);

    const truncated = {
      steps: matchingSteps.length > stepLimit,
      annotations: matchingAnnotations.length > annotationLimit,
      logs: matchingLogs.length > logLimit,
      events: matchingEvents.length > eventLimit,
    };

    const run = {
      ...toRunSummary(rawRun),
      input: rawRun.input ?? null,
      output: rawRun.output ?? null,
      config: rawRun.config ?? null,
      metadata: rawRun.metadata ?? null,
    };

    return {
      run,
      stages,
      steps,
      annotations,
      logs,
      events,
      truncated,
    };
  }

  async listRunEvents(
    runId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<RunEvent[]> {
    const clampedLimit = clampLimit(limit, 200);
    const floorSeq = Math.floor(afterSequence);
    return this.fixtures.events
      .filter((evt) => evt.workflowRunId === runId && evt.sequence > floorSeq)
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, clampedLimit);
  }

  async getQueueHealth(): Promise<QueueHealth> {
    const countsByStatus = Object.fromEntries(
      CONSOLE_STATUSES.map((status) => [status, 0]),
    ) as Record<ConsoleStatus, number>;

    let oldestPendingAt: Date | null = null;
    let oldestLeaseAt: Date | null = null;
    let overduePolls = 0;
    const nowTime = this.now().getTime();

    for (const job of this.fixtures.jobs) {
      if (job.status in countsByStatus) {
        countsByStatus[job.status] += 1;
      }
      if (job.status === "PENDING") {
        if (
          oldestPendingAt === null ||
          job.createdAt.getTime() < oldestPendingAt.getTime()
        ) {
          oldestPendingAt = job.createdAt;
        }
      } else if (job.status === "RUNNING") {
        if (job.lockedAt != null) {
          if (
            oldestLeaseAt === null ||
            job.lockedAt.getTime() < oldestLeaseAt.getTime()
          ) {
            oldestLeaseAt = job.lockedAt;
          }
        }
      } else if (job.status === "SUSPENDED") {
        if (job.nextPollAt != null && job.nextPollAt.getTime() <= nowTime) {
          overduePolls += 1;
        }
      }
    }

    return {
      countsByStatus,
      oldestPendingAt,
      oldestLeaseAt,
      overduePolls,
    };
  }

  async listSuspendedStages(limit?: number): Promise<SuspendedStage[]> {
    const clampedLimit = clampLimit(limit, 50);

    const runById = new Map<string, string>();
    for (const run of this.fixtures.runs) {
      runById.set(run.id, run.workflowId);
    }

    const matching: SuspendedStage[] = [];
    for (const stage of this.fixtures.stages) {
      if (stage.status !== "SUSPENDED" || stage.nextPollAt == null) {
        continue;
      }
      // Mirror the SQL INNER JOIN: skip stages whose parent run is not in fixtures.
      const workflowId = runById.get(stage.workflowRunId);
      if (workflowId === undefined) {
        continue;
      }
      matching.push({
        id: stage.id,
        workflowRunId: stage.workflowRunId,
        workflowId,
        stageId: stage.stageId,
        stageName: stage.stageName,
        attempt: stage.attempt,
        nextPollAt: stage.nextPollAt,
        pollInterval: stage.pollInterval ?? null,
        maxWaitUntil: stage.maxWaitUntil ?? null,
      });
    }

    matching.sort((a, b) => a.nextPollAt!.getTime() - b.nextPollAt!.getTime());

    return matching.slice(0, clampedLimit);
  }

  async listDeadLetters(limit?: number): Promise<DeadLetter[]> {
    const clampedLimit = clampLimit(limit, 50);
    return this.fixtures.events
      .filter((evt) => evt.dlqAt != null)
      .slice()
      .sort((a, b) => b.dlqAt!.getTime() - a.dlqAt!.getTime())
      .slice(0, clampedLimit)
      .map((evt) => ({
        id: evt.id,
        workflowRunId: evt.workflowRunId,
        sequence: evt.sequence,
        eventType: evt.eventType,
        retryCount: evt.retryCount,
        occurredAt: evt.occurredAt,
        dlqAt: evt.dlqAt,
      }));
  }

  async listWorkers(): Promise<WorkerInstance[]> {
    interface WorkerAccumulator {
      runningJobs: number;
      oldestLockedAt: Date | null;
      lastSeenAt: Date | null;
    }

    const groups = new Map<string, WorkerAccumulator>();

    for (const job of this.fixtures.jobs) {
      if (job.status !== "RUNNING" || job.workerId == null) {
        continue;
      }
      let acc = groups.get(job.workerId);
      if (!acc) {
        acc = {
          runningJobs: 0,
          oldestLockedAt: null,
          lastSeenAt: null,
        };
        groups.set(job.workerId, acc);
      }
      acc.runningJobs += 1;
      if (job.lockedAt != null) {
        const lockedTime = job.lockedAt.getTime();
        if (
          acc.oldestLockedAt === null ||
          lockedTime < acc.oldestLockedAt.getTime()
        ) {
          acc.oldestLockedAt = job.lockedAt;
        }
        if (acc.lastSeenAt === null || lockedTime > acc.lastSeenAt.getTime()) {
          acc.lastSeenAt = job.lockedAt;
        }
      }
    }

    const workerIds = Array.from(groups.keys()).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );

    return workerIds.map((workerId) => {
      const acc = groups.get(workerId)!;
      return {
        workerId,
        runningJobs: acc.runningJobs,
        oldestLockedAt: acc.oldestLockedAt,
        lastSeenAt: acc.lastSeenAt,
      };
    });
  }

  async getCosts(query: CostQuery): Promise<CostBucket[]> {
    const now = this.now();
    const to = query.to ?? now;
    const defaultDays = query.by === "workflow" ? 7 : 30;
    const from =
      query.from ?? new Date(now.getTime() - defaultDays * 24 * 60 * 60 * 1000);

    const fromTime = from.getTime();
    const toTime = to.getTime();

    const filtered = this.fixtures.runs.filter((run) => {
      const runTime = run.createdAt.getTime();
      return runTime >= fromTime && runTime < toTime;
    });

    interface CostAccumulator {
      runs: number;
      cost: number;
      tokens: number;
    }

    if (query.by === "workflow") {
      const groups = new Map<string, CostAccumulator>();
      for (const run of filtered) {
        let acc = groups.get(run.workflowId);
        if (!acc) {
          acc = { runs: 0, cost: 0, tokens: 0 };
          groups.set(run.workflowId, acc);
        }
        acc.runs += 1;
        acc.cost += run.totalCost ?? 0;
        acc.tokens += run.totalTokens ?? 0;
      }

      const buckets: CostBucket[] = Array.from(groups.entries()).map(
        ([key, acc]) => ({
          key,
          runs: acc.runs,
          cost: acc.cost,
          tokens: acc.tokens,
        }),
      );

      buckets.sort((a, b) => b.cost - a.cost);
      return buckets;
    } else {
      const groups = new Map<string, CostAccumulator>();
      for (const run of filtered) {
        // Matches Postgres to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') on UTC timestamps.
        const key = run.createdAt.toISOString().slice(0, 10);
        let acc = groups.get(key);
        if (!acc) {
          acc = { runs: 0, cost: 0, tokens: 0 };
          groups.set(key, acc);
        }
        acc.runs += 1;
        acc.cost += run.totalCost ?? 0;
        acc.tokens += run.totalTokens ?? 0;
      }

      const buckets: CostBucket[] = Array.from(groups.entries()).map(
        ([key, acc]) => ({
          key,
          runs: acc.runs,
          cost: acc.cost,
          tokens: acc.tokens,
        }),
      );

      buckets.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
      return buckets;
    }
  }
}

export function createInMemoryConsoleReadPort(
  fixtures?: ConsoleFixtures,
  options?: InMemoryConsoleReadPortOptions,
): InMemoryConsoleReadPort {
  return new InMemoryConsoleReadPort(fixtures, options);
}
