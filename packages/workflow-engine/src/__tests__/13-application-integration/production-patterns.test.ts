/**
 * Production Patterns Tests
 *
 * Tests for production-ready patterns when using the workflow engine:
 * - Graceful shutdown (finish current job then stop)
 * - Health check (worker alive, job queue healthy)
 * - Retry patterns
 * - Circuit breaker patterns
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

describe("I want to use production-ready patterns", () => {
  let persistence: InMemoryWorkflowPersistence;
  let jobQueue: InMemoryJobQueue;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    jobQueue = new InMemoryJobQueue("worker-1");
    aiLogger = new InMemoryAICallLogger();
  });

  describe("graceful shutdown", () => {
    it("should finish current job before stopping", async () => {
      // Given: A worker with a shutdown signal
      let isShuttingDown = false;
      const processedJobs: string[] = [];

      // Enqueue multiple jobs
      await jobQueue.enqueue({ workflowRunId: "run-1", stageId: "stage-1" });
      await jobQueue.enqueue({ workflowRunId: "run-2", stageId: "stage-2" });
      await jobQueue.enqueue({ workflowRunId: "run-3", stageId: "stage-3" });

      // When: Worker processes with graceful shutdown
      const processJob = async (jobId: string, stageId: string) => {
        // Simulate processing time
        await new Promise((r) => setTimeout(r, 20));
        processedJobs.push(stageId);
        await jobQueue.complete(jobId);
      };

      // Start processing
      const job1 = await jobQueue.dequeue();
      if (job1) {
        // Signal shutdown while processing first job
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

    it("should not accept new jobs when shutting down", async () => {
      // Given: A worker in shutdown mode
      let acceptingJobs = true;

      await jobQueue.enqueue({ workflowRunId: "run-1", stageId: "stage-1" });

      // When: Shutdown is triggered
      acceptingJobs = false;

      // Then: Worker should not dequeue
      const shouldProcess = acceptingJobs;
      expect(shouldProcess).toBe(false);

      // Jobs remain available for other workers
      const pendingJobs = jobQueue.getJobsByStatus("PENDING");
      expect(pendingJobs).toHaveLength(1);
    });

    it("should allow time for in-flight job to complete", async () => {
      // Given: A long-running job
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "long-running",
      });

      let jobCompleted = false;
      const shutdownTimeout = 100; // ms

      // When: Job is processing and shutdown is signaled
      const job = await jobQueue.dequeue();

      const processPromise = (async () => {
        // Simulate long processing (but shorter than timeout)
        await new Promise((r) => setTimeout(r, 50));
        await jobQueue.complete(jobId);
        jobCompleted = true;
      })();

      // Wait for job with timeout
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(resolve, shutdownTimeout);
      });

      await Promise.race([processPromise, timeoutPromise]);

      // Then: Job had time to complete
      expect(jobCompleted).toBe(true);
      expect(jobQueue.getJob(jobId)?.status).toBe("COMPLETED");
    });

    it("should release lock if forced shutdown during processing", async () => {
      // Given: A job being processed
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "interrupted",
      });

      await jobQueue.dequeue();

      // When: Force shutdown occurs (simulate by making lock stale)
      jobQueue.setJobLockedAt(jobId, new Date(Date.now() - 120000));

      // Another worker releases stale locks
      const newQueue = new InMemoryJobQueue("recovery-worker");
      // Copy the job state (in real system, this would be the same database)
      // For this test, we use the same queue instance
      await jobQueue.releaseStaleJobs(60000);

      // Then: Job is available for reprocessing
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("PENDING");
      expect(job?.workerId).toBeNull();
    });
  });

  describe("health check patterns", () => {
    it("should report worker health status", async () => {
      // Given: A worker with health tracking
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

      // When: Worker processes jobs successfully
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

    it("should detect degraded health after failures", async () => {
      // Given: Health tracking with failure thresholds
      interface WorkerHealth {
        status: "healthy" | "unhealthy" | "degraded";
        consecutiveFailures: number;
      }

      const health: WorkerHealth = {
        status: "healthy",
        consecutiveFailures: 0,
      };

      const DEGRADED_THRESHOLD = 3;
      const UNHEALTHY_THRESHOLD = 5;

      const updateHealth = () => {
        if (health.consecutiveFailures >= UNHEALTHY_THRESHOLD) {
          health.status = "unhealthy";
        } else if (health.consecutiveFailures >= DEGRADED_THRESHOLD) {
          health.status = "degraded";
        } else {
          health.status = "healthy";
        }
      };

      // When: Multiple failures occur
      jobQueue.setDefaultMaxAttempts(1); // Immediate failure

      for (let i = 0; i < 4; i++) {
        const jobId = await jobQueue.enqueue({
          workflowRunId: `run-${i}`,
          stageId: `failing-${i}`,
        });
        await jobQueue.dequeue();
        await jobQueue.fail(jobId, "Simulated failure", false);
        health.consecutiveFailures++;
        updateHealth();
      }

      // Then: Health is degraded
      expect(health.status).toBe("degraded");
      expect(health.consecutiveFailures).toBe(4);
    });

    it("should check job queue health", async () => {
      // Given: A job queue with various states
      interface QueueHealth {
        pendingCount: number;
        processingCount: number;
        staleCount: number;
        failedCount: number;
        isHealthy: boolean;
      }

      // Create jobs in various states
      const job1 = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "s1",
      });
      const job2 = await jobQueue.enqueue({
        workflowRunId: "run-2",
        stageId: "s2",
      });
      const job3 = await jobQueue.enqueue({
        workflowRunId: "run-3",
        stageId: "s3",
      });

      // Process one
      await jobQueue.dequeue();
      await jobQueue.complete(job1);

      // Fail one
      await jobQueue.dequeue();
      await jobQueue.fail(job2, "Test failure", false);

      // Leave one pending

      // When: Checking queue health
      const allJobs = jobQueue.getAllJobs();
      const queueHealth: QueueHealth = {
        pendingCount: allJobs.filter((j) => j.status === "PENDING").length,
        processingCount: allJobs.filter((j) => j.status === "RUNNING").length,
        staleCount: allJobs.filter(
          (j) =>
            j.status === "RUNNING" &&
            j.lockedAt &&
            Date.now() - j.lockedAt.getTime() > 60000,
        ).length,
        failedCount: allJobs.filter((j) => j.status === "FAILED").length,
        isHealthy: true, // Will be computed
      };

      // Compute health
      queueHealth.isHealthy =
        queueHealth.staleCount === 0 && queueHealth.failedCount < 10;

      // Then: Queue health is reported
      expect(queueHealth.pendingCount).toBe(1);
      expect(queueHealth.failedCount).toBe(1);
      expect(queueHealth.staleCount).toBe(0);
      expect(queueHealth.isHealthy).toBe(true);
    });

    it("should check persistence health", async () => {
      // Given: Persistence layer
      interface PersistenceHealth {
        canRead: boolean;
        canWrite: boolean;
        latencyMs: number;
        isHealthy: boolean;
      }

      // When: Performing health check
      const startTime = Date.now();

      let canWrite = false;
      let canRead = false;

      try {
        // Test write
        const run = await persistence.createRun({
          workflowId: "health-check",
          workflowName: "Health Check",
          workflowType: "health-check",
          input: { test: true },
        });
        canWrite = true;

        // Test read
        const readBack = await persistence.getRun(run.id);
        canRead = readBack !== null;
      } catch {
        // Health check failed
      }

      const latencyMs = Date.now() - startTime;

      const health: PersistenceHealth = {
        canRead,
        canWrite,
        latencyMs,
        isHealthy: canRead && canWrite && latencyMs < 1000,
      };

      // Then: Persistence is healthy
      expect(health.canRead).toBe(true);
      expect(health.canWrite).toBe(true);
      expect(health.isHealthy).toBe(true);
    });

    it("should provide combined system health", async () => {
      // Given: Multiple health indicators
      interface SystemHealth {
        worker: { status: string; jobsProcessed: number };
        queue: { pendingJobs: number; staleJobs: number };
        persistence: { healthy: boolean };
        overall: "healthy" | "degraded" | "unhealthy";
      }

      // When: Collecting all health indicators
      const systemHealth: SystemHealth = {
        worker: {
          status: "healthy",
          jobsProcessed: 10,
        },
        queue: {
          pendingJobs: jobQueue.getJobsByStatus("PENDING").length,
          staleJobs: 0,
        },
        persistence: {
          healthy: true,
        },
        overall: "healthy",
      };

      // Compute overall health
      if (!systemHealth.persistence.healthy) {
        systemHealth.overall = "unhealthy";
      } else if (
        systemHealth.queue.staleJobs > 0 ||
        systemHealth.worker.status === "degraded"
      ) {
        systemHealth.overall = "degraded";
      }

      // Then: System health is comprehensive
      expect(systemHealth.overall).toBe("healthy");
    });
  });

  describe("retry patterns", () => {
    it("should implement exponential backoff for retries", async () => {
      // Given: A job that needs retries with backoff
      const backoffDelays: number[] = [];

      const calculateBackoff = (
        attempt: number,
        baseMs: number = 1000,
      ): number => {
        // Exponential backoff: 1s, 2s, 4s, 8s, etc.
        return baseMs * Math.pow(2, attempt - 1);
      };

      // When: Computing backoff for each attempt
      for (let attempt = 1; attempt <= 4; attempt++) {
        const delay = calculateBackoff(attempt);
        backoffDelays.push(delay);
      }

      // Then: Backoff increases exponentially
      expect(backoffDelays).toEqual([1000, 2000, 4000, 8000]);
    });

    it("should implement jittered backoff to avoid thundering herd", async () => {
      // Given: A jittered backoff function
      const calculateJitteredBackoff = (
        attempt: number,
        baseMs: number = 1000,
        jitterFactor: number = 0.3,
      ): number => {
        const exponentialDelay = baseMs * Math.pow(2, attempt - 1);
        const jitter = exponentialDelay * jitterFactor * Math.random();
        return Math.floor(exponentialDelay + jitter);
      };

      // When: Calculating multiple backoffs for the same attempt
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        delays.push(calculateJitteredBackoff(3, 1000, 0.3));
      }

      // Then: Delays have variation but are in expected range
      // Base delay for attempt 3: 4000ms
      // With 30% jitter: 4000-5200ms
      expect(delays.every((d) => d >= 4000 && d <= 5200)).toBe(true);

      // And: Not all delays are exactly the same (jitter working)
      const uniqueDelays = new Set(delays);
      // With random jitter, very unlikely all 5 are identical
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    it("should track retry state for each job", async () => {
      // Given: A job that will be retried
      jobQueue.setDefaultMaxAttempts(3);

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "flaky-stage",
      });

      // When: Tracking retry progression
      const retryHistory: Array<{ attempt: number; error: string }> = [];

      // First attempt fails
      await jobQueue.dequeue();
      retryHistory.push({ attempt: 1, error: "Timeout" });
      await jobQueue.fail(jobId, "Timeout", true);

      // Second attempt fails
      await jobQueue.dequeue();
      retryHistory.push({ attempt: 2, error: "Rate limited" });
      await jobQueue.fail(jobId, "Rate limited", true);

      // Third attempt succeeds
      await jobQueue.dequeue();
      await jobQueue.complete(jobId);

      // Then: Retry history is tracked
      expect(retryHistory).toHaveLength(2);
      expect(retryHistory[0]).toEqual({ attempt: 1, error: "Timeout" });
      expect(retryHistory[1]).toEqual({ attempt: 2, error: "Rate limited" });

      const job = jobQueue.getJob(jobId);
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
          /5\d\d/, // 5xx errors
        ];
        return retryablePatterns.some((pattern) => pattern.test(error));
      };

      // When: Classifying errors
      const errors = [
        { error: "Connection timeout", shouldRetry: true },
        { error: "Rate limit exceeded", shouldRetry: true },
        { error: "Invalid input", shouldRetry: false },
        { error: "HTTP 503 Service Unavailable", shouldRetry: true },
        { error: "Authentication failed", shouldRetry: false },
        { error: "Temporary failure", shouldRetry: true },
      ];

      // Then: Errors are correctly classified
      for (const { error, shouldRetry } of errors) {
        expect(isRetryableError(error)).toBe(shouldRetry);
      }
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
        windowMs: 60000, // 1 minute
        attempts: [],
      };

      const canRetry = (budget: RetryBudget): boolean => {
        const now = Date.now();
        // Remove old attempts outside window
        budget.attempts = budget.attempts.filter(
          (t) => now - t.getTime() < budget.windowMs,
        );
        return budget.attempts.length < budget.maxRetries;
      };

      const recordRetry = (budget: RetryBudget): void => {
        budget.attempts.push(new Date());
      };

      // When: Using retry budget
      // First 10 retries should succeed
      for (let i = 0; i < 10; i++) {
        expect(canRetry(budget)).toBe(true);
        recordRetry(budget);
      }

      // 11th retry should fail (budget exhausted)
      expect(canRetry(budget)).toBe(false);

      // After window passes, budget resets
      budget.attempts = budget.attempts.map(
        () => new Date(Date.now() - 70000), // 70 seconds ago
      );

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

      const canExecute = (breaker: CircuitBreaker): boolean => {
        if (breaker.state === "closed") return true;
        if (breaker.state === "open") {
          if (
            breaker.lastFailure &&
            Date.now() - breaker.lastFailure.getTime() > breaker.resetTimeoutMs
          ) {
            breaker.state = "half-open";
            return true;
          }
          return false;
        }
        return true; // half-open allows one request
      };

      const recordFailure = (breaker: CircuitBreaker): void => {
        breaker.failures++;
        breaker.lastFailure = new Date();
        if (breaker.failures >= breaker.threshold) {
          breaker.state = "open";
        }
      };

      const recordSuccess = (breaker: CircuitBreaker): void => {
        if (breaker.state === "half-open") {
          breaker.state = "closed";
          breaker.failures = 0;
        }
      };

      // When: Circuit starts closed
      expect(breaker.state).toBe("closed");
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

    it("should use circuit breaker with job processing", async () => {
      // Given: A circuit breaker protecting job execution
      const circuitBreaker = {
        isOpen: false,
        failures: 0,
        threshold: 2,
      };

      const executeWithBreaker = async (
        jobId: string,
        willFail: boolean,
      ): Promise<"success" | "failure" | "rejected"> => {
        if (circuitBreaker.isOpen) {
          return "rejected";
        }

        if (willFail) {
          circuitBreaker.failures++;
          if (circuitBreaker.failures >= circuitBreaker.threshold) {
            circuitBreaker.isOpen = true;
          }
          return "failure";
        }

        circuitBreaker.failures = 0;
        return "success";
      };

      // When: Executing jobs
      const results: string[] = [];

      results.push(await executeWithBreaker("job-1", false)); // success
      results.push(await executeWithBreaker("job-2", true)); // failure
      results.push(await executeWithBreaker("job-3", true)); // failure, opens circuit
      results.push(await executeWithBreaker("job-4", false)); // rejected

      // Then: Circuit breaker protected the system
      expect(results).toEqual(["success", "failure", "failure", "rejected"]);
      expect(circuitBreaker.isOpen).toBe(true);
    });
  });

  describe("rate limiting patterns", () => {
    it("should implement token bucket rate limiter", async () => {
      // Given: A token bucket rate limiter
      interface TokenBucket {
        tokens: number;
        maxTokens: number;
        refillRate: number; // tokens per second
        lastRefill: number;
      }

      const bucket: TokenBucket = {
        tokens: 10,
        maxTokens: 10,
        refillRate: 2, // 2 tokens per second
        lastRefill: Date.now(),
      };

      const refillBucket = (bucket: TokenBucket): void => {
        const now = Date.now();
        const elapsed = (now - bucket.lastRefill) / 1000;
        const newTokens = elapsed * bucket.refillRate;
        bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + newTokens);
        bucket.lastRefill = now;
      };

      const tryConsume = (bucket: TokenBucket, tokens: number = 1): boolean => {
        refillBucket(bucket);
        if (bucket.tokens >= tokens) {
          bucket.tokens -= tokens;
          return true;
        }
        return false;
      };

      // When: Consuming tokens
      // First 10 should succeed
      for (let i = 0; i < 10; i++) {
        expect(tryConsume(bucket)).toBe(true);
      }

      // 11th should fail (bucket empty)
      expect(tryConsume(bucket)).toBe(false);

      // Simulate time passing (1 second = 2 tokens refilled)
      bucket.lastRefill = Date.now() - 1000;
      expect(tryConsume(bucket)).toBe(true);
      expect(tryConsume(bucket)).toBe(true);
      expect(tryConsume(bucket)).toBe(false);
    });

    it("should apply rate limiting to job processing", async () => {
      // Given: A rate-limited job processor
      let tokensAvailable = 3;

      const processWithRateLimit = async (
        jobId: string,
      ): Promise<"processed" | "rate-limited"> => {
        if (tokensAvailable > 0) {
          tokensAvailable--;
          return "processed";
        }
        return "rate-limited";
      };

      // When: Processing jobs
      const results: string[] = [];

      for (let i = 0; i < 5; i++) {
        results.push(await processWithRateLimit(`job-${i}`));
      }

      // Then: First 3 processed, rest rate-limited
      expect(results).toEqual([
        "processed",
        "processed",
        "processed",
        "rate-limited",
        "rate-limited",
      ]);
    });
  });

  describe("monitoring patterns", () => {
    it("should track processing metrics", async () => {
      // Given: A metrics tracker
      interface Metrics {
        jobsProcessed: number;
        jobsFailed: number;
        totalProcessingTimeMs: number;
        avgProcessingTimeMs: number;
      }

      const metrics: Metrics = {
        jobsProcessed: 0,
        jobsFailed: 0,
        totalProcessingTimeMs: 0,
        avgProcessingTimeMs: 0,
      };

      const recordJobProcessed = (durationMs: number): void => {
        metrics.jobsProcessed++;
        metrics.totalProcessingTimeMs += durationMs;
        metrics.avgProcessingTimeMs =
          metrics.totalProcessingTimeMs / metrics.jobsProcessed;
      };

      const recordJobFailed = (): void => {
        metrics.jobsFailed++;
      };

      // When: Processing jobs
      recordJobProcessed(100);
      recordJobProcessed(150);
      recordJobProcessed(200);
      recordJobFailed();

      // Then: Metrics are tracked
      expect(metrics.jobsProcessed).toBe(3);
      expect(metrics.jobsFailed).toBe(1);
      expect(metrics.totalProcessingTimeMs).toBe(450);
      expect(metrics.avgProcessingTimeMs).toBe(150);
    });

    it("should support metric export format", async () => {
      // Given: Metrics in exportable format
      interface ExportableMetrics {
        timestamp: string;
        workerId: string;
        metrics: Record<string, number>;
        labels: Record<string, string>;
      }

      const createMetricExport = (
        workerId: string,
        data: {
          jobsProcessed: number;
          jobsFailed: number;
          avgLatencyMs: number;
        },
      ): ExportableMetrics => {
        return {
          timestamp: new Date().toISOString(),
          workerId,
          metrics: {
            jobs_processed_total: data.jobsProcessed,
            jobs_failed_total: data.jobsFailed,
            job_processing_latency_ms: data.avgLatencyMs,
          },
          labels: {
            service: "workflow-engine",
            instance: workerId,
          },
        };
      };

      // When: Creating metric export
      const exported = createMetricExport("worker-1", {
        jobsProcessed: 100,
        jobsFailed: 5,
        avgLatencyMs: 250,
      });

      // Then: Format is suitable for monitoring systems
      expect(exported.metrics.jobs_processed_total).toBe(100);
      expect(exported.metrics.jobs_failed_total).toBe(5);
      expect(exported.labels.service).toBe("workflow-engine");
      expect(exported.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it("should track error rates", async () => {
      // Given: Error rate tracking
      interface ErrorRateTracker {
        windowMs: number;
        events: Array<{ time: number; isError: boolean }>;
      }

      const tracker: ErrorRateTracker = {
        windowMs: 60000, // 1 minute window
        events: [],
      };

      const recordEvent = (isError: boolean): void => {
        tracker.events.push({ time: Date.now(), isError });
      };

      const getErrorRate = (): number => {
        const now = Date.now();
        const windowStart = now - tracker.windowMs;
        const recentEvents = tracker.events.filter(
          (e) => e.time >= windowStart,
        );

        if (recentEvents.length === 0) return 0;

        const errors = recentEvents.filter((e) => e.isError).length;
        return errors / recentEvents.length;
      };

      // When: Recording events
      // 7 successes, 3 failures = 30% error rate
      for (let i = 0; i < 7; i++) recordEvent(false);
      for (let i = 0; i < 3; i++) recordEvent(true);

      // Then: Error rate is calculated
      expect(getErrorRate()).toBeCloseTo(0.3);
    });
  });

  describe("dead letter queue patterns", () => {
    it("should move permanently failed jobs to dead letter queue", async () => {
      // Given: A dead letter queue
      const deadLetterQueue: Array<{
        jobId: string;
        originalQueue: string;
        error: string;
        attempts: number;
        failedAt: Date;
      }> = [];

      jobQueue.setDefaultMaxAttempts(2);

      // When: Job fails permanently
      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "problematic-stage",
      });

      // Fail twice
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 1", true);

      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 2", true);

      // Check if job is permanently failed
      const job = jobQueue.getJob(jobId);
      if (job?.status === "FAILED") {
        // Move to dead letter queue
        deadLetterQueue.push({
          jobId: job.id,
          originalQueue: "main",
          error: job.lastError || "Unknown",
          attempts: job.attempt,
          failedAt: new Date(),
        });
      }

      // Then: Job is in dead letter queue
      expect(deadLetterQueue).toHaveLength(1);
      expect(deadLetterQueue[0]?.jobId).toBe(jobId);
      expect(deadLetterQueue[0]?.attempts).toBe(2);
    });

    it("should allow manual retry from dead letter queue", async () => {
      // Given: A job in dead letter queue
      const deadLetterQueue: Array<{ jobId: string; stageId: string }> = [];

      // Simulate a failed job moved to DLQ
      deadLetterQueue.push({ jobId: "failed-job-1", stageId: "stage-1" });

      // When: Manual retry is triggered
      const dlqJob = deadLetterQueue.shift();
      if (dlqJob) {
        // Re-enqueue to main queue
        const newJobId = await jobQueue.enqueue({
          workflowRunId: "run-retry",
          stageId: dlqJob.stageId,
        });

        // Then: Job is back in main queue
        const job = jobQueue.getJob(newJobId);
        expect(job?.status).toBe("PENDING");
      }

      expect(deadLetterQueue).toHaveLength(0);
    });
  });
});
