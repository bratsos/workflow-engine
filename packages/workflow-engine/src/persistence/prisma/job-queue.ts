/**
 * PrismaJobQueue - Prisma implementation of JobQueue
 *
 * Provides atomic job queue operations using PostgreSQL
 * with FOR UPDATE SKIP LOCKED for safe concurrent access.
 *
 * This is migrated from the original services/job-queue.server.ts
 */

import { createLogger } from "../../utils/logger";
import {
  type DequeueResult,
  type EnqueueJobInput,
  type JobAckFence,
  type JobAckOutcome,
  type JobQueue,
  type JobRecord,
  LEASE_ABSOLUTE_CAP,
  LEASE_HEARTBEAT_LOST,
} from "../interface";
import { createEnumHelper, type PrismaEnumHelper } from "./enum-compat";
import type { DatabaseType } from "./persistence";
import type { EnginePrismaClient } from "./prisma-client-type";

const logger = createLogger("JobQueue");

/**
 * Bounds retry loops for optimistic-lock dequeue paths so heavy contention
 * degrades to "try again later" instead of unbounded recursion.
 */
const MAX_DEQUEUE_ATTEMPTS = 10;

// Structural client type -- see prisma-client-type.ts.
type PrismaClient = EnginePrismaClient;

export interface PrismaJobQueueOptions {
  /**
   * Unique worker identifier. Defaults to auto-generated ID.
   */
  workerId?: string;
  /**
   * Database type. Defaults to "postgresql".
   * Set to "sqlite" when using SQLite (uses optimistic locking instead of FOR UPDATE SKIP LOCKED).
   */
  databaseType?: DatabaseType;
  /**
   * Time source for deterministic tests.
   *
   * Does not affect PostgreSQL lease timestamps (`lockedAt`, `startedAt`),
   * which are derived directly from the database clock. It remains the time
   * source for the SQLite dequeue path and for timestamps written outside the
   * raw statement (such as dead-job acknowledgements). Defaults to
   * `() => new Date()`.
   */
  now?: () => Date;
}

export class PrismaJobQueue implements JobQueue {
  private workerId: string;
  /**
   * Whether `workerId` came from the caller. A generated id is a
   * placeholder the host is allowed to replace through `adoptWorkerId`;
   * one the caller chose is not.
   */
  private readonly workerIdWasConfigured: boolean;
  private prisma: PrismaClient;
  private enums: PrismaEnumHelper;
  private databaseType: DatabaseType;

  private readonly now: () => Date;

  constructor(prisma: PrismaClient, options: PrismaJobQueueOptions = {}) {
    this.prisma = prisma;
    this.workerIdWasConfigured = Boolean(options.workerId);
    this.workerId = options.workerId || `worker-${process.pid}-${Date.now()}`;
    this.enums = createEnumHelper(prisma);
    this.databaseType = options.databaseType ?? "postgresql";
    this.now = options.now ?? (() => new Date());
  }

  /** The `create` args for one enqueued job. */
  private enqueueData(job: EnqueueJobInput) {
    return {
      workflowRunId: job.workflowRunId,
      stageId: job.stageId,
      priority: job.priority ?? 5,
      payload: {
        ...job.payload,
        _workflowId: job.workflowId,
      } as unknown,
      status: this.enums.status("PENDING"),
      nextPollAt: job.scheduledFor ?? null,
    };
  }

  /**
   * `deleteMany` filter matching every existing row for the
   * `(workflowRunId, stageId)` pairs being enqueued. Delete-then-insert
   * (rather than a Prisma `upsert` on a compound unique) is what makes
   * the enqueue idempotent on *any* schema: a consumer whose `job_queue`
   * predates the `@@unique([workflowRunId, stageId])` this package's
   * reference schema now declares has no `workflowRunId_stageId`
   * selector for `upsert` to target, and may already carry duplicate
   * rows for a stage — which this collapses to exactly one. The new row
   * gets a new `id`; nothing outside an in-flight host holds a job id.
   */
  private enqueueDeleteFilter(jobs: EnqueueJobInput[]) {
    return {
      where: {
        OR: jobs.map((job) => ({
          workflowRunId: job.workflowRunId,
          stageId: job.stageId,
        })),
      },
    };
  }

  /**
   * Take the host's worker id unless this queue was constructed with one
   * of its own; returns the id it will stamp on `job_queue.workerId`.
   */
  adoptWorkerId(workerId: string): string {
    if (!this.workerIdWasConfigured) this.workerId = workerId;
    return this.workerId;
  }

