import { describe, expect, it } from "vitest";
import {
  encodeValue,
  type StoredRowsSnapshot,
  snapshotCaptureTime,
} from "./snapshot.js";

function snapshot(
  tables: StoredRowsSnapshot["tables"],
  captureTime?: string,
): StoredRowsSnapshot {
  return {
    format: 1,
    metadata: {
      release: "1.0.0-alpha.13",
      database: "postgresql",
      prismaMajor: 6,
      scenario: "wait-for",
      inFlightPoint: "stage suspended",
      expectedFinalOutcome: { status: "COMPLETED", output: null },
      skippedScenarios: [],
      ...(captureTime ? { captureTime } : {}),
    },
    columns: {},
    jsonColumns: {},
    tables,
  };
}

describe("stored-row snapshot capture time", () => {
  it("uses the recorded capture time when present", () => {
    const capturedAt = "2025-02-03T04:05:06.000Z";
    const value = snapshot(
      {
        WorkflowRun: [
          { updatedAt: encodeValue(new Date("2025-02-03T04:05:09.000Z")) },
        ],
      },
      capturedAt,
    );

    expect(snapshotCaptureTime(value).toISOString()).toBe(capturedAt);
  });

  it("derives legacy capture time from the newest lifecycle timestamp", () => {
    const value = snapshot({
      WorkflowRun: [
        { createdAt: encodeValue(new Date("2025-02-03T04:05:01.000Z")) },
      ],
      WorkflowStage: [
        { updatedAt: encodeValue(new Date("2025-02-03T04:05:06.000Z")) },
      ],
      WorkflowStep: [
        {
          updatedAt: encodeValue(new Date("2025-02-03T04:05:04.000Z")),
          deadlineAt: encodeValue(new Date("2025-02-03T05:05:04.000Z")),
          nextPollAt: encodeValue(new Date("2025-02-03T04:05:07.000Z")),
        },
      ],
    });

    expect(snapshotCaptureTime(value).toISOString()).toBe(
      "2025-02-03T04:05:06.000Z",
    );
  });

  it("rejects snapshots with no usable capture timestamp", () => {
    expect(() =>
      snapshotCaptureTime(snapshot({ WorkflowRun: [{ id: "run" }] })),
    ).toThrow("Cannot derive capture time for 1.0.0-alpha.13/wait-for");
  });
});
