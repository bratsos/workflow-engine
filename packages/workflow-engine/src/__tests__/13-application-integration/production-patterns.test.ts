/**
 * Production Patterns Tests (Kernel)
 *
 * Tests for production-ready patterns when using the workflow engine.
 * Patterns that map to kernel commands (job queue, retry, health checks) are
 * rewritten. Patterns that relied on WorkflowRuntime (graceful shutdown
 * of a polling loop, monitoring hooks) are skipped since those are now
 * handled by host packages (workflow-engine-host-node, etc.).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { type Workflow, WorkflowBuilder } from "../../core/workflow.js";
import { createKernel } from "../../kernel/kernel.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

function createTestKernel(workflows: Workflow<any, any>[] = []) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const scheduler = new NoopScheduler();
  const clock = new FakeClock();
  const registry = new Map<string, Workflow<any, any>>();
  for (const w of workflows) registry.set(w.id, w);
  const kernel = createKernel({
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });
  const flush = () => kernel.dispatch({ type: "outbox.flush" as const });
  return {
    kernel,
    flush,
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry,
  };
}

describe("I want to use production-ready patterns", () => {
  describe("graceful shutdown", () => {
    it("should finish current job before stopping", async () => {
      // Given: A worker with a shutdown signal
      const jobQueue = new InMemoryJobQueue("worker-1");
      let isShuttingDown = false;
      const processedJobs: string[] = [];

      // Enqueue multiple jobs
      await jobQueue.enqueue({ workflowRunId: "run-1", stageId: "stage-1" });
      await jobQueue.enqueue({ workflowRunId: "run-2", stageId: "stage-2" });
      await jobQueue.enqueue({ workflowRunId: "run-3", stageId: "stage-3" });

      // When: Worker processes with graceful shutdown
      const processJob = async (jobId: string, stageId: string) => {
        await new Promise((r) => setTimeout(r, 20));
        processedJobs.push(stageId);
        await jobQueue.complete(jobId);
      };

      const job1 = await jobQueue.dequeue();
      if (job1) {
        setTimeout(() => {
          isShuttingDown = true;
        }, 10);
        await processJob(job1.jobId, job1.stageId);
      }

      // Check shutdown flag before taking more work
      if (!isShuttingDown) {
        const job2 = await jobQueue.dequeue();
        if (job2) await processJob(job2.jobId, job2.stageId);
      }

      // Then: Only the in-flight job was completed
      expect(processedJobs).toContain("stage-1");
      expect(isShuttingDown).toBe(true);

      // And: Other jobs remain in queue
      const remainingJobs = jobQueue.getJobsByStatus("PENDING");
      expect(remainingJobs.length).toBeGreaterThanOrEqual(1);
    });

    it("should release lock if forced shutdown during processing", async () => {
      // Given: A job being processed
      const jobQueue = new InMemoryJobQueue("worker-1");
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "interrupted",
      });

      await jobQueue.dequeue();

      // When: Force shutdown occurs (simulate by making lock stale)
      jobQueue.setJobLockedAt(jobId, new Date(Date.now() - 120000));

      // Use kernel's lease.reapStale or direct queue cleanup
      await jobQueue.releaseStaleJobs(60000);

      // Then: Job is available for reprocessing
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("PENDING");
      expect(job?.workerId).toBeNull();
    });

    it("should use kernel lease.reapStale to recover stale jobs", async () => {
      // Given: A kernel with a stale job in the transport
      const schema = z.object({ value: z.string() });
      const stage = defineStage({
        id: "process",
        name: "Process",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });
      const workflow = new WorkflowBuilder(
        "stale-wf",
        "Stale",
        "Test",
        schema,
        schema,
      )
        .pipe(stage)
        .build();

      const { kernel, jobTransport } = createTestKernel([workflow]);

      // Enqueue and lock a job manually
      const jobId = await jobTransport.enqueue({
        workflowRunId: "run-1",
        stageId: "process",
      });
      await jobTransport.dequeue(); // locks it
      jobTransport.setJobLockedAt(jobId, new Date(Date.now() - 120000)); // make it stale

      // When: Kernel reaps stale leases
      const result = await kernel.dispatch({
        type: "lease.reapStale",
        staleThresholdMs: 60000,
      });

      // Then: Stale job was released
      expect(result.released).toBe(1);
      const job = jobTransport.getJob(jobId);
      expect(job?.status).toBe("PENDING");
    });
  });

  describe("health check patterns", () => {
    it("should report worker health status via job queue", async () => {
      // Given: A worker with health tracking
      const jobQueue = new InMemoryJobQueue("worker-1");

      interface WorkerHealth {
        status: "healthy" | "unhealthy" | "degraded";
        workerId: string;
        lastJobProcessed: Date | null;
        jobsProcessed: number;
        consecutiveFailures: number;
      }

      const health: WorkerHealth = {
        status: "healthy",
        workerId: jobQueue.getWorkerId(),
        lastJobProcessed: null,
        jobsProcessed: 0,
        consecutiveFailures: 0,
      };

      // When: Worker processes a job successfully
      await jobQueue.enqueue({ workflowRunId: "run-1", stageId: "stage-1" });
      const job = await jobQueue.dequeue();
      if (job) {
        await jobQueue.complete(job.jobId);
        health.jobsProcessed++;
        health.lastJobProcessed = new Date();
        health.consecutiveFailures = 0;
      }

      // Then: Health is reported as healthy
      expect(health.status).toBe("healthy");
      expect(health.jobsProcessed).toBe(1);
      expect(health.consecutiveFailures).toBe(0);
    });

    it("should check persistence health", async () => {
      // Given: Persistence layer via kernel
      const { persistence } = createTestKernel();

      // When: Performing health check
      const startTime = Date.now();

      let canWrite = false;
      let canRead = false;

      try {
        const run = await persistence.createRun({
          workflowId: "health-check",
          workflowName: "Health Check",
          workflowType: "health-check",
          input: { test: true },
        });
        canWrite = true;
        const readBack = await persistence.getRun(run.id);
        canRead = readBack !== null;
      } catch {
        // Health check failed
      }

      const latencyMs = Date.now() - startTime;

      // Then: Persistence is healthy
      expect(canRead).toBe(true);
      expect(canWrite).toBe(true);
      expect(latencyMs).toBeLessThan(1000);
    });
  });

  describe("retry patterns", () => {
    it("should implement exponential backoff for retries", async () => {
      // Given: A backoff calculation function
      const calculateBackoff = (
        attempt: number,
        baseMs: number = 1000,
      ): number => {
        return baseMs * Math.pow(2, attempt - 1);
      };

      // When: Computing backoff for each attempt
      const backoffDelays: number[] = [];
      for (let attempt = 1; attempt <= 4; attempt++) {
        backoffDelays.push(calculateBackoff(attempt));
      }

      // Then: Backoff increases exponentially
      expect(backoffDelays).toEqual([1000, 2000, 4000, 8000]);
    });

    it("should track retry state for each job via kernel job queue", async () => {
      // Given: A job configured for retries
      const jobQueue = new InMemoryJobQueue("worker-1");
      jobQueue.setDefaultMaxAttempts(3);

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "flaky-stage",
      });

      // When: First attempt fails
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Timeout", true);

      // Then: Job is back in queue for retry
      let job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("PENDING");
      expect(job?.attempt).toBe(2);

      // Second attempt fails
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Rate limited", true);

      // Third attempt succeeds
      await jobQueue.dequeue();
      await jobQueue.complete(jobId);

      job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("COMPLETED");
    });

    it("should support selective retry based on error type", async () => {
      // Given: Error classification
      const isRetryableError = (error: string): boolean => {
        const retryablePatterns = [
          /timeout/i,
          /rate limit/i,
          /connection refused/i,
          /temporary/i,
          /5\d\d/,
        ];
        return retryablePatterns.some((pattern) => pattern.test(error));
      };

      // When/Then: Errors are correctly classified
      expect(isRetryableError("Connection timeout")).toBe(true);
      expect(isRetryableError("Rate limit exceeded")).toBe(true);
      expect(isRetryableError("Invalid input")).toBe(false);
      expect(isRetryableError("HTTP 503 Service Unavailable")).toBe(true);
      expect(isRetryableError("Authentication failed")).toBe(false);
      expect(isRetryableError("Temporary failure")).toBe(true);
    });

    it("should implement retry budget", async () => {
      // Given: A retry budget tracker
      interface RetryBudget {
        maxRetries: number;
        windowMs: number;
        attempts: Date[];
      }

      const budget: RetryBudget = {
        maxRetries: 10,
        windowMs: 60000,
        attempts: [],
      };

      const canRetry = (b: RetryBudget): boolean => {
        const now = Date.now();
        b.attempts = b.attempts.filter((t) => now - t.getTime() < b.windowMs);
        return b.attempts.length < b.maxRetries;
      };

      const recordRetry = (b: RetryBudget): void => {
        b.attempts.push(new Date());
      };

      // When: Using retry budget
      for (let i = 0; i < 10; i++) {
        expect(canRetry(budget)).toBe(true);
        recordRetry(budget);
      }
      expect(canRetry(budget)).toBe(false);

      // After window passes, budget resets
      budget.attempts = budget.attempts.map(() => new Date(Date.now() - 70000));
      expect(canRetry(budget)).toBe(true);
    });
  });

  describe("circuit breaker patterns", () => {
    it("should implement basic circuit breaker", async () => {
      // Given: A circuit breaker
      interface CircuitBreaker {
        state: "closed" | "open" | "half-open";
        failures: number;
        threshold: number;
        lastFailure: Date | null;
        resetTimeoutMs: number;
      }

      const breaker: CircuitBreaker = {
        state: "closed",
        failures: 0,
        threshold: 3,
        lastFailure: null,
        resetTimeoutMs: 10000,
      };

      const canExecute = (b: CircuitBreaker): boolean => {
        if (b.state === "closed") return true;
        if (b.state === "open") {
          if (
            b.lastFailure &&
            Date.now() - b.lastFailure.getTime() > b.resetTimeoutMs
          ) {
            b.state = "half-open";
            return true;
          }
          return false;
        }
        return true;
      };

      const recordFailure = (b: CircuitBreaker): void => {
        b.failures++;
        b.lastFailure = new Date();
        if (b.failures >= b.threshold) b.state = "open";
      };

      const recordSuccess = (b: CircuitBreaker): void => {
        if (b.state === "half-open") {
          b.state = "closed";
          b.failures = 0;
        }
      };

      // When: Circuit starts closed
      expect(canExecute(breaker)).toBe(true);

      // Record failures until threshold
      recordFailure(breaker);
      recordFailure(breaker);
      expect(breaker.state).toBe("closed");

      recordFailure(breaker); // Threshold reached
      expect(breaker.state).toBe("open");
      expect(canExecute(breaker)).toBe(false);

      // Simulate timeout passing
      breaker.lastFailure = new Date(Date.now() - 15000);
      expect(canExecute(breaker)).toBe(true);
      expect(breaker.state).toBe("half-open");

      // Success in half-open closes circuit
      recordSuccess(breaker);
      expect(breaker.state).toBe("closed");
    });
  });

  describe("dead letter queue patterns", () => {
    it("should move permanently failed jobs to dead letter queue", async () => {
      // Given: A dead letter queue
      const deadLetterQueue: Array<{
        jobId: string;
        error: string;
        attempts: number;
      }> = [];

      const jobQueue = new InMemoryJobQueue("worker-1");
      jobQueue.setDefaultMaxAttempts(2);

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "problematic-stage",
      });

      // When: Job fails permanently (exhaust retries)
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 1", true);
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 2", true);

      // Check if job is permanently failed
      const job = jobQueue.getJob(jobId);
      if (job?.status === "FAILED") {
        deadLetterQueue.push({
          jobId: job.id,
          error: job.lastError || "Unknown",
          attempts: job.attempt,
        });
      }

      // Then: Job is in dead letter queue
      expect(deadLetterQueue).toHaveLength(1);
      expect(deadLetterQueue[0]?.jobId).toBe(jobId);
      expect(deadLetterQueue[0]?.attempts).toBe(2);
    });
  });

  describe("monitoring patterns", () => {
    it("should track processing metrics via event sink", async () => {
      // Given: A kernel with a simple workflow
      const schema = z.object({ value: z.string() });
      const stage = defineStage({
        id: "process",
        name: "Process",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });
      const workflow = new WorkflowBuilder(
        "metrics-wf",
        "Metrics",
        "Test",
        schema,
        schema,
      )
        .pipe(stage)
        .build();

      const { kernel, flush, persistence, eventSink } = createTestKernel([
        workflow,
      ]);

      // Create, claim, and execute
      const run = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "m1",
        workflowId: "metrics-wf",
        input: { value: "test" },
      });
      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: run.workflowRunId,
        workflowId: "metrics-wf",
        stageId: "process",
        config: {},
      });
      await flush();

      // Then: Events are captured for monitoring
      const startedEvents = eventSink.getByType("stage:started");
      const completedEvents = eventSink.getByType("stage:completed");
      expect(startedEvents.length).toBeGreaterThanOrEqual(1);
      expect(completedEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("rate limiting patterns", () => {
    it("should implement token bucket rate limiter", async () => {
      // Given: A token bucket rate limiter
      interface TokenBucket {
        tokens: number;
        maxTokens: number;
        refillRate: number;
        lastRefill: number;
      }

      const bucket: TokenBucket = {
        tokens: 10,
        maxTokens: 10,
        refillRate: 2,
        lastRefill: Date.now(),
      };

      const refillBucket = (b: TokenBucket): void => {
        const now = Date.now();
        const elapsed = (now - b.lastRefill) / 1000;
        const newTokens = elapsed * b.refillRate;
        b.tokens = Math.min(b.maxTokens, b.tokens + newTokens);
        b.lastRefill = now;
      };

      const tryConsume = (b: TokenBucket, tokens: number = 1): boolean => {
        refillBucket(b);
        if (b.tokens >= tokens) {
          b.tokens -= tokens;
          return true;
        }
        return false;
      };

      // When: Consuming tokens
      for (let i = 0; i < 10; i++) {
        expect(tryConsume(bucket)).toBe(true);
      }
      expect(tryConsume(bucket)).toBe(false);

      // After time passes, tokens refill
      bucket.lastRefill = Date.now() - 1000;
      expect(tryConsume(bucket)).toBe(true);
      expect(tryConsume(bucket)).toBe(true);
      expect(tryConsume(bucket)).toBe(false);
    });
  });
});
