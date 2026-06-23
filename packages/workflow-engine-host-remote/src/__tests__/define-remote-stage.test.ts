import { defineStage } from "@bratsos/workflow-engine";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineRemoteStage } from "../orchestrator/define-remote-stage.js";
import type { PollResponse } from "../protocol.js";
import type { OrchestratorTransport } from "../transport.js";

const real = defineStage({
  id: "download",
  name: "Download",
  schemas: {
    input: z.object({}),
    output: z.object({ key: z.string() }),
    config: z.object({}),
  },
  async execute() {
    return { output: { key: "x" } };
  },
});

function ctxStub() {
  return {
    workflowRunId: "r1",
    stageId: "download",
    stageNumber: 1,
    stageName: "Download",
    input: {},
    config: {},
    workflowContext: {},
    log: vi.fn(),
    onLog: vi.fn(),
    annotate: vi.fn(),
    onProgress: vi.fn(),
    storage: {} as never,
  };
}

describe("defineRemoteStage", () => {
  it("execute() submits and returns a schema-valid suspended result carrying the taskId", async () => {
    const transport: OrchestratorTransport = {
      submit: vi.fn(async () => ({
        taskId: "t1",
        pollConfig: {
          pollInterval: 100,
          maxWaitTime: 1000,
          nextPollAt: new Date(0),
        },
      })),
      poll: vi.fn(),
    };
    const proxy = defineRemoteStage(real, transport);
    const result = await proxy.execute(ctxStub() as never);
    expect("suspended" in result && result.suspended).toBe(true);
    expect((result as { state: { batchId: string } }).state.batchId).toBe("t1");
    expect(transport.submit).toHaveBeenCalledOnce();
  });

  it("checkCompletion returns ready+parsed output when reported completed", async () => {
    const poll: PollResponse = {
      state: "reported",
      outcome: { kind: "completed", output: { key: "x" } },
      logs: [{ level: "INFO", message: "hi" }],
      annotations: [["k", "v"]],
      progress: [],
    };
    const transport: OrchestratorTransport = {
      submit: vi.fn(),
      poll: vi.fn(async () => poll),
    };
    const proxy = defineRemoteStage(real, transport);
    const ctx = ctxStub();
    const r = await proxy.checkCompletion!(
      {
        batchId: "t1",
        submittedAt: "",
        pollInterval: 1,
        maxWaitTime: 1,
      } as never,
      ctx as never,
    );
    expect(r.ready).toBe(true);
    expect(r.output).toEqual({ key: "x" });
    expect(ctx.log).toHaveBeenCalledWith("INFO", "hi", undefined);
    expect(ctx.annotate).toHaveBeenCalledWith("k", "v");
  });

  it("checkCompletion returns error when the reported output fails the strict schema gate", async () => {
    const poll: PollResponse = {
      state: "reported",
      outcome: { kind: "completed", output: { wrong: true } },
      logs: [],
      annotations: [],
      progress: [],
    };
    const transport: OrchestratorTransport = {
      submit: vi.fn(),
      poll: vi.fn(async () => poll),
    };
    const proxy = defineRemoteStage(real, transport);
    const r = await proxy.checkCompletion!(
      { batchId: "t1" } as never,
      ctxStub() as never,
    );
    expect(r.ready).toBe(false);
    expect(r.error).toMatch(/schema|valid/i);
  });

  it("checkCompletion keeps waiting while pending/assigned and fails on a failed outcome", async () => {
    const pending: PollResponse = {
      state: "pending",
      logs: [],
      annotations: [],
      progress: [],
      nextCheckIn: 250,
    };
    const failed: PollResponse = {
      state: "reported",
      outcome: { kind: "failed", error: "boom" },
      logs: [],
      annotations: [],
      progress: [],
    };
    const transport: OrchestratorTransport = {
      submit: vi.fn(),
      poll: vi.fn(async () => pending),
    };
    const proxy = defineRemoteStage(real, transport);
    expect(
      await proxy.checkCompletion!(
        { batchId: "t" } as never,
        ctxStub() as never,
      ),
    ).toEqual({ ready: false, nextCheckIn: 250 });
    (transport.poll as ReturnType<typeof vi.fn>).mockResolvedValueOnce(failed);
    const r = await proxy.checkCompletion!(
      { batchId: "t" } as never,
      ctxStub() as never,
    );
    expect(r.ready).toBe(false);
    expect(r.error).toBe("boom");
  });
});
