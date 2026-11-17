import { describe, expect, it } from "vitest";
import {
  type AttemptEventInput,
  type AttemptStageInput,
  type AttemptStepInput,
  buildStageAttemptHistory,
  type EventCoverage,
  type HeldStageEvents,
  mergeStageEvents,
  type StageEventPage,
} from "../stage-attempts";

const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000);

let seq = 0;
const ev = (
  stageId: string,
  eventType: string,
  seconds: number,
  error: string | null = null,
): AttemptEventInput => ({
  sequence: ++seq,
  eventType,
  occurredAt: at(seconds),
  stageId,
  error,
});

/** A run-level event (`workflow:started`, `workflow:cancelled`): it names no stage. */
const run = (eventType: string, seconds: number): AttemptEventInput => ({
  sequence: ++seq,
  eventType,
  occurredAt: at(seconds),
  stageId: null,
  error: null,
});

const stage = (
  stageId: string,
  status: string,
  attempt = 0,
): AttemptStageInput => ({ id: `rec-${stageId}`, stageId, attempt, status });

const step = (
  stageId: string,
  stepId: string,
  seq_: number,
  created: number,
  updated: number,
  overrides: Partial<AttemptStepInput> = {},
): AttemptStepInput => ({
  stageRecordId: `rec-${stageId}`,
  stepId,
  seq: seq_,
  kind: "run",
  status: "completed",
  attempt: 1,
  externalKey: null,
  error: null,
  createdAt: at(created),
  updatedAt: at(updated),
  ...overrides,
});

function history(
  stages: AttemptStageInput[],
  events: AttemptEventInput[],
  steps: AttemptStepInput[] = [],
  options: {
    redriveCount?: number;
    coverage?: EventCoverage;
    caughtUp?: boolean;
  } = {},
) {
  return buildStageAttemptHistory({
    redriveCount: options.redriveCount ?? 0,
    stages,
    steps,
    stageEvents: {
      events,
      coverage: options.coverage ?? "from-start",
      ...(options.caughtUp === undefined ? {} : { caughtUp: options.caughtUp }),
    },
  });
}

function available(result: ReturnType<typeof history>, stageId: string) {
  const entry = result.get(`rec-${stageId}`);
  if (!entry?.available) {
    throw new Error(`expected ${stageId} to have an attempt history`);
  }
  return entry;
}

