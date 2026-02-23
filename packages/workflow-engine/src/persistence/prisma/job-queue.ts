/**
 * PrismaJobQueue - Prisma implementation of JobQueue
 *
 * Provides atomic job queue operations using PostgreSQL
 * with FOR UPDATE SKIP LOCKED for safe concurrent access.
 *
 * This is migrated from the original services/job-queue.server.ts
 */

import { createLogger } from "../../utils/logger";
import type { DequeueResult, EnqueueJobInput, JobQueue } from "../interface";
import { createEnumHelper, type PrismaEnumHelper } from "./enum-compat";
import type { DatabaseType } from "./persistence";

const logger = createLogger("JobQueue");

// Type for prisma client - using any for flexibility
type PrismaClient = any;

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
}

export class PrismaJobQueue implements JobQueue {
  private workerId: string;
  private prisma: PrismaClient;
  private enums: PrismaEnumHelper;
  private databaseType: DatabaseType;

  constructor(prisma: PrismaClient, options: PrismaJobQueueOptions = {}) {
    this.prisma = prisma;
    this.workerId = options.workerId || `worker-${process.pid}-${Date.now()}`;
    this.enums = createEnumHelper(prisma);
    this.databaseType = options.databaseType ?? "postgresql";
  }

  /**
   * Add a new job to the queue
   */
  async enqueue(options: EnqueueJobInput): Promise<string> {
    const job = await this.prisma.jobQueue.create({
      data: {
        workflowRunId: options.workflowRunId,
        stageId: options.stageId,
        priority: options.priority ?? 5,
        payload: { ...options.payload, _workflowId: options.workflowId } as unknown,
        status: this.enums.status("PENDING"),
        nextPollAt: options.scheduledFor,
      },
    });

    logger.debug(
      `Enqueued job ${job.id} for stage ${options.stageId} (run: ${options.workflowRunId})`,
    );
    return job.id;
  }

  /**
   * Enqueue multiple stages in parallel (same execution group)
   */
  async enqueueParallel(jobs: EnqueueJobInput[]): Promise<string[]> {
    if (jobs.length === 0) return [];

    const results = await this.prisma.$transaction(
      jobs.map((job) =>
        this.prisma.jobQueue.create({
          data: {
            workflowRunId: job.workflowRunId,
            stageId: job.stageId,
            priority: job.priority ?? 5,
            payload: { ...job.payload, _workflowId: job.workflowId } as unknown,
            status: this.enums.status("PENDING"),
          },
        }),
      ),
    );

    return results.map((r: { id: string }) => r.id);
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
    try {
      const result = await this.prisma.$queryRaw<
        Array<{
          id: string;
          workflowRunId: string;
          stageId: string;
          priority: number;
          attempt: number;
          maxAttempts: number;
          payload: unknown;
        }>
      >`
        UPDATE "job_queue"
        SET
          status = 'RUNNING',
          "workerId" = ${this.workerId},
          "lockedAt" = NOW(),
          "startedAt" = NOW(),
          attempt = attempt + 1
        WHERE id = (
          SELECT id FROM "job_queue"
          WHERE status = 'PENDING'
            AND ("nextPollAt" IS NULL OR "nextPollAt" <= NOW())
          ORDER BY priority DESC, "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, "workflowRunId", "stageId", priority, attempt, "maxAttempts", payload
      `;

      if (result.length === 0) {
        return null;
      }

      const job = result[0];
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
      };
    } catch (error) {
      logger.error("Error dequeuing job:", error);
      return null;
    }
  }

  /**
   * SQLite implementation using optimistic locking.
   * SQLite doesn't support FOR UPDATE SKIP LOCKED, so we use a two-step approach:
   * 1. Find a PENDING job
   * 2. Atomically update it (only succeeds if still PENDING)
   * 3. If another worker claimed it, retry
   */
  private async dequeueSqlite(): Promise<DequeueResult | null> {
    try {
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
        // Another worker claimed it, retry
        return this.dequeueSqlite();
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
      };
    } catch (error) {
      logger.error("Error dequeuing job:", error);
      return null;
    }
  }

  /**
   * Mark job as completed
   */
  async complete(jobId: string): Promise<void> {
    await this.prisma.jobQueue.update({
      where: { id: jobId },
      data: {
        status: this.enums.status("COMPLETED"),
        completedAt: new Date(),
      },
    });
    logger.debug(`Job ${jobId} completed`);
  }

  /**
   * Mark job as suspended (for async-batch)
   */
  async suspend(jobId: string, nextPollAt: Date): Promise<void> {
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
  }

  /**
   * Mark job as failed
   */
  async fail(
    jobId: string,
    error: string,
    shouldRetry: boolean = false,
  ): Promise<void> {
    const job = await this.prisma.jobQueue.findUnique({
      where: { id: jobId },
      select: { attempt: true, maxAttempts: true },
    });

    if (shouldRetry && job && job.attempt < job.maxAttempts) {
      // Re-queue for retry with exponential backoff
      const backoffMs = 2 ** job.attempt * 1000; // 2s, 4s, 8s...
      const nextPollAt = new Date(Date.now() + backoffMs);

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
    } else {
      await this.prisma.jobQueue.update({
        where: { id: jobId },
        data: {
          status: this.enums.status("FAILED"),
          completedAt: new Date(),
          lastError: error,
        },
      });
      logger.debug(`Job ${jobId} failed permanently: ${error}`);
    }
  }

  /**
   * Get suspended jobs that are ready to be checked
   */
  async getSuspendedJobsReadyToPoll(): Promise<
    Array<{ jobId: string; stageId: string; workflowRunId: string }>
  > {
    const jobs = await this.prisma.jobQueue.findMany({
      where: {
        status: this.enums.status("SUSPENDED"),
        nextPollAt: { lte: new Date() },
      },
      select: {
        id: true,
        workflowRunId: true,
        stageId: true,
      },
    });

    return jobs.map(
      (j: { id: string; workflowRunId: string; stageId: string }) => ({
        jobId: j.id,
        workflowRunId: j.workflowRunId,
        stageId: j.stageId,
      }),
    );
  }

  /**
   * Release stale locks (for crashed workers)
   */
  async releaseStaleJobs(staleThresholdMs: number = 300000): Promise<number> {
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
      },
    });

    if (result.count > 0) {
      logger.debug(
        `Released ${result.count} stale jobs (locked before ${thresholdDate.toISOString()})`,
      );
    }

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