  /** The id this queue stamps on the jobs it claims. */
  getWorkerId(): string {
    return this.workerId;
  }

  /**
   * Add a job to the queue, replacing any row already queued for the same
   * `(workflowRunId, stageId)` — see the `JobQueue.enqueueParallel`
   * contract.
   */
  async enqueue(options: EnqueueJobInput): Promise<string> {
    const [id] = await this.enqueueParallel([options]);
    return id!;
  }

  /**
   * Enqueue multiple stages in parallel (same execution group).
   *
   * Idempotent on `(workflowRunId, stageId)`: rows already queued for
   * those pairs are removed in the same transaction as the insert, so a
   * `run.rerunFrom` re-enqueue or a `run.reapStuck` recovery sweep over a
   * stage that still carries its previous (terminal) job row leaves
   * exactly one PENDING row with `attempt` back at 0.
   */
  async enqueueParallel(jobs: EnqueueJobInput[]): Promise<string[]> {
    if (jobs.length === 0) return [];

    // NOTE: deliberately calling `this.prisma.$transaction` directly
    // below rather than destructuring it into a local first -- Prisma's
    // runtime reads internal state off `this` inside its own method
    // bodies, so an unbound reference throws at call time ("Cannot read
    // properties of undefined").
    if (!this.prisma.$transaction) {
      throw new Error(
        "Prisma client does not support $transaction (required for enqueueParallel)",
      );
    }

    const results = await this.prisma.$transaction([
      this.prisma.jobQueue.deleteMany(this.enqueueDeleteFilter(jobs)),
      ...jobs.map((job) =>
        this.prisma.jobQueue.create({ data: this.enqueueData(job) }),
      ),
    ]);

    // results[0] is the deleteMany BatchPayload; the creates follow in order.
    const created = (results as Array<{ id: string }>).slice(1);
    return created.map((r) => r.id);
  }

  /**
   * Remove every job row for the given stages of a run, whatever their
   * status.
   */
  async deleteByRunAndStages(
    workflowRunId: string,
    stageIds: string[],
  ): Promise<number> {
    if (stageIds.length === 0) return 0;

    const result = await this.prisma.jobQueue.deleteMany({
      where: { workflowRunId, stageId: { in: stageIds } },
    });

    if (result.count > 0) {
      logger.debug(
        `Deleted ${result.count} job row(s) for run ${workflowRunId} stages [${stageIds.join(", ")}]`,
      );
    }
    return result.count;
  }

  /**
   * Atomically dequeue the next available job
   * Uses FOR UPDATE SKIP LOCKED (PostgreSQL) or optimistic locking (SQLite)
   */
  async dequeue(): Promise<DequeueResult | null> {
    if (this.databaseType === "sqlite") {
      return this.dequeueSqlite();
    }
    return this.dequeuePostgres();
  }

  /**
   * PostgreSQL implementation using FOR UPDATE SKIP LOCKED for safe concurrency
   */
  private async dequeuePostgres(): Promise<DequeueResult | null> {
    for (let i = 0; i < MAX_DEQUEUE_ATTEMPTS; i++) {
      const job = await this.dequeuePostgresOnce();
      if (job !== "dead") return job;
    }
    return null;
  }

