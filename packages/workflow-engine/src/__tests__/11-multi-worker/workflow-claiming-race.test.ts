/**
 * Workflow Claiming Race Condition Tests
 *
 * Tests for ensuring only one worker can claim a pending workflow,
 * even when multiple workers try to claim the same workflow simultaneously.
 *
 * Uses FOR UPDATE SKIP LOCKED pattern for atomic claiming.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

describe("I want to prevent race conditions when claiming workflows", () => {
  let persistence: InMemoryWorkflowPersistence;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
  });

  describe("claimNextPendingRun - atomic workflow claiming", () => {
    it("should claim a pending workflow and return it", async () => {
      // Given: A pending workflow
      await persistence.createRun({
        id: "run-1",
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test",
        input: { data: "test" },
      });

      // When: I claim the next pending run
      const claimed = await persistence.claimNextPendingRun();

      // Then: I get the workflow and it's marked as RUNNING
      expect(claimed).not.toBeNull();
      expect(claimed?.id).toBe("run-1");
      expect(claimed?.status).toBe("RUNNING");
      expect(claimed?.startedAt).toBeInstanceOf(Date);
    });

    it("should return null when no pending workflows exist", async () => {
      // Given: No pending workflows

      // When: I try to claim
      const claimed = await persistence.claimNextPendingRun();

      // Then: I get null
      expect(claimed).toBeNull();
    });

    it("should not claim already running workflows", async () => {
      // Given: A running workflow (not pending)
      await persistence.createRun({
        id: "run-1",
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test",
        input: {},
      });
      await persistence.updateRun("run-1", { status: "RUNNING" });

      // When: I try to claim
      const claimed = await persistence.claimNextPendingRun();

      // Then: I get null (can't claim running workflow)
      expect(claimed).toBeNull();
    });

    it("should claim workflows in priority order", async () => {
      // Given: Multiple pending workflows with different priorities
      await persistence.createRun({
        id: "low-priority",
        workflowId: "test-workflow",
        workflowName: "Test",
        workflowType: "test",
        input: {},
        priority: 1,
      });
      await persistence.createRun({
        id: "high-priority",
        workflowId: "test-workflow",
        workflowName: "Test",
        workflowType: "test",
        input: {},
        priority: 10,
      });
      await persistence.createRun({
        id: "medium-priority",
        workflowId: "test-workflow",
        workflowName: "Test",
        workflowType: "test",
        input: {},
        priority: 5,
      });

      // When: I claim workflows one by one
      const first = await persistence.claimNextPendingRun();
      const second = await persistence.claimNextPendingRun();
      const third = await persistence.claimNextPendingRun();

      // Then: They come out in priority order (highest first)
      expect(first?.id).toBe("high-priority");
      expect(second?.id).toBe("medium-priority");
      expect(third?.id).toBe("low-priority");
    });

    it("should claim workflows in FIFO order when same priority", async () => {
      // Given: Multiple pending workflows with same priority
      await persistence.createRun({
        id: "first",
        workflowId: "test-workflow",
        workflowName: "Test",
        workflowType: "test",
        input: {},
        priority: 5,
      });

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));

      await persistence.createRun({
        id: "second",
        workflowId: "test-workflow",
        workflowName: "Test",
        workflowType: "test",
        input: {},
        priority: 5,
      });

      // When: I claim workflows
      const firstClaimed = await persistence.claimNextPendingRun();
      const secondClaimed = await persistence.claimNextPendingRun();

      // Then: First created is claimed first (FIFO)
      expect(firstClaimed?.id).toBe("first");
      expect(secondClaimed?.id).toBe("second");
    });
  });

  describe("concurrent claiming - race condition prevention", () => {
    it("should ensure only one worker claims each workflow when racing", async () => {
      // Given: A single pending workflow
      await persistence.createRun({
        id: "contested-run",
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test",
        input: {},
      });

      // When: Two workers try to claim simultaneously
      const [result1, result2] = await Promise.all([
        persistence.claimNextPendingRun(),
        persistence.claimNextPendingRun(),
      ]);

      // Then: Exactly one succeeds, the other gets null
      const successes = [result1, result2].filter((r) => r !== null);
      const nulls = [result1, result2].filter((r) => r === null);

      expect(successes.length).toBe(1);
      expect(nulls.length).toBe(1);
      expect(successes[0]?.id).toBe("contested-run");
      expect(successes[0]?.status).toBe("RUNNING");
    });

    it("should distribute workflows evenly when multiple workers claim concurrently", async () => {
      // Given: 5 pending workflows
      for (let i = 1; i <= 5; i++) {
        await persistence.createRun({
          id: `run-${i}`,
          workflowId: "test-workflow",
          workflowName: "Test",
          workflowType: "test",
          input: {},
          priority: 5,
        });
      }

      // When: 3 workers try to claim simultaneously (simulating high concurrency)
      const claims = await Promise.all([
        persistence.claimNextPendingRun(),
        persistence.claimNextPendingRun(),
        persistence.claimNextPendingRun(),
      ]);

      // Then: Each worker gets a unique workflow (no duplicates)
      const claimedIds = claims.filter((c) => c !== null).map((c) => c!.id);

      // All claimed workflows should be unique
      const uniqueIds = new Set(claimedIds);
      expect(uniqueIds.size).toBe(claimedIds.length);

      // All should be marked as RUNNING
      for (const id of claimedIds) {
        const run = await persistence.getRun(id);
        expect(run?.status).toBe("RUNNING");
      }

      // Remaining workflows should still be PENDING
      const allRuns = await persistence.getRunsByStatus("PENDING");
      expect(allRuns.length).toBe(2); // 5 - 3 = 2 remaining
    });

    it("should never allow duplicate claims even under high contention", async () => {
      // Given: 3 pending workflows
      for (let i = 1; i <= 3; i++) {
        await persistence.createRun({
          id: `run-${i}`,
          workflowId: "test-workflow",
          workflowName: "Test",
          workflowType: "test",
          input: {},
        });
      }

      // When: 10 concurrent claim attempts (simulating very high contention)
      const claimPromises = Array.from({ length: 10 }, () =>
        persistence.claimNextPendingRun(),
      );
      const results = await Promise.all(claimPromises);

      // Then: Exactly 3 succeed (one per workflow), 7 get null
      const successes = results.filter((r) => r !== null);
      const nulls = results.filter((r) => r === null);

      expect(successes.length).toBe(3);
      expect(nulls.length).toBe(7);

      // All claimed IDs are unique
      const claimedIds = successes.map((s) => s!.id);
      const uniqueIds = new Set(claimedIds);
      expect(uniqueIds.size).toBe(3);

      // No more pending workflows
      const remaining = await persistence.getRunsByStatus("PENDING");
      expect(remaining.length).toBe(0);
    });

    it("should not overwrite status when claim fails", async () => {
      // Given: A workflow that gets claimed by worker 1
      await persistence.createRun({
        id: "run-1",
        workflowId: "test-workflow",
        workflowName: "Test",
        workflowType: "test",
        input: {},
      });

      // First worker claims it
      const claimed = await persistence.claimNextPendingRun();
      expect(claimed?.status).toBe("RUNNING");

      // When: Second worker tries to claim (should get null)
      const secondAttempt = await persistence.claimNextPendingRun();

      // Then: Second attempt returns null and doesn't affect the workflow
      expect(secondAttempt).toBeNull();

      // Original workflow is still RUNNING (not overwritten to FAILED or anything else)
      const run = await persistence.getRun("run-1");
      expect(run?.status).toBe("RUNNING");
    });
  });

  describe("edge cases", () => {
    it("should handle claiming from mixed status workflows", async () => {
      // Given: Workflows in various states
      await persistence.createRun({
        id: "pending-1",
        workflowId: "test",
        workflowName: "Test",
        workflowType: "test",
        input: {},
      });
      await persistence.createRun({
        id: "running-1",
        workflowId: "test",
        workflowName: "Test",
        workflowType: "test",
        input: {},
      });
      await persistence.createRun({
        id: "pending-2",
        workflowId: "test",
        workflowName: "Test",
        workflowType: "test",
        input: {},
      });

      await persistence.updateRun("running-1", { status: "RUNNING" });

      // When: I claim all available
      const first = await persistence.claimNextPendingRun();
      const second = await persistence.claimNextPendingRun();
      const third = await persistence.claimNextPendingRun();

      // Then: Only pending workflows are claimed
      expect(first?.id).toBe("pending-1");
      expect(second?.id).toBe("pending-2");
      expect(third).toBeNull();
    });
  });
});
