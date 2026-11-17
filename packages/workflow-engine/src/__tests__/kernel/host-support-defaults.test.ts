/**
 * Host helper ergonomics: every tuning field is optional and falls back to
 * HOST_DEFAULTS, so a host (or a consumer's own loop) can pass a partial
 * object. The built-in hosts keep passing full ones.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../../core/workflow.js";
import {
  executeJobWithHeartbeat,
  HOST_DEFAULTS,
  runMaintenanceTick,
} from "../../kernel/helpers/host-support.js";
import type { EventSink } from "../../kernel/ports.js";
import { createTestKernel } from "../utils/index.js";

const In = z.object({ value: z.number() });

const workflow = defineWorkflow("host-defaults", { input: In })
  .stage("double", {
    schemas: {
      input: In,
      output: z.object({ doubled: z.number() }),
      config: z.object({}),
    },
    async execute(ctx) {
      return { output: { doubled: ctx.input.value * 2 } };
    },
  })
  .build();

describe("host support defaults", () => {
  it("exports the defaults it applies", () => {
    expect(HOST_DEFAULTS.workerId).toBe("worker");
    expect(HOST_DEFAULTS.logPrefix).toBe("[Host]");
    expect(HOST_DEFAULTS.maxClaimsPerTick).toBe(10);
  });

  it("runs a maintenance tick with no options at all", async () => {
    const { kernel } = createTestKernel([workflow]);
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "defaults-1",
      workflowId: "host-defaults",
      input: { value: 1 },
    });

    const counts = await runMaintenanceTick(kernel);
    expect(counts.claimed).toBe(1);
  });

  it("accepts a partial maintenance-tick option object", async () => {
    const { kernel } = createTestKernel([workflow]);
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "defaults-2",
      workflowId: "host-defaults",
      input: { value: 1 },
    });

    const counts = await runMaintenanceTick(kernel, { workerId: "w-1" });
    expect(counts.claimed).toBe(1);
    expect(counts.eventsFlushed).toBeGreaterThan(0);
  });

  it("continues maintenance when the event sink never settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { kernel } = createTestKernel<EventSink>([workflow], {
      eventSink: {
        async emit() {
          await blocked;
        },
      },
    });
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "blocked-sink",
      workflowId: "host-defaults",
      input: { value: 1 },
    });
    const tick = runMaintenanceTick(kernel, { outboxFlushTimeoutMs: 5 });
    const result = await Promise.race([
      tick,
      new Promise<"unbounded">((resolve) =>
        setTimeout(() => resolve("unbounded"), 100),
      ),
    ]);
    release();
    await tick;
    expect(result).not.toBe("unbounded");
    if (result !== "unbounded") expect(result.eventSinkStatus).toBe("degraded");
  });

  it("logs a delivery write error and reports degraded while leaving the claim recoverable", async () => {
    const { kernel, persistence, clock } = createTestKernel([workflow]);
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "write-error",
      workflowId: "host-defaults",
      input: { value: 1 },
    });
    const complete = persistence.completeOutboxDelivery.bind(persistence);
    persistence.completeOutboxDelivery = async () => {
      throw new Error("write failed");
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const counts = await runMaintenanceTick(kernel);
      expect(counts.eventSinkStatus).toBe("degraded");
      expect(counts.eventSinkError).toContain("write failed");
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("outbox.flush error"),
        expect.objectContaining({ message: "write failed" }),
      );
    } finally {
      persistence.completeOutboxDelivery = complete;
      log.mockRestore();
    }
    clock.advance(65_001);
    expect(
      (await kernel.dispatch({ type: "outbox.flush" })).published,
    ).toBeGreaterThan(0);
  });

  it("executes a job with only the transport and the job", async () => {
    const { kernel, jobTransport } = createTestKernel([workflow]);
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "defaults-3",
      workflowId: "host-defaults",
      input: { value: 21 },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w-1" });
    const job = await jobTransport.dequeue();

    const outcome = await executeJobWithHeartbeat(kernel, {
      jobTransport,
      job: {
        jobId: job!.jobId,
        workflowRunId: job!.workflowRunId,
        workflowId: job!.workflowId,
        stageId: job!.stageId,
        attempt: job!.attempt,
        payload: job!.payload,
      },
    });

    expect(outcome.outcome).toBe("completed");
  });
});