  /** One claim; `"dead"` when the claimed row was failed as unexecutable. */
  private async dequeuePostgresOnce(): Promise<DequeueResult | null | "dead"> {
    try {
      // NOTE: deliberately calling `this.prisma.$queryRaw` directly below
      // rather than destructuring it into a local first -- Prisma's
      // runtime reads internal state off `this` inside its own method
      // bodies, so an unbound reference throws at call time ("Cannot read
      // properties of undefined").
      if (!this.prisma.$queryRaw) {
        throw new Error(
          "Prisma client does not support $queryRaw (required for the Postgres dequeue path)",
        );
      }
      // `now() AT TIME ZONE 'UTC'` renders the transaction's instant as the
      // naive UTC wall clock these `timestamp(3)` columns store, so it is
      // correct on any session timezone -- unlike a bare `NOW()`, which
      // converts through the session's zone (see utc-timestamps.ts).
      //
      // Using the database clock rather than a bound `Date` means the writer
      // of a lease and the sweeper that expires it are the same clock, so a
      // host whose system clock drifts can neither shorten nor extend a
      // lease. This is what pg-boss, Graphile Worker, River and Oban all do.
      //
      // `startedAt` comes back through `RETURNING` because it is the fence a
      // worker hands to `complete`/`fail`/`suspend`; the application no
      // longer knows the value it wrote.
      const result = await this.prisma.$queryRaw<
        Array<{
          id: string;
          workflowRunId: string;
          stageId: string;
          priority: number;
          attempt: number;
          maxAttempts: number;
          payload: unknown;
          startedAt: Date;
        }>
      >`
        UPDATE "job_queue"
        SET
          status = 'RUNNING',
          "workerId" = ${this.workerId},
          "lockedAt" = (now() AT TIME ZONE 'UTC'),
          "startedAt" = (now() AT TIME ZONE 'UTC'),
          attempt = attempt + 1
        WHERE id = (
          SELECT id FROM "job_queue"
          WHERE status = 'PENDING'
            AND ("nextPollAt" IS NULL
                 OR "nextPollAt" <= (now() AT TIME ZONE 'UTC'))
          ORDER BY priority DESC, "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, "workflowRunId", "stageId", priority, attempt, "maxAttempts", payload, "startedAt"
      `;

      if (result.length === 0) {
        return null;
      }

      const job = result[0];

      // A row whose payload is NULL or not an object (hand-inserted or
      // migrated) can never execute: fail and acknowledge it as a dead job
      // and take the next row, instead of throwing out of the dequeue and
      // aborting the whole tick on that one row.
      if (typeof job.payload !== "object" || job.payload === null) {
        const error = `Job ${job.id} has no payload (got ${job.payload === null ? "null" : typeof job.payload}); failed as a dead job`;
        logger.error(error);
        await this.prisma.jobQueue.update({
          where: { id: job.id },
          data: {
            status: this.enums.status("FAILED"),
            completedAt: this.now(),
            lastError: error,
            workerId: null,
            lockedAt: null,
          },
        });
        return "dead";
      }

      logger.debug(
        `Dequeued job ${job.id} (stage: ${job.stageId}, attempt: ${job.attempt})`,
      );

      const payload = job.payload as Record<string, unknown>;
      const { _workflowId, ...rest } = payload;
      return {
        jobId: job.id,
        workflowRunId: job.workflowRunId,
        workflowId: (_workflowId as string) ?? "",
        stageId: job.stageId,
        priority: job.priority,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        payload: rest,
        startedAt: job.startedAt,
      };
    } catch (error) {
      logger.error("Error dequeuing job:", error);
      // Rethrow rather than swallowing: a dead database must surface as
      // an error, not look like an indefinitely empty queue. Hosts
      // already treat dequeue failure as a non-fatal, back-off-and-retry
      // path (see NodeHost's job loop).
      throw error;
    }
  }

