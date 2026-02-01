/**
 * Worker Crash Recovery Tests
 *
 * Tests for resuming jobs after worker failures.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "../utils/in-memory-job-queue.js";

describe("I want to recover from worker crashes", () => {
  let jobQueue: InMemoryJobQueue;

  beforeEach(() => {
    jobQueue = new InMemoryJobQueue("worker-1");
  });

  describe("job retry on failure", () => {
    it("should retry failed jobs up to max attempts", async () => {
      // Given: A job with 3 max attempts
      jobQueue.setDefaultMaxAttempts(3);
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: Job fails with retry
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "First failure", true);

      // Then: Job is back to PENDING for retry
      let job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("PENDING");
      expect(job?.attempt).toBe(2);
      expect(job?.lastError).toBe("First failure");

      // When: Second attempt also fails
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Second failure", true);

      job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("PENDING");
      expect(job?.attempt).toBe(3);
      expect(job?.lastError).toBe("Second failure");

      // When: Third attempt fails (max attempts reached)
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Third failure", true);

      // Then: Job is permanently failed
      job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("FAILED");
      expect(job?.attempt).toBe(3);
      expect(job?.lastError).toBe("Third failure");
      expect(job?.completedAt).toBeInstanceOf(Date);
    });

    it("should not retry when shouldRetry is false", async () => {
      // Given: A job
      jobQueue.setDefaultMaxAttempts(3);
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: Job fails without retry
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Permanent failure", false);

      // Then: Job is immediately failed
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("FAILED");
      expect(job?.attempt).toBe(1);
    });

    it("should preserve job data across retries", async () => {
      // Given: A job with specific data
      jobQueue.setDefaultMaxAttempts(3);
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        priority: 8,
        payload: { config: { model: "test" } },
      });

      // When: Job fails and is retried
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Temporary error", true);

      // Then: Original data is preserved
      const job = jobQueue.getJob(jobId);
      expect(job?.workflowRunId).toBe("run-1");
      expect(job?.stageId).toBe("stage-1");
      expect(job?.priority).toBe(8);
      expect(job?.payload).toEqual({ config: { model: "test" } });
    });

    it("should clear worker lock after retry", async () => {
      // Given: A job being processed
      jobQueue.setDefaultMaxAttempts(3);
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();

      // Verify lock
      let job = jobQueue.getJob(jobId);
      expect(job?.workerId).toBe("worker-1");
      expect(job?.lockedAt).toBeInstanceOf(Date);

      // When: Job fails with retry
      await jobQueue.fail(jobId, "Error", true);

      // Then: Lock is cleared
      job = jobQueue.getJob(jobId);
      expect(job?.workerId).toBeNull();
      expect(job?.lockedAt).toBeNull();
    });
  });

  describe("stale job recovery after crash", () => {
    it("should recover jobs from crashed worker", async () => {
      // Given: A job locked by a worker that "crashes"
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();

      // Simulate crash by making job stale
      jobQueue.setJobLockedAt(jobId, new Date(Date.now() - 120000)); // 2 minutes ago

      // When: Stale job cleanup runs
      const released = await jobQueue.releaseStaleJobs(60000);

      // Then: Job is available for reprocessing
      expect(released).toBe(1);

      const recoveredJob = await jobQueue.dequeue();
      expect(recoveredJob?.jobId).toBe(jobId);
    });

    it("should allow a different worker to pick up recovered job", async () => {
      // Given: A job that was being processed by worker-1
      const worker1 = new InMemoryJobQueue("worker-1");
      const jobId = await worker1.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await worker1.dequeue();

      // Make stale
      worker1.setJobLockedAt(jobId, new Date(Date.now() - 120000));

      // Release stale jobs
      await worker1.releaseStaleJobs(60000);

      // When: Same queue (would be different worker in real scenario) picks up
      const result = await worker1.dequeue();

      // Then: Job can be processed again
      expect(result?.jobId).toBe(jobId);
    });
  });

  describe("attempt tracking", () => {
    it("should increment attempt on dequeue", async () => {
      // Given: A job
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: First dequeue
      const firstResult = await jobQueue.dequeue();

      // Then: Attempt is 1
      expect(firstResult?.attempt).toBe(1);

      // When: Fail and retry
      await jobQueue.fail(jobId, "Error", true);
      const secondResult = await jobQueue.dequeue();

      // Then: Attempt is 2
      expect(secondResult?.attempt).toBe(2);
    });

    it("should track attempt in job record", async () => {
      // Given: A job that's been retried
      jobQueue.setDefaultMaxAttempts(5);
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // Fail twice
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 1", true);
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 2", true);

      // Then: Attempt count reflects history
      const job = jobQueue.getJob(jobId);
      expect(job?.attempt).toBe(3);
    });
  });

  describe("suspended job resumption", () => {
    it("should resume suspended jobs when ready", async () => {
      // Given: A suspended job
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();

      // Suspend until future time
      const resumeAt = new Date(Date.now() + 60000);
      await jobQueue.suspend(jobId, resumeAt);

      // When: I check for suspended jobs ready to poll
      const readyNow = await jobQueue.getSuspendedJobsReadyToPoll();

      // Then: Job is not ready yet
      expect(readyNow).toHaveLength(0);

      // When: Resume time passes (simulate by setting nextPollAt to past)
      jobQueue.setJobNextPollAt(jobId, new Date(Date.now() - 1000));

      const readyLater = await jobQueue.getSuspendedJobsReadyToPoll();

      // Then: Job is ready
      expect(readyLater).toHaveLength(1);
      expect(readyLater[0]?.jobId).toBe(jobId);
    });

    it("should return jobId, stageId, and workflowRunId for ready suspended jobs", async () => {
      // Given: A suspended job ready to resume
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-123",
        stageId: "batch-stage",
      });

      await jobQueue.dequeue();
      await jobQueue.suspend(jobId, new Date(Date.now() - 1000)); // Already ready

      // When: I get suspended jobs ready to poll
      const ready = await jobQueue.getSuspendedJobsReadyToPoll();

      // Then: All needed info is returned
      expect(ready).toHaveLength(1);
      expect(ready[0]).toEqual({
        jobId,
        stageId: "batch-stage",
        workflowRunId: "run-123",
      });
    });

    it("should support manual resume for testing", async () => {
      // Given: A suspended job
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();
      await jobQueue.suspend(jobId, new Date(Date.now() + 60000));

      // When: I manually resume it
      jobQueue.resumeJob(jobId);

      // Then: Job is back to PENDING
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("PENDING");
      expect(job?.nextPollAt).toBeNull();
    });
  });

  describe("error tracking", () => {
    it("should track last error message", async () => {
      // Given: A job that fails multiple times
      jobQueue.setDefaultMaxAttempts(3);
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: It fails with different errors
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Connection timeout", true);

      let job = jobQueue.getJob(jobId);
      expect(job?.lastError).toBe("Connection timeout");

      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Out of memory", true);

      job = jobQueue.getJob(jobId);
      expect(job?.lastError).toBe("Out of memory");
    });

    it("should preserve error on permanent failure", async () => {
      // Given: A job that fails permanently
      jobQueue.setDefaultMaxAttempts(1);
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Fatal error: database corrupted", false);

      // Then: Error is preserved
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("FAILED");
      expect(job?.lastError).toBe("Fatal error: database corrupted");
    });
  });

  describe("max attempts configuration", () => {
    it("should respect custom max attempts", async () => {
      // Given: A job with custom max attempts
      jobQueue.setDefaultMaxAttempts(2);
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: It fails twice
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 1", true);

      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 2", true);

      // Then: Job is failed (2 attempts reached)
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("FAILED");
      expect(job?.attempt).toBe(2);
    });

    it("should allow single attempt configuration", async () => {
      // Given: Max attempts of 1
      jobQueue.setDefaultMaxAttempts(1);
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: It fails
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error", true);

      // Then: Immediately failed (no retries)
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("FAILED");
    });
  });

  describe("worker identification", () => {
    it("should track worker ID for debugging", async () => {
      // Given: A custom worker ID
      const customQueue = new InMemoryJobQueue("worker-special-123");

      const jobId = await customQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await customQueue.dequeue();

      // Then: Worker ID is recorded
      const job = customQueue.getJob(jobId);
      expect(job?.workerId).toBe("worker-special-123");
    });

    it("should generate worker ID if not provided", async () => {
      // Given: Queue without explicit worker ID
      const autoQueue = new InMemoryJobQueue();

      const jobId = await autoQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await autoQueue.dequeue();

      // Then: Worker ID is auto-generated
      const job = autoQueue.getJob(jobId);
      expect(job?.workerId).toMatch(/^worker-/);
    });

    it("should provide access to worker ID", async () => {
      // Given: A queue with explicit worker ID
      const queue = new InMemoryJobQueue("my-worker");

      // Then: Worker ID is accessible
      expect(queue.getWorkerId()).toBe("my-worker");
    });
  });
});
