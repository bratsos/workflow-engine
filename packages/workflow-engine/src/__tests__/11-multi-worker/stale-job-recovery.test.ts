/**
 * Stale Job Recovery Tests
 *
 * Tests for handling jobs that have been locked too long (timeout/stuck jobs).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";

describe("I want to recover stale jobs", () => {
  let jobQueue: InMemoryJobQueue;

  beforeEach(() => {
    jobQueue = new InMemoryJobQueue("worker-1");
  });

  describe("stale job detection", () => {
    it("should release jobs locked longer than threshold", async () => {
      // Given: A job that's been processing for a while
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // Dequeue to lock it
      await jobQueue.dequeue();

      // Manually set lockedAt to the past to simulate stale job
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("RUNNING");

      // Set lockedAt to 2 minutes ago
      jobQueue.setJobLockedAt(jobId, new Date(Date.now() - 120000));

      // When: I release stale jobs with 60s threshold
      const released = await jobQueue.releaseStaleJobs(60000);

      // Then: Job is released
      expect(released).toBe(1);

      const releasedJob = jobQueue.getJob(jobId);
      expect(releasedJob?.status).toBe("PENDING");
      expect(releasedJob?.workerId).toBeNull();
      expect(releasedJob?.lockedAt).toBeNull();
    });

    it("should not release jobs within threshold", async () => {
      // Given: A job that's been processing recently
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();

      // When: I release stale jobs (job was just locked)
      const released = await jobQueue.releaseStaleJobs(60000);

      // Then: Job is not released
      expect(released).toBe(0);

      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("RUNNING");
    });

    it("should use default threshold of 60 seconds", async () => {
      // Given: A job locked 30 seconds ago (within default threshold)
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();

      // Set lockedAt to 30 seconds ago
      jobQueue.setJobLockedAt(jobId, new Date(Date.now() - 30000));

      // When: I release stale jobs with default threshold
      const released = await jobQueue.releaseStaleJobs();

      // Then: Job is not released (within 60s threshold)
      expect(released).toBe(0);
    });
  });

  describe("multiple stale jobs", () => {
    it("should release multiple stale jobs at once", async () => {
      // Given: Multiple jobs that become stale
      const job1Id = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });
      const job2Id = await jobQueue.enqueue({
        workflowRunId: "run-2",
        stageId: "stage-2",
      });
      const job3Id = await jobQueue.enqueue({
        workflowRunId: "run-3",
        stageId: "stage-3",
      });

      // Lock all jobs
      await jobQueue.dequeue();
      await jobQueue.dequeue();
      await jobQueue.dequeue();

      // Make all stale
      const staleTime = new Date(Date.now() - 120000);
      jobQueue.setJobLockedAt(job1Id, staleTime);
      jobQueue.setJobLockedAt(job2Id, staleTime);
      jobQueue.setJobLockedAt(job3Id, staleTime);

      // When: I release stale jobs
      const released = await jobQueue.releaseStaleJobs(60000);

      // Then: All jobs are released
      expect(released).toBe(3);

      for (const jobId of [job1Id, job2Id, job3Id]) {
        const job = jobQueue.getJob(jobId);
        expect(job?.status).toBe("PENDING");
      }
    });

    it("should only release stale jobs, not recent ones", async () => {
      // Given: Mix of stale and fresh jobs
      const staleJobId = await jobQueue.enqueue({
        workflowRunId: "run-stale",
        stageId: "stage-1",
      });
      const freshJobId = await jobQueue.enqueue({
        workflowRunId: "run-fresh",
        stageId: "stage-2",
      });

      // Lock both
      await jobQueue.dequeue();
      await jobQueue.dequeue();

      // Make only one stale
      jobQueue.setJobLockedAt(staleJobId, new Date(Date.now() - 120000));

      // When: I release stale jobs
      const released = await jobQueue.releaseStaleJobs(60000);

      // Then: Only stale job is released
      expect(released).toBe(1);

      expect(jobQueue.getJob(staleJobId)?.status).toBe("PENDING");
      expect(jobQueue.getJob(freshJobId)?.status).toBe("RUNNING");
    });
  });

  describe("re-processing released jobs", () => {
    it("should allow released jobs to be dequeued again", async () => {
      // Given: A job that was released from stale state
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();

      // Make stale and release
      jobQueue.setJobLockedAt(jobId, new Date(Date.now() - 120000));
      await jobQueue.releaseStaleJobs(60000);

      // When: I dequeue again
      const result = await jobQueue.dequeue();

      // Then: Same job can be claimed again
      expect(result?.jobId).toBe(jobId);
      expect(result?.workflowRunId).toBe("run-1");
    });

    it("should preserve job data after release", async () => {
      // Given: A job with payload
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        priority: 8,
        payload: { config: { model: "test" } },
      });

      await jobQueue.dequeue();

      // Make stale and release
      jobQueue.setJobLockedAt(jobId, new Date(Date.now() - 120000));
      await jobQueue.releaseStaleJobs(60000);

      // When: Job is dequeued again
      const result = await jobQueue.dequeue();

      // Then: All original data is preserved
      expect(result?.priority).toBe(8);
      expect(result?.payload).toEqual({ config: { model: "test" } });
    });
  });

  describe("status-specific behavior", () => {
    it("should not affect PENDING jobs", async () => {
      // Given: A pending job
      await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: I release stale jobs
      const released = await jobQueue.releaseStaleJobs(0); // 0ms threshold

      // Then: No jobs released (pending jobs don't have locks)
      expect(released).toBe(0);
    });

    it("should not affect COMPLETED jobs", async () => {
      // Given: A completed job
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();
      await jobQueue.complete(jobId);

      // When: I release stale jobs
      const released = await jobQueue.releaseStaleJobs(0);

      // Then: No jobs released
      expect(released).toBe(0);

      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("COMPLETED");
    });

    it("should not affect FAILED jobs", async () => {
      // Given: A failed job
      jobQueue.setDefaultMaxAttempts(1);
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Test error", false);

      // When: I release stale jobs
      const released = await jobQueue.releaseStaleJobs(0);

      // Then: No jobs released
      expect(released).toBe(0);

      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("FAILED");
    });

    it("should not affect SUSPENDED jobs", async () => {
      // Given: A suspended job
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();
      await jobQueue.suspend(jobId, new Date(Date.now() + 60000));

      // When: I release stale jobs
      const released = await jobQueue.releaseStaleJobs(0);

      // Then: No jobs released
      expect(released).toBe(0);

      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("SUSPENDED");
    });
  });

  describe("threshold customization", () => {
    it("should respect custom stale threshold", async () => {
      // Given: A job locked 30 seconds ago
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();

      jobQueue.setJobLockedAt(jobId, new Date(Date.now() - 30000));

      // When: I use a 20s threshold (less than 30s)
      const released = await jobQueue.releaseStaleJobs(20000);

      // Then: Job is released (30s > 20s threshold)
      expect(released).toBe(1);
    });

    it("should handle very short threshold", async () => {
      // Given: A job just locked
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();

      // Set lockedAt to just 100ms ago
      jobQueue.setJobLockedAt(jobId, new Date(Date.now() - 100));

      // When: I use a 50ms threshold
      const released = await jobQueue.releaseStaleJobs(50);

      // Then: Job is released (100ms > 50ms threshold)
      expect(released).toBe(1);
    });
  });

  describe("crash simulation", () => {
    it("should support explicit crash simulation", async () => {
      // Given: A job being processed
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();

      // When: I simulate a crash
      jobQueue.simulateCrash(jobId);

      // Then: Job remains in RUNNING (crash doesn't change state)
      // The stale job recovery will clean it up
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("RUNNING");

      // Make it stale and release
      jobQueue.setJobLockedAt(jobId, new Date(Date.now() - 120000));
      await jobQueue.releaseStaleJobs(60000);

      expect(jobQueue.getJob(jobId)?.status).toBe("PENDING");
    });
  });
});
