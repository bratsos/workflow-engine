/**
 * Priority Scheduling Tests
 *
 * Tests for priority-based job selection and scheduling.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryJobQueue } from "../utils/in-memory-job-queue.js";

describe("I want to schedule jobs by priority", () => {
  let jobQueue: InMemoryJobQueue;

  beforeEach(() => {
    jobQueue = new InMemoryJobQueue("worker-1");
  });

  describe("priority ordering", () => {
    it("should dequeue higher priority jobs first", async () => {
      // Given: Jobs with different priorities
      const lowPriorityId = await jobQueue.enqueue({
        workflowRunId: "run-low",
        stageId: "stage-1",
        priority: 1,
      });
      const mediumPriorityId = await jobQueue.enqueue({
        workflowRunId: "run-medium",
        stageId: "stage-1",
        priority: 5,
      });
      const highPriorityId = await jobQueue.enqueue({
        workflowRunId: "run-high",
        stageId: "stage-1",
        priority: 10,
      });

      // When: I dequeue jobs
      const first = await jobQueue.dequeue();
      const second = await jobQueue.dequeue();
      const third = await jobQueue.dequeue();

      // Then: Higher priority jobs come first
      expect(first?.jobId).toBe(highPriorityId);
      expect(second?.jobId).toBe(mediumPriorityId);
      expect(third?.jobId).toBe(lowPriorityId);
    });

    it("should use FIFO for jobs with same priority", async () => {
      // Given: Jobs with same priority
      const job1Id = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        priority: 5,
      });

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 1));

      const job2Id = await jobQueue.enqueue({
        workflowRunId: "run-2",
        stageId: "stage-1",
        priority: 5,
      });

      await new Promise((r) => setTimeout(r, 1));

      const job3Id = await jobQueue.enqueue({
        workflowRunId: "run-3",
        stageId: "stage-1",
        priority: 5,
      });

      // When: I dequeue jobs
      const first = await jobQueue.dequeue();
      const second = await jobQueue.dequeue();
      const third = await jobQueue.dequeue();

      // Then: Jobs are returned in FIFO order
      expect(first?.jobId).toBe(job1Id);
      expect(second?.jobId).toBe(job2Id);
      expect(third?.jobId).toBe(job3Id);
    });

    it("should process priority 10 before priority 1 regardless of order", async () => {
      // Given: Low priority job enqueued first
      const lowId = await jobQueue.enqueue({
        workflowRunId: "run-low",
        stageId: "stage-1",
        priority: 1,
      });

      // Then high priority job enqueued later
      const highId = await jobQueue.enqueue({
        workflowRunId: "run-high",
        stageId: "stage-1",
        priority: 10,
      });

      // When: I dequeue
      const result = await jobQueue.dequeue();

      // Then: High priority job is returned first
      expect(result?.jobId).toBe(highId);
      expect(result?.priority).toBe(10);
    });
  });

  describe("priority values", () => {
    it("should support priority range 0-10", async () => {
      // Given: Jobs with various priorities
      const ids: string[] = [];
      for (let priority = 0; priority <= 10; priority++) {
        const id = await jobQueue.enqueue({
          workflowRunId: `run-${priority}`,
          stageId: "stage-1",
          priority,
        });
        ids.push(id);
      }

      // When: I get all jobs
      const jobs = jobQueue.getAllJobs();

      // Then: All priorities are stored correctly
      expect(jobs).toHaveLength(11);
      for (let i = 0; i <= 10; i++) {
        const job = jobQueue.getJob(ids[i]!);
        expect(job?.priority).toBe(i);
      }
    });

    it("should handle extreme priority values", async () => {
      // Given: Jobs with extreme priorities
      const minId = await jobQueue.enqueue({
        workflowRunId: "run-min",
        stageId: "stage-1",
        priority: 0,
      });
      const maxId = await jobQueue.enqueue({
        workflowRunId: "run-max",
        stageId: "stage-1",
        priority: 100,
      });

      // When: I dequeue
      const first = await jobQueue.dequeue();
      const second = await jobQueue.dequeue();

      // Then: Max priority comes first
      expect(first?.jobId).toBe(maxId);
      expect(second?.jobId).toBe(minId);
    });
  });

  describe("priority with scheduling", () => {
    it("should not prioritize future scheduled jobs over available ones", async () => {
      // Given: A high priority job scheduled for future
      const future = new Date(Date.now() + 60000);
      await jobQueue.enqueue({
        workflowRunId: "run-high-future",
        stageId: "stage-1",
        priority: 10,
        scheduledFor: future,
      });

      // And a low priority job available now
      const lowNowId = await jobQueue.enqueue({
        workflowRunId: "run-low-now",
        stageId: "stage-1",
        priority: 1,
      });

      // When: I dequeue
      const result = await jobQueue.dequeue();

      // Then: Available low priority job is returned
      expect(result?.jobId).toBe(lowNowId);
    });

    it("should respect priority among available jobs only", async () => {
      // Given: Mix of scheduled and available jobs
      const future = new Date(Date.now() + 60000);

      await jobQueue.enqueue({
        workflowRunId: "run-low-now",
        stageId: "stage-1",
        priority: 1,
      });

      await jobQueue.enqueue({
        workflowRunId: "run-high-future",
        stageId: "stage-1",
        priority: 10,
        scheduledFor: future,
      });

      const medNowId = await jobQueue.enqueue({
        workflowRunId: "run-med-now",
        stageId: "stage-1",
        priority: 5,
      });

      // When: I dequeue
      const result = await jobQueue.dequeue();

      // Then: Medium priority available job comes first
      expect(result?.jobId).toBe(medNowId);
    });
  });

  describe("priority dequeue result", () => {
    it("should include priority in dequeue result", async () => {
      // Given: A job with specific priority
      await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        priority: 7,
      });

      // When: I dequeue
      const result = await jobQueue.dequeue();

      // Then: Priority is included in result
      expect(result?.priority).toBe(7);
    });
  });

  describe("batch enqueueing with priority", () => {
    it("should apply priority to parallel enqueued jobs", async () => {
      // Given: Parallel jobs with different priorities
      const ids = await jobQueue.enqueueParallel([
        { workflowRunId: "run-1", stageId: "stage-a", priority: 3 },
        { workflowRunId: "run-1", stageId: "stage-b", priority: 8 },
        { workflowRunId: "run-1", stageId: "stage-c", priority: 5 },
      ]);

      // When: I dequeue all
      const first = await jobQueue.dequeue();
      const second = await jobQueue.dequeue();
      const third = await jobQueue.dequeue();

      // Then: They come out in priority order
      expect(first?.stageId).toBe("stage-b"); // priority 8
      expect(second?.stageId).toBe("stage-c"); // priority 5
      expect(third?.stageId).toBe("stage-a"); // priority 3
    });
  });

  describe("priority starvation prevention", () => {
    it("should eventually process low priority jobs", async () => {
      // Given: A low priority job
      const lowId = await jobQueue.enqueue({
        workflowRunId: "run-low",
        stageId: "stage-1",
        priority: 1,
      });

      // And some high priority jobs
      for (let i = 0; i < 5; i++) {
        await jobQueue.enqueue({
          workflowRunId: `run-high-${i}`,
          stageId: "stage-1",
          priority: 10,
        });
      }

      // When: I process all high priority jobs
      const processed: string[] = [];
      for (let i = 0; i < 5; i++) {
        const result = await jobQueue.dequeue();
        if (result) {
          processed.push(result.jobId);
          await jobQueue.complete(result.jobId);
        }
      }

      // Then: Low priority job is now available
      const lowResult = await jobQueue.dequeue();
      expect(lowResult?.jobId).toBe(lowId);
    });
  });
});
