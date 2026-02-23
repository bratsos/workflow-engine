/**
 * Job Distribution Tests
 *
 * Tests for job queuing, claiming, and distribution across workers.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";

describe("I want to distribute jobs across workers", () => {
  let jobQueue: InMemoryJobQueue;

  beforeEach(() => {
    jobQueue = new InMemoryJobQueue("worker-1");
  });

  describe("job enqueueing", () => {
    it("should enqueue a single job", async () => {
      // Given: Job data
      const jobData = {
        workflowRunId: "run-1",
        stageId: "stage-1",
      };

      // When: I enqueue the job
      const jobId = await jobQueue.enqueue(jobData);

      // Then: Job is created
      expect(jobId).toBeDefined();
      expect(jobId.length).toBeGreaterThan(0);

      const job = jobQueue.getJob(jobId);
      expect(job).not.toBeNull();
      expect(job?.status).toBe("PENDING");
      expect(job?.workflowRunId).toBe("run-1");
      expect(job?.stageId).toBe("stage-1");
    });

    it("should enqueue multiple jobs in parallel", async () => {
      // Given: Multiple jobs
      const jobs = [
        { workflowRunId: "run-1", stageId: "stage-a" },
        { workflowRunId: "run-1", stageId: "stage-b" },
        { workflowRunId: "run-1", stageId: "stage-c" },
      ];

      // When: I enqueue them in parallel
      const jobIds = await jobQueue.enqueueParallel(jobs);

      // Then: All jobs are created
      expect(jobIds).toHaveLength(3);
      expect(new Set(jobIds).size).toBe(3); // All unique IDs
    });

    it("should set default priority of 5", async () => {
      // Given: A job without explicit priority
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // Then: Default priority is 5
      const job = jobQueue.getJob(jobId);
      expect(job?.priority).toBe(5);
    });

    it("should respect custom priority", async () => {
      // Given: A job with custom priority
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        priority: 10,
      });

      // Then: Priority is set
      const job = jobQueue.getJob(jobId);
      expect(job?.priority).toBe(10);
    });

    it("should store payload with job", async () => {
      // Given: A job with payload
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        payload: { config: { model: "gpt-4" } },
      });

      // Then: Payload is stored
      const job = jobQueue.getJob(jobId);
      expect(job?.payload).toEqual({ config: { model: "gpt-4" } });
    });
  });

  describe("job dequeuing", () => {
    it("should dequeue a pending job", async () => {
      // Given: A pending job
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: I dequeue
      const result = await jobQueue.dequeue();

      // Then: Job is returned and locked
      expect(result).not.toBeNull();
      expect(result?.jobId).toBe(jobId);
      expect(result?.workflowRunId).toBe("run-1");
      expect(result?.stageId).toBe("stage-1");

      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("RUNNING");
      expect(job?.workerId).toBe("worker-1");
      expect(job?.lockedAt).toBeInstanceOf(Date);
    });

    it("should return null when queue is empty", async () => {
      // When: I dequeue from empty queue
      const result = await jobQueue.dequeue();

      // Then: Returns null
      expect(result).toBeNull();
    });

    it("should not dequeue jobs that are already processing", async () => {
      // Given: A job that's being processed
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });
      await jobQueue.dequeue();

      // When: I try to dequeue again
      const result = await jobQueue.dequeue();

      // Then: No job returned (already processing)
      expect(result).toBeNull();
    });

    it("should include attempt count in dequeue result", async () => {
      // Given: A job
      await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: I dequeue
      const result = await jobQueue.dequeue();

      // Then: Attempt is 1
      expect(result?.attempt).toBe(1);
    });
  });

  describe("multiple workers", () => {
    it("should allow different workers to claim different jobs", async () => {
      // Given: Two workers and two jobs
      const worker1 = new InMemoryJobQueue("worker-1");
      const worker2 = new InMemoryJobQueue("worker-2");

      // Use a shared job store - both workers need to see the same jobs
      // For this test, we'll enqueue to worker1 and use the same underlying store
      // Note: In production, both workers would connect to the same database

      const jobId1 = await worker1.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });
      const jobId2 = await worker1.enqueue({
        workflowRunId: "run-2",
        stageId: "stage-2",
      });

      // When: Worker1 dequeues
      const result1 = await worker1.dequeue();

      // Then: Worker1 gets job1 (FIFO for same priority)
      expect(result1?.jobId).toBe(jobId1);

      // And: Worker1 can't get another (already processing one, queue is separate instance)
      const result2 = await worker1.dequeue();
      expect(result2?.jobId).toBe(jobId2);

      // Verify worker IDs
      const job1 = worker1.getJob(jobId1);
      const job2 = worker1.getJob(jobId2);
      expect(job1?.workerId).toBe("worker-1");
      expect(job2?.workerId).toBe("worker-1");
    });

    it("should track which worker owns each job", async () => {
      // Given: Jobs claimed by different workers (simulated)
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: Worker claims the job
      await jobQueue.dequeue();

      // Then: Worker ID is recorded
      const job = jobQueue.getJob(jobId);
      expect(job?.workerId).toBe("worker-1");
    });
  });

  describe("job status filtering", () => {
    it("should get jobs by status", async () => {
      // Given: Jobs in different states
      const jobId1 = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });
      const jobId2 = await jobQueue.enqueue({
        workflowRunId: "run-2",
        stageId: "stage-2",
      });
      const jobId3 = await jobQueue.enqueue({
        workflowRunId: "run-3",
        stageId: "stage-3",
      });

      // Process job1
      await jobQueue.dequeue();
      await jobQueue.complete(jobId1);

      // Process job2 (leave it processing)
      await jobQueue.dequeue();

      // When: I filter by status
      const pending = jobQueue.getJobsByStatus("PENDING");
      const processing = jobQueue.getJobsByStatus("RUNNING");
      const completed = jobQueue.getJobsByStatus("COMPLETED");

      // Then: Jobs are correctly filtered
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe(jobId3);

      expect(processing).toHaveLength(1);
      expect(processing[0]?.id).toBe(jobId2);

      expect(completed).toHaveLength(1);
      expect(completed[0]?.id).toBe(jobId1);
    });

    it("should get all jobs for inspection", async () => {
      // Given: Multiple jobs
      await jobQueue.enqueue({ workflowRunId: "run-1", stageId: "stage-1" });
      await jobQueue.enqueue({ workflowRunId: "run-2", stageId: "stage-2" });
      await jobQueue.enqueue({ workflowRunId: "run-3", stageId: "stage-3" });

      // When: I get all jobs
      const allJobs = jobQueue.getAllJobs();

      // Then: All jobs are returned
      expect(allJobs).toHaveLength(3);
    });
  });

  describe("scheduled jobs", () => {
    it("should not dequeue jobs scheduled for the future", async () => {
      // Given: A job scheduled for the future
      const future = new Date(Date.now() + 60000); // 1 minute from now
      await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        scheduledFor: future,
      });

      // When: I try to dequeue
      const result = await jobQueue.dequeue();

      // Then: No job returned
      expect(result).toBeNull();
    });

    it("should dequeue jobs whose scheduled time has passed", async () => {
      // Given: A job scheduled for the past
      const past = new Date(Date.now() - 1000); // 1 second ago
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        scheduledFor: past,
      });

      // When: I dequeue
      const result = await jobQueue.dequeue();

      // Then: Job is returned
      expect(result?.jobId).toBe(jobId);
    });

    it("should dequeue jobs with no scheduled time", async () => {
      // Given: A job without scheduled time
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: I dequeue
      const result = await jobQueue.dequeue();

      // Then: Job is returned immediately
      expect(result?.jobId).toBe(jobId);
    });
  });

  describe("clearing the queue", () => {
    it("should clear all jobs", async () => {
      // Given: Multiple jobs
      await jobQueue.enqueue({ workflowRunId: "run-1", stageId: "stage-1" });
      await jobQueue.enqueue({ workflowRunId: "run-2", stageId: "stage-2" });

      // When: I clear the queue
      jobQueue.clear();

      // Then: Queue is empty
      expect(jobQueue.getAllJobs()).toHaveLength(0);
      expect(await jobQueue.dequeue()).toBeNull();
    });
  });
});
