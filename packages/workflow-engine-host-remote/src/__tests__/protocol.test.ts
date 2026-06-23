import { describe, expect, it } from "vitest";
import { ActivityReportSchema, ActivityTaskSchema } from "../protocol.js";

describe("protocol", () => {
  it("parses a valid ActivityTask", () => {
    const task = {
      taskId: "t1", leaseToken: "lt1", workflowRunId: "r1",
      stageId: "download", stageName: "Download", stageNumber: 1, attempt: 0,
      input: { url: "x" }, config: {}, workflowContext: {},
      grant: { prefix: "remote-activity/r1/download/t1/", expiresAt: "2026-01-01T00:00:00.000Z", presignEndpoint: "mem://presign" },
      deadline: "2026-01-01T00:00:00.000Z",
    };
    expect(ActivityTaskSchema.parse(task).taskId).toBe("t1");
  });

  it("accepts a completed report and rejects an unknown outcome kind", () => {
    const report = {
      taskId: "t1", leaseToken: "lt1",
      outcome: { kind: "completed", output: { ok: true } },
      logs: [], annotations: [], progress: [],
    };
    expect(ActivityReportSchema.parse(report).outcome.kind).toBe("completed");
    expect(() => ActivityReportSchema.parse({ ...report, outcome: { kind: "weird" } })).toThrow();
  });
});
