/**
 * Worker Process Simulation Tests
 *
 * Tests for how worker processes would interact with the workflow engine:
 * - Worker polling for jobs
 * - Worker executing jobs
 * - Multiple workers competing for jobs
 * - Worker handling failures
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow.js";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import {
  InMemoryWorkflowPersistence,
  InMemoryJobQueue,
  InMemoryAICallLogger,
} from "../utils/index.js";

describe("I want to simulate worker process behavior", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  describe("worker polling for jobs", () => {
    it("should dequeue jobs in priority order", async () => {
      // Given: Multiple jobs with different priorities
      const jobQueue = new InMemoryJobQueue("worker-1");

      const lowPriorityId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        priority: 1,
      });

      const highPriorityId = await jobQueue.enqueue({
        workflowRunId: "run-2",
        stageId: "stage-2",
        priority: 10,
      });

      const mediumPriorityId = await jobQueue.enqueue({
        workflowRunId: "run-3",
        stageId: "stage-3",
        priority: 5,
      });

      // When: Worker polls for jobs
      const first = await jobQueue.dequeue();
      const second = await jobQueue.dequeue();
      const third = await jobQueue.dequeue();

      // Then: Jobs are returned in priority order (highest first)
      expect(first?.jobId).toBe(highPriorityId);
      expect(second?.jobId).toBe(mediumPriorityId);
      expect(third?.jobId).toBe(lowPriorityId);
    });

    it("should return null when no jobs available", async () => {
      // Given: An empty job queue
      const jobQueue = new InMemoryJobQueue("worker-1");

      // When: Worker polls
      const result = await jobQueue.dequeue();

      // Then: Returns null
      expect(result).toBeNull();
    });

    it("should lock job when dequeued", async () => {
      // Given: A job in the queue
      const jobQueue = new InMemoryJobQueue("worker-1");

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: Worker dequeues the job
      await jobQueue.dequeue();

      // Then: Job is locked by the worker
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("RUNNING");
      expect(job?.workerId).toBe("worker-1");
      expect(job?.lockedAt).toBeInstanceOf(Date);
    });

    it("should not return already processing jobs", async () => {
      // Given: A job that's being processed
      const jobQueue = new InMemoryJobQueue("worker-1");

      await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // First worker takes the job
      await jobQueue.dequeue();

      // When: Another dequeue attempt
      const result = await jobQueue.dequeue();

      // Then: No job returned (it's being processed)
      expect(result).toBeNull();
    });

    it("should respect scheduled job times", async () => {
      // Given: A job scheduled for the future
      const jobQueue = new InMemoryJobQueue("worker-1");

      const futureTime = new Date(Date.now() + 60000);
      await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        scheduledFor: futureTime,
      });

      // When: Worker polls before scheduled time
      const result = await jobQueue.dequeue();

      // Then: Job is not returned yet
      expect(result).toBeNull();
    });

    it("should return scheduled jobs after their time", async () => {
      // Given: A job scheduled for the past
      const jobQueue = new InMemoryJobQueue("worker-1");

      const pastTime = new Date(Date.now() - 1000);
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        scheduledFor: pastTime,
      });

      // When: Worker polls
      const result = await jobQueue.dequeue();

      // Then: Job is returned
      expect(result?.jobId).toBe(jobId);
    });
  });

  describe("worker executing jobs", () => {
    it("should execute a stage and mark job complete", async () => {
      // Given: A job and corresponding workflow run
      const jobQueue = new InMemoryJobQueue("worker-1");

      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test",
        workflowType: "test-workflow",
        input: { value: "test" },
      });

      const jobId = await jobQueue.enqueue({
        workflowRunId: run.id,
        stageId: "process",
      });

      // When: Worker processes the job
      const job = await jobQueue.dequeue();
      expect(job).not.toBeNull();

      // Simulate stage execution success
      await jobQueue.complete(jobId);

      // Then: Job is marked complete
      const completedJob = jobQueue.getJob(jobId);
      expect(completedJob?.status).toBe("COMPLETED");
      expect(completedJob?.completedAt).toBeInstanceOf(Date);
    });

    it("should update persistence when stage completes", async () => {
      // Given: A workflow run with a stage
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test",
        workflowType: "test-workflow",
        input: { value: "test" },
      });

      const stage = await persistence.createStage({
        workflowRunId: run.id,
        stageId: "process",
        stageName: "Process",
        stageNumber: 1,
        executionGroup: 1,
        status: "PENDING",
      });

      // When: Worker executes and completes the stage
      await persistence.updateStage(stage.id, {
        status: "RUNNING",
        startedAt: new Date(),
      });

      await persistence.updateStage(stage.id, {
        status: "COMPLETED",
        completedAt: new Date(),
        duration: 100,
        outputData: { result: "processed" },
      });

      // Then: Stage is marked complete in persistence
      const updatedStage = await persistence.getStage(run.id, "process");
      expect(updatedStage?.status).toBe("COMPLETED");
      expect(updatedStage?.outputData).toEqual({ result: "processed" });
    });

    it("should handle job payload correctly", async () => {
      // Given: A job with configuration payload
      const jobQueue = new InMemoryJobQueue("worker-1");

      const payload = {
        config: {
          model: "gpt-4",
          temperature: 0.7,
        },
      };

      await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        payload,
      });

      // When: Worker dequeues
      const job = await jobQueue.dequeue();

      // Then: Payload is available
      expect(job?.payload).toEqual(payload);
    });

    it("should suspend job for async-batch stages", async () => {
      // Given: A job that needs to suspend
      const jobQueue = new InMemoryJobQueue("worker-1");

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "batch-stage",
      });

      // When: Worker processes and suspends the job
      await jobQueue.dequeue();

      const resumeAt = new Date(Date.now() + 60000);
      await jobQueue.suspend(jobId, resumeAt);

      // Then: Job is suspended with resume time
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("SUSPENDED");
      expect(job?.nextPollAt).toEqual(resumeAt);
      expect(job?.workerId).toBeNull(); // Lock released
    });
  });

  describe("multiple workers competing for jobs", () => {
    it("should distribute jobs across workers", async () => {
      // Given: A shared job source and multiple workers
      // Note: In real scenario, workers share the same database/queue
      // For testing, we simulate with separate queues but track claims

      const sharedJobs = new InMemoryJobQueue("orchestrator");

      // Enqueue multiple jobs
      await sharedJobs.enqueue({ workflowRunId: "run-1", stageId: "stage-a" });
      await sharedJobs.enqueue({ workflowRunId: "run-2", stageId: "stage-b" });
      await sharedJobs.enqueue({ workflowRunId: "run-3", stageId: "stage-c" });

      // When: Workers compete for jobs
      const claims: string[] = [];

      const job1 = await sharedJobs.dequeue();
      if (job1) claims.push(`worker-1:${job1.stageId}`);

      const job2 = await sharedJobs.dequeue();
      if (job2) claims.push(`worker-2:${job2.stageId}`);

      const job3 = await sharedJobs.dequeue();
      if (job3) claims.push(`worker-3:${job3.stageId}`);

      // Then: All jobs are claimed
      expect(claims).toHaveLength(3);
      expect(claims).toContain("worker-1:stage-a");
      expect(claims).toContain("worker-2:stage-b");
      expect(claims).toContain("worker-3:stage-c");
    });

    it("should ensure only one worker claims each job", async () => {
      // Given: A single job in the queue
      const sharedQueue = new InMemoryJobQueue("shared");

      const jobId = await sharedQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: First worker claims
      const firstClaim = await sharedQueue.dequeue();

      // Then: Job is locked
      expect(firstClaim?.jobId).toBe(jobId);

      // And: Second attempt returns nothing
      const secondClaim = await sharedQueue.dequeue();
      expect(secondClaim).toBeNull();

      // Verify only one claim
      const job = sharedQueue.getJob(jobId);
      expect(job?.status).toBe("RUNNING");
    });

    it("should handle parallel job enqueue correctly", async () => {
      // Given: Multiple stages to run in parallel
      const jobQueue = new InMemoryJobQueue("worker");

      const parallelJobs = [
        { workflowRunId: "run-1", stageId: "branch-a", priority: 5 },
        { workflowRunId: "run-1", stageId: "branch-b", priority: 5 },
        { workflowRunId: "run-1", stageId: "branch-c", priority: 5 },
      ];

      // When: Jobs are enqueued in parallel
      const jobIds = await jobQueue.enqueueParallel(parallelJobs);

      // Then: All jobs are created
      expect(jobIds).toHaveLength(3);
      expect(new Set(jobIds).size).toBe(3); // All unique

      // And: All are pending
      const allJobs = jobQueue.getAllJobs();
      const pendingJobs = allJobs.filter((j) => j.status === "PENDING");
      expect(pendingJobs).toHaveLength(3);
    });
  });

  describe("worker handling failures", () => {
    it("should retry failed jobs automatically", async () => {
      // Given: A job configured for retries
      const jobQueue = new InMemoryJobQueue("worker-1");
      jobQueue.setDefaultMaxAttempts(3);

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "flaky-stage",
      });

      // When: First attempt fails
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Connection timeout", true);

      // Then: Job is back in queue for retry
      let job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("PENDING");
      expect(job?.attempt).toBe(2);
      expect(job?.lastError).toBe("Connection timeout");

      // And: Can be picked up again
      const retryJob = await jobQueue.dequeue();
      expect(retryJob?.jobId).toBe(jobId);
      expect(retryJob?.attempt).toBe(2);
    });

    it("should permanently fail after max retries", async () => {
      // Given: A job with limited retries
      const jobQueue = new InMemoryJobQueue("worker-1");
      jobQueue.setDefaultMaxAttempts(2);

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "failing-stage",
      });

      // When: Job fails twice (max attempts)
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 1", true);

      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 2", true);

      // Then: Job is permanently failed
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("FAILED");
      expect(job?.completedAt).toBeInstanceOf(Date);
    });

    it("should fail immediately when shouldRetry is false", async () => {
      // Given: A job
      const jobQueue = new InMemoryJobQueue("worker-1");
      jobQueue.setDefaultMaxAttempts(3);

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: Job fails with shouldRetry=false
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Invalid input - do not retry", false);

      // Then: Job is immediately failed
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("FAILED");
      expect(job?.attempt).toBe(1); // Only one attempt
    });

    it("should update workflow status on stage failure", async () => {
      // Given: A workflow run
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test",
        workflowType: "test-workflow",
        input: { value: "test" },
      });

      await persistence.updateRun(run.id, { status: "RUNNING" });

      // When: Stage fails permanently
      await persistence.updateRun(run.id, { status: "FAILED" });

      // Then: Workflow is marked failed
      const status = await persistence.getRunStatus(run.id);
      expect(status).toBe("FAILED");
    });

    it("should recover stale jobs from crashed workers", async () => {
      // Given: A job locked by a "crashed" worker
      const jobQueue = new InMemoryJobQueue("crashed-worker");

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // Worker takes job then "crashes"
      await jobQueue.dequeue();

      // Simulate crash: job locked 2 minutes ago
      jobQueue.setJobLockedAt(jobId, new Date(Date.now() - 120000));

      // When: Stale job cleanup runs (threshold: 60 seconds)
      const released = await jobQueue.releaseStaleJobs(60000);

      // Then: Job is released
      expect(released).toBe(1);

      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("PENDING");
      expect(job?.workerId).toBeNull();
      expect(job?.lockedAt).toBeNull();

      // And: Can be picked up by another worker
      const recoveredJob = await jobQueue.dequeue();
      expect(recoveredJob?.jobId).toBe(jobId);
    });

    it("should preserve job data through failures and retries", async () => {
      // Given: A job with specific payload
      const jobQueue = new InMemoryJobQueue("worker-1");
      jobQueue.setDefaultMaxAttempts(3);

      const payload = {
        config: { model: "gpt-4" },
        metadata: { source: "api" },
      };

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        priority: 8,
        payload,
      });

      // When: Job fails and is retried
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Temporary error", true);

      // Then: All original data is preserved
      const retryJob = await jobQueue.dequeue();
      expect(retryJob?.payload).toEqual(payload);
      expect(retryJob?.priority).toBe(8);
      expect(retryJob?.workflowRunId).toBe("run-1");
      expect(retryJob?.stageId).toBe("stage-1");
    });
  });

  describe("worker processing suspended jobs", () => {
    it("should find suspended jobs ready to resume", async () => {
      // Given: Suspended jobs with different resume times
      const jobQueue = new InMemoryJobQueue("worker-1");

      const job1 = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "batch-1",
      });

      const job2 = await jobQueue.enqueue({
        workflowRunId: "run-2",
        stageId: "batch-2",
      });

      // Process and suspend both
      await jobQueue.dequeue();
      await jobQueue.suspend(job1, new Date(Date.now() - 1000)); // Ready now

      await jobQueue.dequeue();
      await jobQueue.suspend(job2, new Date(Date.now() + 60000)); // Not ready

      // When: Check for ready suspended jobs
      const ready = await jobQueue.getSuspendedJobsReadyToPoll();

      // Then: Only the ready job is returned
      expect(ready).toHaveLength(1);
      expect(ready[0]?.jobId).toBe(job1);
      expect(ready[0]?.stageId).toBe("batch-1");
      expect(ready[0]?.workflowRunId).toBe("run-1");
    });

    it("should allow manual resume for testing", async () => {
      // Given: A suspended job
      const jobQueue = new InMemoryJobQueue("worker-1");

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();
      await jobQueue.suspend(jobId, new Date(Date.now() + 60000));

      // When: Manually resumed
      jobQueue.resumeJob(jobId);

      // Then: Job is back to pending and can be dequeued
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("PENDING");

      const resumed = await jobQueue.dequeue();
      expect(resumed?.jobId).toBe(jobId);
    });
  });

  describe("worker lifecycle simulation", () => {
    it("should simulate a complete worker processing cycle", async () => {
      // Given: A worker process simulation
      const jobQueue = new InMemoryJobQueue("worker-simulation");
      const processedJobs: string[] = [];

      // Enqueue several jobs
      await jobQueue.enqueue({ workflowRunId: "run-1", stageId: "stage-1" });
      await jobQueue.enqueue({ workflowRunId: "run-2", stageId: "stage-2" });
      await jobQueue.enqueue({ workflowRunId: "run-3", stageId: "stage-3" });

      // Simulate worker loop
      let iterations = 0;
      const maxIterations = 10;

      while (iterations < maxIterations) {
        const job = await jobQueue.dequeue();

        if (!job) {
          // No more jobs
          break;
        }

        // Process the job
        processedJobs.push(job.stageId);

        // Complete the job
        await jobQueue.complete(job.jobId);

        iterations++;
      }

      // Then: All jobs were processed
      expect(processedJobs).toHaveLength(3);
      expect(processedJobs).toContain("stage-1");
      expect(processedJobs).toContain("stage-2");
      expect(processedJobs).toContain("stage-3");

      // And: All jobs are completed
      const allJobs = jobQueue.getAllJobs();
      expect(allJobs.every((j) => j.status === "COMPLETED")).toBe(true);
    });

    it("should simulate worker with mixed success and failure", async () => {
      // Given: Jobs where some will fail
      const jobQueue = new InMemoryJobQueue("worker-mixed");
      jobQueue.setDefaultMaxAttempts(2);

      await jobQueue.enqueue({ workflowRunId: "run-1", stageId: "success-1" });
      await jobQueue.enqueue({ workflowRunId: "run-2", stageId: "fail-1" });
      await jobQueue.enqueue({ workflowRunId: "run-3", stageId: "success-2" });

      // Simulate worker that fails on "fail-" prefixed stages
      let iterations = 0;
      const maxIterations = 10;

      while (iterations < maxIterations) {
        const job = await jobQueue.dequeue();
        if (!job) break;

        if (job.stageId.startsWith("fail-")) {
          await jobQueue.fail(job.jobId, "Simulated failure", true);
        } else {
          await jobQueue.complete(job.jobId);
        }

        iterations++;
      }

      // Then: Check final states
      const allJobs = jobQueue.getAllJobs();
      const completed = allJobs.filter((j) => j.status === "COMPLETED");
      const failed = allJobs.filter((j) => j.status === "FAILED");

      expect(completed).toHaveLength(2); // success-1, success-2
      expect(failed).toHaveLength(1); // fail-1 (after 2 attempts)
    });

    it("should track worker metrics", async () => {
      // Given: A worker processing jobs
      const jobQueue = new InMemoryJobQueue("metrics-worker");

      // Enqueue jobs
      for (let i = 0; i < 5; i++) {
        await jobQueue.enqueue({
          workflowRunId: `run-${i}`,
          stageId: `stage-${i}`,
        });
      }

      // Simulate processing with metrics
      let jobsProcessed = 0;
      let totalProcessingTime = 0;
      const startTime = Date.now();

      while (true) {
        const job = await jobQueue.dequeue();
        if (!job) break;

        const jobStart = Date.now();

        // Simulate some work
        await new Promise((r) => setTimeout(r, 10));

        await jobQueue.complete(job.jobId);

        jobsProcessed++;
        totalProcessingTime += Date.now() - jobStart;
      }

      const totalTime = Date.now() - startTime;

      // Then: Metrics are available
      expect(jobsProcessed).toBe(5);
      expect(totalProcessingTime).toBeGreaterThan(0);
      expect(totalTime).toBeGreaterThan(0);

      // Could compute: avg processing time, jobs per second, etc.
      const avgProcessingTime = totalProcessingTime / jobsProcessed;
      expect(avgProcessingTime).toBeGreaterThan(0);
    });
  });
});