describe("I want a stage's history grouped by attempt, and never grouped wrongly", () => {
  it("shows one attempt for a stage that did not retry, with the steps that ran in it", () => {
    seq = 0;
    const result = history(
      [stage("a", "COMPLETED")],
      [ev("a", "stage:started", 0), ev("a", "stage:completed", 10)],
      [step("a", "work", 1, 2, 5, { externalKey: "wf:run:a:work" })],
    );

    const { attempts, unplacedSteps } = available(result, "a");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      number: 1,
      trigger: "initial",
      outcome: "completed",
      startedAt: at(0).toISOString(),
      endedAt: at(10).toISOString(),
      error: null,
    });
    expect(attempts[0]!.events.map((e) => e.eventType)).toEqual([
      "stage:started",
      "stage:completed",
    ]);
    expect(attempts[0]!.steps).toEqual([
      {
        stepId: "work",
        seq: 1,
        kind: "run",
        status: "completed",
        attempt: 1,
        durationMs: 3000,
        error: null,
        externalKey: "wf:run:a:work",
      },
    ]);
    expect(unplacedSteps).toEqual([]);
  });

  it("splits a job retry at stage:retrying and places a re-executed step in the attempt it last changed in", () => {
    seq = 0;
    const result = history(
      [stage("a", "COMPLETED", 1)],
      [
        ev("a", "stage:started", 0),
        ev("a", "stage:retrying", 10, "upstream 503"),
        ev("a", "stage:started", 40),
        ev("a", "stage:completed", 50),
      ],
      [
        step("a", "fetch", 1, 1, 4),
        // Failed in attempt 1, re-opened, and finished in attempt 2: its row
        // now holds the second execution, so it sits in attempt 2.
        step("a", "send", 2, 5, 45, { attempt: 2 }),
      ],
    );

    const { attempts } = available(result, "a");
    expect(attempts.map((a) => [a.number, a.trigger, a.outcome])).toEqual([
      [1, "initial", "retrying"],
      [2, "job-retry", "completed"],
    ]);
    expect(attempts[0]).toMatchObject({
      error: "upstream 503",
      endedAt: at(10).toISOString(),
    });
    expect(attempts[0]!.steps.map((s) => s.stepId)).toEqual(["fetch"]);
    expect(attempts[1]!.startedAt).toBe(at(40).toISOString());
    expect(attempts[1]!.steps.map((s) => [s.stepId, s.attempt])).toEqual([
      ["send", 2],
    ]);
    // Two executions: the row cannot say how long the last one took.
    expect(attempts[1]!.steps[0]!.durationMs).toBeNull();
  });

  it("treats a retry inside stage.pollSuspended as an attempt boundary without a stage:started", () => {
    seq = 0;
    const result = history(
      [stage("a", "COMPLETED", 1)],
      [
        ev("a", "stage:started", 0),
        ev("a", "stage:suspended", 5),
        ev("a", "stage:retrying", 30, "poll replay threw"),
        ev("a", "stage:completed", 60),
      ],
      [step("a", "wait", 1, 3, 55, { kind: "wait", attempt: 2 })],
    );

    const { attempts } = available(result, "a");
    expect(attempts.map((a) => [a.number, a.trigger, a.outcome])).toEqual([
      [1, "initial", "retrying"],
      [2, "poll-retry", "completed"],
    ]);
    expect(attempts[0]!.events.map((e) => e.eventType)).toEqual([
      "stage:started",
      "stage:suspended",
      "stage:retrying",
    ]);
    // The new attempt begins when the retry was recorded; its own events are
    // only what follows.
    expect(attempts[1]!.startedAt).toBe(at(30).toISOString());
    expect(attempts[1]!.events.map((e) => e.eventType)).toEqual([
      "stage:completed",
    ]);
    expect(attempts[1]!.steps.map((s) => s.stepId)).toEqual(["wait"]);
  });

  it("keeps a stage that suspended and resumed inside one attempt as one attempt", () => {
    seq = 0;
    const result = history(
      [stage("a", "COMPLETED")],
      [
        ev("a", "stage:started", 0),
        ev("a", "stage:suspended", 5),
        ev("a", "stage:suspended", 20),
        ev("a", "stage:completed", 40),
      ],
    );

    const { attempts } = available(result, "a");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe("completed");
    expect(attempts[0]!.events.map((e) => e.eventType)).toEqual([
      "stage:started",
      "stage:suspended",
      "stage:suspended",
      "stage:completed",
    ]);
  });

  it("takes the outcome of an attempt that is still open from the stage row", () => {
    seq = 0;
    const events = [ev("a", "stage:started", 0), ev("a", "stage:suspended", 5)];
    const open = (status: string) =>
      available(history([stage("a", status)], events), "a").attempts[0]!;

    expect(open("SUSPENDED")).toMatchObject({
      outcome: "suspended",
      endedAt: null,
    });
    // CANCELLED with an attempt open needs a retained cancel before its start
    // (a job that ran after the run was cancelled writes no end event).
    expect(history([stage("a", "CANCELLED")], events).get("rec-a")).toEqual({
      stageRecordId: "rec-a",
      available: false,
      reason: "inconsistent",
      mismatch: "status",
    });
    seq = 0;
    expect(
      available(
        history(
          [stage("a", "CANCELLED")],
          [run("workflow:cancelled", 0), ev("a", "stage:started", 1)],
        ),
        "a",
      ).attempts[0],
    ).toMatchObject({ outcome: "cancelled", endedAt: null });
    expect(
      available(
        history([stage("a", "RUNNING")], [ev("a", "stage:started", 0)]),
        "a",
      ).attempts[0]!.outcome,
    ).toBe("running");
  });

  it("keeps a failed stage's last error and a rerun after a terminal outcome as a new attempt", () => {
    seq = 0;
    const events = [
      ev("a", "stage:started", 0),
      ev("a", "stage:failed", 10, "boom"),
      run("workflow:started", 50),
      ev("a", "stage:started", 100),
      ev("a", "stage:completed", 110),
    ];
    // A redrive renumbers the row either way: reopened it is one past the
    // highest in its group, recreated (a later stage) it starts again at 0.
    for (const rowAttempt of [3, 0]) {
      const redriven = available(
        history([stage("a", "COMPLETED", rowAttempt)], events, [], {
          redriveCount: 1,
        }),
        "a",
      );
      expect(
        redriven.attempts.map((a) => [a.trigger, a.outcome, a.error]),
      ).toEqual([
        ["initial", "failed", "boom"],
        ["rerun", "completed", null],
      ]);
    }

    // A start after the stage ended with no redrive recorded is a restart,
    // which the row counts like any other attempt.
    seq = 0;
    const restarted = [
      ev("a", "stage:started", 0),
      ev("a", "stage:failed", 10, "boom"),
      ev("a", "stage:started", 100),
      ev("a", "stage:completed", 110),
    ];
    expect(
      available(
        history([stage("a", "COMPLETED", 1)], restarted),
        "a",
      ).attempts.map((a) => [a.trigger, a.outcome]),
    ).toEqual([
      ["initial", "failed"],
      ["restart", "completed"],
    ]);
    expect(
      history([stage("a", "COMPLETED", 0)], restarted).get("rec-a"),
    ).toMatchObject({
      available: false,
      reason: "inconsistent",
      mismatch: "attempt",
    });
  });

  it("puts a step in no attempt when its last change matches none or two", () => {
    seq = 0;
    const result = history(
      [stage("a", "COMPLETED", 1)],
      [
        ev("a", "stage:started", 0),
        ev("a", "stage:suspended", 5),
        ev("a", "stage:retrying", 30, "x"),
        ev("a", "stage:completed", 60),
      ],
      [
        step("a", "on-boundary", 1, 1, 30),
        step("a", "before-everything", 2, -50, -40),
        step("a", "inside", 3, 31, 40),
      ],
    );

    const { attempts, unplacedSteps } = available(result, "a");
    expect(unplacedSteps.map((s) => s.stepId)).toEqual([
      "on-boundary",
      "before-everything",
    ]);
    expect(attempts.flatMap((a) => a.steps.map((s) => s.stepId))).toEqual([
      "inside",
    ]);

    // A gap between attempts (the job-retry backoff) holds none either.
    seq = 0;
    const gap = history(
      [stage("a", "COMPLETED", 1)],
      [
        ev("a", "stage:started", 0),
        ev("a", "stage:retrying", 10, "x"),
        ev("a", "stage:started", 40),
        ev("a", "stage:completed", 50),
      ],
      [step("a", "reopened", 1, 1, 25, { status: "running" })],
    );
    expect(available(gap, "a").unplacedSteps.map((s) => s.stepId)).toEqual([
      "reopened",
    ]);
  });

  it("reports why the history is unavailable instead of guessing a grouping", () => {
    seq = 0;
    const events = [
      ev("a", "stage:started", 0),
      ev("a", "stage:completed", 10),
    ];
    const stages = [stage("a", "COMPLETED")];
    const reason = (result: ReturnType<typeof history>) => {
      const entry = result.get("rec-a")!;
      return entry.available ? "available" : entry.reason;
    };

    expect(
      reason(buildStageAttemptHistory({ redriveCount: 0, stages, steps: [] })),
    ).toBe("no-event-history");
    expect(reason(history(stages, events, [], { coverage: "gap" }))).toBe(
      "events-incomplete",
    );
    expect(reason(history(stages, [], [], { coverage: "none" }))).toBe(
      "no-retained-events",
    );
    expect(reason(history(stages, [], [], { caughtUp: false }))).toBe(
      "events-loading",
    );
    expect(reason(history(stages, []))).toBe("no-stage-events");
    // An end event for an attempt that never started contradicts the history.
    expect(reason(history(stages, [events[1]!]))).toBe("unproven-boundary");
    // The row says FAILED, the events say COMPLETED.
    expect(reason(history([stage("a", "FAILED")], events))).toBe(
      "inconsistent",
    );
    // One retry in the events, but the row never counted a second attempt.
    seq = 0;
    expect(
      reason(
        history(stages, [
          ev("a", "stage:started", 0),
          ev("a", "stage:retrying", 5, "x"),
          ev("a", "stage:started", 9),
          ev("a", "stage:completed", 10),
        ]),
      ),
    ).toBe("inconsistent");
    // A stage that has not run yet has no attempts and nothing to doubt.
    expect(
      available(history([stage("a", "PENDING")], []), "a").attempts,
    ).toEqual([]);
  });

  it("groups the stages of a parallel group independently, from ISO timestamps as the UI receives them", () => {
    seq = 0;
    const events = [
      ev("a", "stage:started", 0),
      ev("b", "stage:started", 0),
      ev("a", "stage:retrying", 10, "a failed"),
      ev("b", "stage:suspended", 11),
      ev("b", "stage:retrying", 20, "b failed once"),
      ev("a", "stage:started", 40),
      ev("b", "stage:retrying", 50, "b failed twice"),
      ev("a", "stage:completed", 55),
      ev("b", "stage:completed", 70),
    ];
    const asJson = events.map((e) => ({
      ...e,
      occurredAt: (e.occurredAt as Date).toISOString(),
    }));
    const steps = [
      step("a", "a-step", 1, 41, 45, { attempt: 2 }),
      step("b", "b-early", 1, 2, 8),
      step("b", "b-late", 2, 52, 65, { attempt: 3 }),
    ].map((s) => ({
      ...s,
      createdAt: (s.createdAt as Date).toISOString(),
      updatedAt: (s.updatedAt as Date).toISOString(),
    }));

    const result = buildStageAttemptHistory({
      redriveCount: 0,
      stages: [stage("a", "COMPLETED", 1), stage("b", "COMPLETED", 2)],
      steps,
      stageEvents: { events: asJson, coverage: "from-start" },
    });

    const a = available(result, "a").attempts;
    const b = available(result, "b").attempts;
    expect(a.map((x) => [x.trigger, x.outcome, x.error])).toEqual([
      ["initial", "retrying", "a failed"],
      ["job-retry", "completed", null],
    ]);
    expect(b.map((x) => [x.trigger, x.outcome, x.error])).toEqual([
      ["initial", "retrying", "b failed once"],
      ["poll-retry", "retrying", "b failed twice"],
      ["poll-retry", "completed", null],
    ]);
    expect(a.map((x) => x.steps.map((s) => s.stepId))).toEqual([
      [],
      ["a-step"],
    ]);
    expect(b.map((x) => x.steps.map((s) => s.stepId))).toEqual([
      ["b-early"],
      [],
      ["b-late"],
    ]);
    expect(a.flatMap((x) => x.events).every((e) => e.sequence > 0)).toBe(true);
  });

  it("closes an open attempt as cancelled at workflow:cancelled and makes the next start a rerun", () => {
    seq = 0;
    const events = [
      run("workflow:started", 0),
      ev("a", "stage:started", 1),
      ev("a", "stage:suspended", 2),
      ev("b", "stage:started", 1),
      ev("b", "stage:completed", 3),
      run("workflow:cancelled", 10),
      run("workflow:started", 20),
      ev("a", "stage:started", 21),
      ev("a", "stage:completed", 30),
    ];
    const result = history(
      [stage("a", "COMPLETED", 1), stage("b", "COMPLETED")],
      events,
      [],
      { redriveCount: 1 },
    );

    const a = available(result, "a").attempts;
    expect(a.map((x) => [x.trigger, x.outcome, x.endedAt])).toEqual([
      ["initial", "cancelled", at(10).toISOString()],
      ["rerun", "completed", at(30).toISOString()],
    ]);
    expect(a[0]!.events.map((e) => e.eventType)).toEqual([
      "stage:started",
      "stage:suspended",
      "workflow:cancelled",
    ]);
    // A stage that had finished before the cancel keeps its one attempt.
    expect(available(result, "b").attempts.map((x) => x.outcome)).toEqual([
      "completed",
    ]);
  });

  it("explains a CANCELLED row whose last attempt closed before the cancel only by a redrive in between", () => {
    seq = 0;
    const failedThenRedriven = [
      ev("a", "stage:started", 0),
      ev("a", "stage:failed", 5, "boom"),
      run("workflow:started", 10),
      run("workflow:cancelled", 11),
    ];
    const redriveCount = { redriveCount: 1 };
    expect(
      available(
        history(
          [stage("a", "CANCELLED", 1)],
          failedThenRedriven,
          [],
          redriveCount,
        ),
        "a",
      ).attempts.map((x) => x.outcome),
    ).toEqual(["failed"]);
    // The cancel alone cannot cancel a stage that already failed.
    seq = 0;
    expect(
      history(
        [stage("a", "CANCELLED")],
        [
          ev("a", "stage:started", 0),
          ev("a", "stage:failed", 5, "boom"),
          run("workflow:cancelled", 11),
        ],
      ).get("rec-a"),
    ).toMatchObject({ available: false, reason: "inconsistent" });
  });

  it("shows a second stage:started as a new attempt and the earlier one as having no recorded end", () => {
    seq = 0;
    const result = history(
      [stage("a", "COMPLETED")],
      [
        ev("a", "stage:started", 0),
        ev("a", "stage:started", 10),
        ev("a", "stage:completed", 20),
      ],
      [
        step("a", "inside-lost", 1, 1, 4),
        step("a", "on-the-next-start", 2, 1, 10),
        step("a", "inside-next", 3, 11, 15),
      ],
    );

    const { attempts, unplacedSteps } = available(result, "a");
    expect(attempts.map((x) => [x.trigger, x.outcome, x.executed])).toEqual([
      ["initial", "lost", true],
      ["redelivery", "completed", true],
    ]);
    // No end event: `endedAt` is null, the window closes where the next
    // execution started, and the lost attempt carries no error.
    expect(attempts[0]).toMatchObject({
      endedAt: null,
      windowEndedAt: at(10).toISOString(),
      error: null,
    });
    expect(attempts[1]).toMatchObject({
      startedAt: at(10).toISOString(),
      endedAt: at(20).toISOString(),
    });
    // Steps are placed by time only; one on the shared instant is not guessed.
    expect(attempts[0]!.steps.map((x) => x.stepId)).toEqual(["inside-lost"]);
    expect(attempts[1]!.steps.map((x) => x.stepId)).toEqual(["inside-next"]);
    expect(unplacedSteps.map((x) => x.stepId)).toEqual(["on-the-next-start"]);
    // The engine does not count a re-delivery on the stage row: row attempt 0
    // matches two executions of one attempt, row attempt 1 does not.
    seq = 0;
    expect(
      history(
        [stage("a", "COMPLETED", 1)],
        [
          ev("a", "stage:started", 0),
          ev("a", "stage:started", 10),
          ev("a", "stage:completed", 20),
        ],
      ).get("rec-a"),
    ).toMatchObject({
      available: false,
      reason: "inconsistent",
      mismatch: "attempt",
    });
  });

  it("chains re-deliveries and keeps a retry's own attempt count", () => {
    seq = 0;
    const result = history(
      [stage("a", "COMPLETED", 1)],
      [
        ev("a", "stage:started", 0),
        ev("a", "stage:started", 10),
        ev("a", "stage:started", 20),
        ev("a", "stage:retrying", 25, "boom"),
        ev("a", "stage:started", 40),
        ev("a", "stage:completed", 50),
      ],
    );
    expect(
      available(result, "a").attempts.map((x) => [x.trigger, x.outcome]),
    ).toEqual([
      ["initial", "lost"],
      ["redelivery", "lost"],
      ["redelivery", "retrying"],
      ["job-retry", "completed"],
    ]);
  });

  it("groups a stage failed while it waited, as an attempt that never started", () => {
    seq = 0;
    // A job retry was pending when `run.reapStuck` failed the stage.
    const waiting = available(
      history(
        [stage("a", "FAILED")],
        [
          ev("a", "stage:started", 0),
          ev("a", "stage:retrying", 5, "boom"),
          ev(
            "a",
            "stage:failed",
            60,
            "Run stuck for >300000ms with no activity",
          ),
        ],
      ),
      "a",
    ).attempts;
    expect(waiting.map((x) => [x.trigger, x.outcome, x.executed])).toEqual([
      ["initial", "retrying", true],
      ["job-retry", "failed", false],
    ]);
    expect(waiting[1]).toMatchObject({
      startedAt: at(60).toISOString(),
      endedAt: at(60).toISOString(),
      error: "Run stuck for >300000ms with no activity",
    });
    // A stage that never started at all.
    seq = 0;
    expect(
      available(
        history([stage("a", "FAILED")], [ev("a", "stage:failed", 60, "stuck")]),
        "a",
      ).attempts.map((x) => [x.trigger, x.outcome, x.executed]),
    ).toEqual([["initial", "failed", false]]);
    // After a redrive reopened it.
    seq = 0;
    expect(
      available(
        history(
          [stage("a", "FAILED", 2)],
          [
            ev("a", "stage:started", 0),
            ev("a", "stage:failed", 5, "boom"),
            run("workflow:started", 10),
            ev("a", "stage:failed", 70, "stuck"),
          ],
          [],
          { redriveCount: 1 },
        ),
        "a",
      ).attempts.map((x) => [x.trigger, x.outcome, x.executed]),
    ).toEqual([
      ["initial", "failed", true],
      ["rerun", "failed", false],
    ]);
  });

  it("falls back as unproven when the events contradict themselves", () => {
    const reason = (events: AttemptEventInput[], status = "COMPLETED") => {
      const entry = history([stage("a", status, 1)], events, [], {
        redriveCount: 1,
      }).get("rec-a")!;
      return entry.available ? "available" : entry.reason;
    };
    // The run restarted while an attempt was still open: a redrive takes only
    // a run whose attempts all ended, so the history contradicts itself.
    seq = 0;
    expect(
      reason([
        ev("a", "stage:started", 0),
        run("workflow:started", 10),
        ev("a", "stage:completed", 20),
      ]),
    ).toBe("unproven-boundary");
    // An end event for an attempt that is not open.
    seq = 0;
    expect(
      reason([
        ev("a", "stage:started", 0),
        ev("a", "stage:completed", 10),
        ev("a", "stage:completed", 20),
      ]),
    ).toBe("unproven-boundary");
    seq = 0;
    expect(reason([ev("a", "stage:suspended", 5)])).toBe("unproven-boundary");
    // A completed stage is terminal: nothing fails it without a redrive.
    seq = 0;
    expect(
      reason(
        [
          ev("a", "stage:started", 0),
          ev("a", "stage:completed", 10),
          ev("a", "stage:failed", 20, "x"),
        ],
        "FAILED",
      ),
    ).toBe("unproven-boundary");
    // A cancelled stage is terminal too.
    seq = 0;
    expect(
      reason(
        [
          ev("a", "stage:started", 0),
          run("workflow:cancelled", 10),
          ev("a", "stage:failed", 20, "x"),
        ],
        "FAILED",
      ),
    ).toBe("unproven-boundary");
  });

  it("carries the reader's cut flag from a closing event to its attempt", () => {
    seq = 0;
    const events = [
      ev("a", "stage:started", 0),
      { ...ev("a", "stage:failed", 5, "long error"), errorTruncated: true },
    ];
    const attempt = available(history([stage("a", "FAILED")], events), "a")
      .attempts[0]!;
    expect(attempt).toMatchObject({
      error: "long error",
      errorTruncated: true,
    });
    expect(attempt.events.map((e) => e.errorTruncated)).toEqual([false, true]);
  });

  it("says a stage has not started only when its record was never stamped by a start", () => {
    // N1, tail form: the run's first rows are retained, the stage's are not,
    // and its row (cancelled while it ran) has a start time.
    const cancelledWhileRunning = {
      ...stage("a", "CANCELLED"),
      startedAt: at(3),
      completedAt: at(4),
      errorMessage: null,
    };
    expect(
      history([cancelledWhileRunning], [run("workflow:started", 2)]).get(
        "rec-a",
      ),
    ).toMatchObject({ available: false, reason: "no-stage-events" });
    expect(
      available(
        history(
          [{ ...cancelledWhileRunning, startedAt: null }],
          [run("workflow:started", 2)],
        ),
        "a",
      ).attempts,
    ).toEqual([]);
  });

  it("names the field of the stage's record that its events do not agree with", () => {
    seq = 0;
    const events = [
      ev("a", "stage:started", 0),
      ev("a", "stage:retrying", 5, "boom"),
      ev("a", "stage:started", 10),
      ev("a", "stage:failed", 20, "fatal"),
    ];
    const row = {
      ...stage("a", "FAILED", 1),
      startedAt: at(10),
      completedAt: at(20),
      errorMessage: "fatal",
    };
    const mismatch = (overrides: object, list = events, redriveCount = 0) => {
      const entry = history([{ ...row, ...overrides }], list, [], {
        redriveCount,
      }).get("rec-a")!;
      return entry.available ? "agrees" : `${entry.reason}:${entry.mismatch}`;
    };
    expect(mismatch({})).toBe("agrees");
    // A start or an end stamped after the last retained one: the events that
    // followed are not retained.
    expect(mismatch({ startedAt: at(15) })).toBe("inconsistent:startedAt");
    expect(mismatch({ completedAt: at(25) })).toBe("inconsistent:completedAt");
    expect(mismatch({ completedAt: null })).toBe("inconsistent:completedAt");
    expect(mismatch({ errorMessage: "another" })).toBe(
      "inconsistent:errorMessage",
    );
    expect(mismatch({ errorMessage: null })).toBe("inconsistent:errorMessage");
    // A row never stamped by a start, with a start retained and no redrive.
    expect(mismatch({ startedAt: null })).toBe("inconsistent:startedAt");
    // A redrive recreates a later stage's row with no start time and no error.
    seq = 0;
    const redriven = [
      ev("a", "stage:started", 0),
      ev("a", "stage:failed", 5, "boom"),
      run("workflow:started", 10),
    ];
    expect(
      mismatch(
        {
          status: "PENDING",
          attempt: 0,
          startedAt: null,
          completedAt: null,
          errorMessage: null,
        },
        redriven,
        1,
      ),
    ).toBe("agrees");
    // A PENDING row with an ended attempt and no redrive or retry to wait for.
    seq = 0;
    expect(
      mismatch(
        {
          status: "PENDING",
          attempt: 0,
          startedAt: at(0),
          completedAt: null,
          errorMessage: null,
        },
        [ev("a", "stage:started", 0), ev("a", "stage:completed", 5)],
      ),
    ).toBe("inconsistent:status");
    // CANCELLED while it waited for a job retry needs the cancel retained.
    seq = 0;
    const waited = [
      ev("a", "stage:started", 0),
      ev("a", "stage:retrying", 5, "boom"),
    ];
    const cancelledRow = {
      status: "CANCELLED",
      attempt: 0,
      startedAt: at(0),
      completedAt: at(9),
      errorMessage: "boom",
    };
    expect(mismatch(cancelledRow, waited)).toBe("inconsistent:status");
    expect(
      mismatch(cancelledRow, [...waited, run("workflow:cancelled", 9)]),
    ).toBe("agrees");
    // An error cut by the reader agrees with the row's whole text.
    seq = 0;
    expect(
      mismatch(
        {
          attempt: 0,
          startedAt: at(0),
          completedAt: at(5),
          errorMessage: "long error text",
        },
        [
          ev("a", "stage:started", 0),
          { ...ev("a", "stage:failed", 5, "long"), errorTruncated: true },
        ],
      ),
    ).toBe("agrees");
  });
});