  /**
   * SQLite implementation using optimistic locking.
   * SQLite doesn't support FOR UPDATE SKIP LOCKED, so we use a two-step approach:
   * 1. Find a PENDING job
   * 2. Atomically update it (only succeeds if still PENDING)
   * 3. If another worker claimed it, retry
   */
  private async dequeueSqlite(attempt = 0): Promise<DequeueResult | null> {
    try {
      if (attempt >= MAX_DEQUEUE_ATTEMPTS) {
        return null;
      }

      const now = new Date();

      // Step 1: Find the next PENDING job
      const job = await this.prisma.jobQueue.findFirst({
        where: {
          status: this.enums.status("PENDING"),
          OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }],
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      });

      if (!job) {
        return null;
      }

      // Step 2: Atomically claim it (only succeeds if still PENDING)
      const result = await this.prisma.jobQueue.updateMany({
        where: {
          id: job.id,
          status: this.enums.status("PENDING"), // Optimistic lock
        },
        data: {
          status: this.enums.status("RUNNING"),
          workerId: this.workerId,
          lockedAt: now,
          startedAt: now,
          attempt: { increment: 1 },
        },
      });

      if (result.count === 0) {
        // Another worker claimed it, retry (bounded to avoid unbounded
        // recursion under heavy contention)
        return this.dequeueSqlite(attempt + 1);
      }

      // Fetch the updated job to get the new attempt count
      const claimedJob = await this.prisma.jobQueue.findUnique({
        where: { id: job.id },
      });

      if (!claimedJob) {
        return null;
      }

      logger.debug(
        `Dequeued job ${claimedJob.id} (stage: ${claimedJob.stageId}, attempt: ${claimedJob.attempt})`,
      );

      const claimedPayload = claimedJob.payload as Record<string, unknown>;
      const { _workflowId: claimedWfId, ...claimedRest } = claimedPayload;
      return {
        jobId: claimedJob.id,
        workflowRunId: claimedJob.workflowRunId,
        workflowId: (claimedWfId as string) ?? "",
        stageId: claimedJob.stageId,
        priority: claimedJob.priority,
        attempt: claimedJob.attempt,
        maxAttempts: claimedJob.maxAttempts,
        payload: claimedRest,
        startedAt: now,
      };
    } catch (error) {
      logger.error("Error dequeuing job:", error);
      throw error;
    }
  }

  /**
   * The fenced-acknowledgement predicate: this job, still RUNNING, still
   * on the attempt whose claim handed out `fence.startedAt` and
   * `fence.attempt`. `status` matters as much as the stamp —
   * `releaseStaleJobs` puts a rescued job back to PENDING without clearing
   * `startedAt`, so the stamp alone would still let a zombie worker
   * complete a job that is waiting to be re-claimed.
   */
  private fenceWhere(jobId: string, fence: JobAckFence) {
    return {
      id: jobId,
      status: this.enums.status("RUNNING"),
      startedAt: fence.startedAt,
      attempt: fence.attempt,
    };
  }

  private ackOutcome(jobId: string, count: number, op: string): JobAckOutcome {
    if (count === 0) {
      logger.warn(
        `Job ${jobId}: ${op} acknowledgement superseded — the job is no longer the RUNNING attempt this worker claimed`,
      );
      return "superseded";
    }
    return "acknowledged";
  }

  /**
   * Mark job as completed
   */
  async complete(jobId: string, fence?: JobAckFence): Promise<JobAckOutcome> {
    if (fence) {
      const result = await this.prisma.jobQueue.updateMany({
        where: this.fenceWhere(jobId, fence),
        data: {
          status: this.enums.status("COMPLETED"),
          completedAt: new Date(),
        },
      });
      return this.ackOutcome(jobId, result.count, "complete");
    }
    await this.prisma.jobQueue.update({
      where: { id: jobId },
      data: {
        status: this.enums.status("COMPLETED"),
        completedAt: new Date(),
      },
    });
    logger.debug(`Job ${jobId} completed`);
    return "acknowledged";
  }

  /**
   * Mark job as suspended (for async-batch)
   */
  async suspend(
    jobId: string,
    nextPollAt: Date,
    fence?: JobAckFence,
  ): Promise<JobAckOutcome> {
    if (fence) {
      const result = await this.prisma.jobQueue.updateMany({
        where: this.fenceWhere(jobId, fence),
        data: {
          status: this.enums.status("SUSPENDED"),
          nextPollAt,
          workerId: null,
          lockedAt: null,
        },
      });
      return this.ackOutcome(jobId, result.count, "suspend");
    }
    await this.prisma.jobQueue.update({
      where: { id: jobId },
      data: {
        status: this.enums.status("SUSPENDED"),
        nextPollAt,
        workerId: null,
        lockedAt: null,
      },
    });
    logger.debug(`Job ${jobId} suspended until ${nextPollAt.toISOString()}`);
    return "acknowledged";
  }

  /**
   * Mark job as failed
   */
  async fail(
    jobId: string,
    error: string,
    shouldRetry: boolean = false,
    fence?: JobAckFence,
  ): Promise<JobAckOutcome> {
    const job = await this.prisma.jobQueue.findUnique({
      where: { id: jobId },
      select: { attempt: true, maxAttempts: true },
    });

    if (shouldRetry && job && job.attempt < job.maxAttempts) {
      // Re-queue for retry with exponential backoff
      const backoffMs = 2 ** job.attempt * 1000; // 2s, 4s, 8s...
      const nextPollAt = new Date(Date.now() + backoffMs);

      if (fence) {
        const result = await this.prisma.jobQueue.updateMany({
          where: this.fenceWhere(jobId, fence),
          data: {
            status: this.enums.status("PENDING"),
            lastError: error,
            workerId: null,
            lockedAt: null,
            nextPollAt: nextPollAt,
          },
        });
        return this.ackOutcome(jobId, result.count, "fail");
      }

      await this.prisma.jobQueue.update({
        where: { id: jobId },
        data: {
          status: this.enums.status("PENDING"),
          lastError: error,
          workerId: null,
          lockedAt: null,
          nextPollAt: nextPollAt,
        },
      });
      logger.debug(`Job ${jobId} failed, will retry in ${backoffMs}ms`);
      return "acknowledged";
    } else {
      if (fence) {
        const result = await this.prisma.jobQueue.updateMany({
          where: this.fenceWhere(jobId, fence),
          data: {
            status: this.enums.status("FAILED"),
            completedAt: new Date(),
            lastError: error,
          },
        });
        return this.ackOutcome(jobId, result.count, "fail");
      }

      await this.prisma.jobQueue.update({
        where: { id: jobId },
        data: {
          status: this.enums.status("FAILED"),
          completedAt: new Date(),
          lastError: error,
        },
      });
      logger.debug(`Job ${jobId} failed permanently: ${error}`);
      return "acknowledged";
    }
  }

  /**
   * Cancel all pending/suspended jobs for a workflow run.
   */
  async cancelByRun(workflowRunId: string): Promise<number> {
    const result = await this.prisma.jobQueue.updateMany({
      where: {
        workflowRunId,
        status: {
          in: [this.enums.status("PENDING"), this.enums.status("SUSPENDED")],
        },
      },
      data: {
        status: this.enums.status("CANCELLED"),
        completedAt: new Date(),
      },
    });
    return result.count;
  }

  /**
   * Get all job rows for a workflow run (any status).
   */
  async getJobsByWorkflowRun(workflowRunId: string): Promise<JobRecord[]> {
    const jobs = await this.prisma.jobQueue.findMany({
      where: { workflowRunId },
    });

    return jobs.map((job: any) => {
      const payload = (job.payload ?? {}) as Record<string, unknown>;
      const { _workflowId, ...rest } = payload;
      return {
        id: job.id,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        workflowRunId: job.workflowRunId,
        workflowId: (_workflowId as string) ?? "",
        stageId: job.stageId,
        status: job.status,
        priority: job.priority,
        workerId: job.workerId,
        lockedAt: job.lockedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        lastError: job.lastError,
        nextPollAt: job.nextPollAt,
        payload: rest,
      } satisfies JobRecord;
    });
  }

  /**
   * Refresh a running job's lease without changing status.
   */
  async touchJob(jobId: string): Promise<void> {
    if (this.databaseType !== "sqlite" && this.prisma.$queryRaw) {
      // Renew the lease from the database clock: a heartbeat written from
      // the application clock while the sweeper reads the database clock
      // would reintroduce exactly the drift this change removes.
      await this.prisma.$queryRaw`
        UPDATE "job_queue"
        SET "lockedAt" = (now() AT TIME ZONE 'UTC'),
            "updatedAt" = (now() AT TIME ZONE 'UTC')
        WHERE id = ${jobId} AND status = 'RUNNING'
      `;
      return;
    }
    await this.prisma.jobQueue.updateMany({
      where: { id: jobId, status: this.enums.status("RUNNING") },
      data: { lockedAt: new Date() },
    });
  }

  /**
   * Release stale locks (for crashed workers). Stamps `lastError` with
   * the `LEASE_HEARTBEAT_LOST` prefix so an operator can tell a reclaimed
   * lease from a stage-level failure. The fine-grained tier of a two-tier
   * expiry whose coarse tier is `expireRunawayJobs`.
   *
   * On PostgreSQL, the deadline is derived in-database from the same `now()`
   * the claim stamped, so the sweep does not depend on the sweeping host's
   * system clock. `"updatedAt"` is set explicitly because a raw `UPDATE`
   * does not trigger Prisma's `@updatedAt`.
   *
   * SQLite has no `now() AT TIME ZONE`, so it keeps the application-clock
   * comparison (single-process by nature, where the two clocks are the
   * same clock anyway).
   */
  async releaseStaleJobs(staleThresholdMs: number = 300000): Promise<number> {
    const reason = `${LEASE_HEARTBEAT_LOST}: no heartbeat for more than ${staleThresholdMs}ms; lease released for another worker`;

    if (this.databaseType !== "sqlite" && this.prisma.$queryRaw) {
      // NOTE: deliberately calling `this.prisma.$queryRaw` directly rather
      // than destructuring it into a local first -- Prisma's runtime reads
      // internal state off `this` inside its own method bodies.
      const released = await this.prisma.$queryRaw<Array<{ id: string }>>`
        UPDATE "job_queue"
        SET
          status = 'PENDING',
          "workerId" = NULL,
          "lockedAt" = NULL,
          "updatedAt" = (now() AT TIME ZONE 'UTC'),
          "lastError" = ${reason}
        WHERE status = 'RUNNING'
          AND "lockedAt" IS NOT NULL
          AND "lockedAt" <
              (now() AT TIME ZONE 'UTC')
              - ${staleThresholdMs}::double precision * interval '1 millisecond'
        RETURNING id
      `;
      if (released.length > 0) {
        logger.debug(
          `Released ${released.length} stale job(s) (lease older than ${staleThresholdMs}ms by the database clock)`,
        );
      }
      return released.length;
    }

    const thresholdDate = new Date(Date.now() - staleThresholdMs);

    const result = await this.prisma.jobQueue.updateMany({
      where: {
        status: this.enums.status("RUNNING"),
        lockedAt: { lt: thresholdDate },
      },
      data: {
        status: this.enums.status("PENDING"),
        workerId: null,
        lockedAt: null,
        lastError: reason,
      },
    });

    if (result.count > 0) {
      logger.debug(
        `Released ${result.count} stale jobs (locked before ${thresholdDate.toISOString()})`,
      );
    }

    return result.count;
  }

  /**
   * Fail every RUNNING job whose claim has exceeded the coarse absolute cap.
   *
   * The coarse tier of a two-tier expiry: `releaseStaleJobs` handles the
   * fine-grained heartbeat signal and requeues for another worker when a
   * worker dies, but is defeated by a worker that is alive but wedged
   * (e.g. infinite loop or hung network call) because it keeps heartbeating.
   *
   * `startedAt` is the per-claim stamp that the heartbeat never touches
   * (a suspended job that resumes is re-claimed and gets a fresh `startedAt`,
   * so this measures one attempt's wall time, not the run's). A job past
   * this cap is failed terminally with `LEASE_ABSOLUTE_CAP` rather than
   * requeued, as a job that hung for the full cap will hang again.
   *
   * On PostgreSQL, the deadline is derived in-database for the same single-clock
   * reason the heartbeat sweep is. The run itself is resolved afterwards by
   * `run.reapStuck` on its next pass.
   */
  async expireRunawayJobs(absoluteTimeoutMs: number): Promise<number> {
    const reason = `${LEASE_ABSOLUTE_CAP}: held its lease for more than ${absoluteTimeoutMs}ms while still heartbeating; failed as a runaway`;

    if (this.databaseType !== "sqlite" && this.prisma.$queryRaw) {
      // NOTE: deliberately calling `this.prisma.$queryRaw` directly rather
      // than destructuring it into a local first -- Prisma's runtime reads
      // internal state off `this` inside its own method bodies.
      const expired = await this.prisma.$queryRaw<Array<{ id: string }>>`
        UPDATE "job_queue"
        SET
          status = 'FAILED',
          "completedAt" = (now() AT TIME ZONE 'UTC'),
          "updatedAt" = (now() AT TIME ZONE 'UTC'),
          "lastError" = ${reason}
        WHERE status = 'RUNNING'
          AND "startedAt" IS NOT NULL
          AND "startedAt" <
              (now() AT TIME ZONE 'UTC')
              - ${absoluteTimeoutMs}::double precision * interval '1 millisecond'
        RETURNING id
      `;
      if (expired.length > 0) {
        logger.warn(
          `Expired ${expired.length} runaway job(s) past the ${absoluteTimeoutMs}ms absolute lease cap`,
        );
      }
      return expired.length;
    }

    const cutoff = new Date(this.now().getTime() - absoluteTimeoutMs);
    const result = await this.prisma.jobQueue.updateMany({
      where: {
        status: this.enums.status("RUNNING"),
        startedAt: { not: null, lt: cutoff },
      },
      data: {
        status: this.enums.status("FAILED"),
        completedAt: this.now(),
        lastError: reason,
      },
    });
    return result.count;
  }
}

/**
 * Factory function to create PrismaJobQueue with prisma client
 *
 * @param prisma - Prisma client instance
 * @param optionsOrWorkerId - Options object or workerId string (for backwards compatibility)
 */
export function createPrismaJobQueue(
  prisma: PrismaClient,
  optionsOrWorkerId?: PrismaJobQueueOptions | string,
): JobQueue {
  // Handle backwards compatibility: if string is passed, treat as workerId
  const options: PrismaJobQueueOptions =
    typeof optionsOrWorkerId === "string"
      ? { workerId: optionsOrWorkerId }
      : (optionsOrWorkerId ?? {});

  return new PrismaJobQueue(prisma, options);
}