describe("I want the page to keep the events it has read and fold each poll into them", () => {
  const e = (sequence: number) =>
    ({
      sequence,
      eventType: "stage:started",
      occurredAt: at(sequence),
      stageId: "a",
      error: null,
    }) satisfies AttemptEventInput;
  const page = (
    after: number,
    last: number,
    complete = true,
    more = false,
  ): StageEventPage => ({
    events: Array.from({ length: last - after }, (_, i) => e(after + i + 1)),
    after,
    lastSequence: last,
    complete,
    more,
  });
  const fold = (...pages: StageEventPage[]) =>
    pages.reduce<HeldStageEvents | null>(mergeStageEvents, null);

  it("holds a first read, appends each poll's rows once, and ignores a read that is not newer", () => {
    const first = fold(page(0, 3));
    expect(first).toMatchObject({ lastSequence: 3, coverage: "from-start" });
    const second = mergeStageEvents(first, page(3, 5))!;
    expect(second.events.map((x) => x.sequence)).toEqual([1, 2, 3, 4, 5]);
    // A response that arrives late changes nothing.
    expect(mergeStageEvents(second, page(3, 4))).toBe(second);
    // A reader that ignores `after` and returns everything adds each event once.
    const full = mergeStageEvents(second, page(0, 6))!;
    expect(full.events.map((x) => x.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("says a run with no retained row has none, not that its history is empty", () => {
    // N1: the first read of a run whose outbox rows were all removed.
    const none = fold(page(0, 0));
    expect(none).toMatchObject({ coverage: "none", lastSequence: 0 });
    // Even when a reader calls the empty range complete.
    expect(fold({ ...page(0, 0), complete: true })?.coverage).toBe("none");
    // Rows written after that are not the run's first ones.
    expect(mergeStageEvents(none, page(0, 2))?.coverage).toBe("gap");
  });

  it("keeps a gap once one was read", () => {
    const broken = fold(page(0, 3), page(3, 5, false))!;
    expect(broken.coverage).toBe("gap");
    expect(mergeStageEvents(broken, page(5, 6))?.coverage).toBe("gap");
    expect(fold(page(0, 4, false))?.coverage).toBe("gap");
  });

  it("takes no response that does not continue what it holds: another run's, or an answer to a request it did not make", () => {
    // N2: nothing held, and a read that starts past the beginning (the page
    // of another run, or of an older view of this one) begins nothing.
    expect(fold(page(7, 9))).toBeNull();
    // Held up to 3: a read from 7 leaves 4..7 unread, so it is not taken,
    // and the next request asks from 3 again.
    const held = fold(page(0, 3))!;
    expect(mergeStageEvents(held, page(7, 9))).toBe(held);
    expect(mergeStageEvents(held, page(7, 9, false))).toBe(held);
  });

  it("keeps asking from the last sequence until a long history has caught up", () => {
    const first = fold(page(0, 2, true, true));
    expect(first).toMatchObject({
      lastSequence: 2,
      coverage: "from-start",
      more: true,
    });
    const second = mergeStageEvents(first, page(2, 4, true, true))!;
    expect(second.more).toBe(true);
    const last = mergeStageEvents(second, page(4, 5))!;
    expect(last.events.map((x) => x.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(last).toMatchObject({
      lastSequence: 5,
      coverage: "from-start",
      more: false,
    });
    // A reader that predates `more` is taken as caught up.
    const { more: _more, ...legacy } = page(0, 1);
    expect(fold(legacy)?.more).toBe(false);
    // A reader that says `more` without advancing adds nothing.
    expect(mergeStageEvents(last, page(5, 5, true, true))).toBe(last);
  });
});
