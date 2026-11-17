import { describe, expect, it } from "vitest";
import {
  type AttemptEventInput,
  type AttemptStageInput,
  type AttemptStepInput,
  buildStageAttemptHistory,
  CATCH_UP_READS_PER_INTERVAL,
  catchUpStep,
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
    runStatus?: string;
    coverage?: EventCoverage;
    caughtUp?: boolean;
    paused?: boolean;
  } = {},
) {
  // The run's first rows, as `run.create` and the claim write them, unless the
  // test gives its own.
  const head: AttemptEventInput[] = [];
  if (!events.some((e) => e.eventType === "workflow:created")) {
    head.push({ ...run("workflow:created", -2), sequence: -1 });
    const firstRun = events.find((e) => e.stageId === null);
    const claimed =
      firstRun?.eventType === "workflow:started" &&
      !events.some((e) => e.stageId !== null && e.sequence < firstRun.sequence);
    if (!claimed) head.push({ ...run("workflow:started", -1), sequence: 0 });
    seq -= head.length;
  }
  return buildStageAttemptHistory({
    redriveCount: options.redriveCount ?? 0,
    ...(options.runStatus === undefined
      ? {}
      : { runStatus: options.runStatus }),
    stages,
    steps,
    stageEvents: {
      events: [...head, ...events],
      coverage: options.coverage ?? "from-start",
      ...(options.caughtUp === undefined ? {} : { caughtUp: options.caughtUp }),
      ...(options.paused === undefined ? {} : { paused: options.paused }),
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
      run("workflow:failed", 11),
      run("workflow:started", 50),
      ev("a", "stage:started", 100),
      ev("a", "stage:completed", 110),
    ];
    // A redrive renumbers the row either way: reopened it is its attempt plus
    // 1, recreated (a later stage) it starts again at 0.
    for (const rowAttempt of [1, 0]) {
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

    // A start after the stage ended with no redrive recorded is a restart.
    // `job.execute` adds to the row only on a retry of a PENDING row that kept
    // its error, so a restart of a FAILED row leaves its attempt as it was.
    seq = 0;
    const restarted = [
      ev("a", "stage:started", 0),
      ev("a", "stage:failed", 10, "boom"),
      ev("a", "stage:started", 100),
      ev("a", "stage:completed", 110),
    ];
    expect(
      available(
        history([stage("a", "COMPLETED", 0)], restarted),
        "a",
      ).attempts.map((a) => [a.trigger, a.outcome]),
    ).toEqual([
      ["initial", "failed"],
      ["restart", "completed"],
    ]);
    expect(
      history([stage("a", "COMPLETED", 1)], restarted).get("rec-a"),
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
    // Paused, the page reads no more on its own: it must not say it is reading.
    expect(
      reason(history(stages, [], [], { caughtUp: false, paused: true })),
    ).toBe("events-paused");
    // The run row counts a redrive, and no retained `workflow:started` records
    // it: the events of the earlier execution are not retained.
    expect(reason(history(stages, events, [], { redriveCount: 1 }))).toBe(
      "fewer-redrives",
    );
    expect(
      reason(
        history(
          stages,
          [{ ...run("workflow:started", -5), sequence: 0 }, ...events],
          [],
          {
            redriveCount: 2,
          },
        ),
      ),
    ).toBe("fewer-redrives");
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
      run("workflow:failed", 6),
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
          [stage("a", "FAILED", 1)],
          [
            ev("a", "stage:started", 0),
            ev("a", "stage:failed", 5, "boom"),
            run("workflow:failed", 6),
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

  it("checks the run's own events against the order the engine writes them in and against the run row", () => {
    const outcome = (
      events: AttemptEventInput[],
      options: { redriveCount?: number; runStatus?: string } = {},
      head: AttemptEventInput[] = [],
    ) => {
      const entry = history(
        [stage("a", "COMPLETED", 0)],
        [...head, ...events],
        [],
        options,
      ).get("rec-a")!;
      return entry.available
        ? "available"
        : `${entry.reason}:${entry.runMismatch}`;
    };
    const ran = () => [
      ev("a", "stage:started", 0),
      ev("a", "stage:completed", 5),
    ];
    // The run as the engine writes it: claimed, ran, completed.
    seq = 0;
    expect(
      outcome([...ran(), run("workflow:completed", 6)], {
        runStatus: "COMPLETED",
      }),
    ).toBe("available");
    // A second start with no end before it: rows were removed from the end
    // and the run wrote again (a redrive takes only an ended run).
    seq = 0;
    expect(
      outcome([...ran(), run("workflow:started", 7)], {
        redriveCount: 1,
        runStatus: "RUNNING",
      }),
    ).toBe("run-inconsistent:order");
    // `workflow:completed` before the claim: the claim's start is not retained.
    seq = 0;
    expect(
      outcome([run("workflow:completed", 6)], { runStatus: "COMPLETED" }, [
        { ...run("workflow:created", -2), sequence: -1 },
      ]),
    ).toBe("run-inconsistent:order");
    // A claim that fails writes `workflow:failed` with no start.
    seq = 0;
    expect(
      history(
        [stage("a", "PENDING", 0)],
        [
          { ...run("workflow:created", -2), sequence: -1 },
          run("workflow:failed", 1),
        ],
        [],
        { runStatus: "FAILED" },
      ).get("rec-a")!.available,
    ).toBe(true);
    // `workflow:failed` after the run ended: an end in between is not retained.
    seq = 0;
    expect(
      outcome(
        [...ran(), run("workflow:completed", 6), run("workflow:failed", 7)],
        {
          runStatus: "FAILED",
        },
      ),
    ).toBe("run-inconsistent:order");
    // A cancel that races the run's own end can follow it.
    seq = 0;
    expect(
      outcome(
        [...ran(), run("workflow:completed", 6), run("workflow:cancelled", 7)],
        {
          runStatus: "CANCELLED",
        },
      ),
    ).toBe("available");
    // More redrives recorded than the run row counts.
    seq = 0;
    expect(
      outcome(
        [
          ...ran(),
          run("workflow:completed", 6),
          run("workflow:started", 7),
          ev("a", "stage:started", 8),
          ev("a", "stage:completed", 9),
          run("workflow:completed", 10),
        ],
        { redriveCount: 0, runStatus: "COMPLETED" },
      ),
    ).toBe("run-inconsistent:redrives");
    // A job that runs after the run was cancelled during its retry's backoff
    // starts a CANCELLED row, which `job.execute` does not count as a retry.
    seq = 0;
    expect(
      history(
        [stage("a", "CANCELLED", 0)],
        [
          ev("a", "stage:started", 0),
          ev("a", "stage:retrying", 5, "boom"),
          run("workflow:cancelled", 6),
          ev("a", "stage:started", 7),
        ],
        [],
        { runStatus: "CANCELLED" },
      ).get("rec-a")!.available,
    ).toBe(true);
    // A redrive from a later stage leaves an earlier stage's row as it was:
    // a retried twice (attempt 2), b redriven from its failure.
    seq = 0;
    const kept = history(
      [stage("a", "COMPLETED", 2), stage("b", "COMPLETED", 1)],
      [
        ev("a", "stage:started", 0),
        ev("a", "stage:retrying", 1, "x"),
        ev("a", "stage:started", 2),
        ev("a", "stage:retrying", 3, "x"),
        ev("a", "stage:started", 4),
        ev("a", "stage:completed", 5),
        ev("b", "stage:started", 6),
        ev("b", "stage:failed", 7, "y"),
        run("workflow:failed", 8),
        run("workflow:started", 9),
        ev("b", "stage:started", 10),
        ev("b", "stage:completed", 11),
        run("workflow:completed", 12),
      ],
      [],
      { redriveCount: 1, runStatus: "COMPLETED" },
    );
    expect([
      kept.get("rec-a")!.available,
      kept.get("rec-b")!.available,
    ]).toEqual([true, true]);
    // The run's last event leaves it running; its row says COMPLETED.
    seq = 0;
    expect(outcome(ran(), { runStatus: "COMPLETED" })).toBe(
      "run-inconsistent:status",
    );
    expect(outcome(ran(), { runStatus: "RUNNING" })).toBe("available");
  });

  it("falls back as unproven when the events contradict themselves", () => {
    const reason = (events: AttemptEventInput[], status = "COMPLETED") => {
      // The run row counts the redrives its events record.
      const entry = history([stage("a", status, 1)], events, [], {
        redriveCount: events.filter((e) => e.eventType === "workflow:started")
          .length,
      }).get("rec-a")!;
      return entry.available ? "available" : entry.reason;
    };
    // The run restarted while an attempt was still open: a redrive takes only
    // a run whose attempts all ended, so the history contradicts itself.
    seq = 0;
    expect(
      reason([
        ev("a", "stage:started", 0),
        run("workflow:failed", 5),
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

  it("says a stage has not started from its status and attempt, whether or not the store stamped its row when it created it", () => {
    seq = 0;
    // The Prisma store stamps `startedAt` when it creates the row; the
    // in-memory store leaves it null. Both read the same.
    for (const startedAt of [null, at(1)]) {
      const queued = {
        ...stage("a", "PENDING"),
        startedAt,
        errorMessage: null,
      };
      expect(
        available(
          history([queued], [run("workflow:started", 1)], [], {
            runStatus: "RUNNING",
          }),
          "a",
        ).attempts,
      ).toEqual([]);
      // Cancelled while queued.
      expect(
        available(
          history(
            [{ ...queued, status: "CANCELLED", completedAt: at(2) }],
            [run("workflow:started", 1), run("workflow:cancelled", 2)],
            [],
            { runStatus: "CANCELLED" },
          ),
          "a",
        ).attempts,
      ).toEqual([]);
    }
    // A row that says it ran has its events, whatever its start time.
    expect(
      history(
        [{ ...stage("a", "COMPLETED"), startedAt: null }],
        [run("workflow:started", 2)],
      ).get("rec-a"),
    ).toMatchObject({ available: false, reason: "no-stage-events" });
    // An attempt no run of redrives gives a row that never ran.
    expect(
      history(
        [{ ...stage("a", "PENDING", 1), startedAt: null }],
        [run("workflow:started", 2)],
      ).get("rec-a"),
    ).toMatchObject({ available: false, reason: "no-stage-events" });
    // N1, tail form: the stage was cancelled while it ran and the rows from
    // its start on were removed; the run's record says CANCELLED and its
    // retained events end RUNNING.
    expect(
      history(
        [{ ...stage("a", "CANCELLED"), startedAt: at(3), completedAt: at(4) }],
        [run("workflow:started", 2)],
        [],
        { runStatus: "CANCELLED" },
      ).get("rec-a"),
    ).toMatchObject({ available: false, reason: "run-inconsistent" });
  });

  it("reads a row a redrive created again by its start: none, or the time the store created it", () => {
    seq = 0;
    const events = [
      ev("a", "stage:started", 1),
      ev("a", "stage:failed", 2, "x"),
      run("workflow:failed", 3),
      run("workflow:started", 10),
    ];
    for (const startedAt of [null, at(10), at(0)]) {
      expect(
        available(
          history(
            [{ ...stage("a", "PENDING", 1), startedAt, errorMessage: null }],
            events,
            [],
            { redriveCount: 1, runStatus: "RUNNING" },
          ),
          "a",
        ).attempts.map((a) => a.outcome),
      ).toEqual(["failed"]);
    }
    // Reaped while it waited for its first start: no start, any row stamp.
    seq = 0;
    for (const startedAt of [null, at(1)]) {
      expect(
        available(
          history(
            [
              {
                ...stage("a", "FAILED"),
                startedAt,
                completedAt: at(5),
                errorMessage: "stuck",
              },
            ],
            [ev("a", "stage:failed", 5, "stuck"), run("workflow:failed", 5)],
            [],
            { runStatus: "FAILED" },
          ),
          "a",
        ).attempts.map((a) => [a.outcome, a.executed]),
      ).toEqual([["failed", false]]);
    }
    // After a retained start with no redrive since, the row's start is
    // `job.execute`'s: none, or one later than the event, is not.
    seq = 0;
    const ran = [ev("a", "stage:started", 1), ev("a", "stage:completed", 2)];
    const row = (startedAt: Date | null) => ({
      ...stage("a", "COMPLETED"),
      startedAt,
      completedAt: at(2),
      errorMessage: null,
    });
    expect(history([row(at(1))], ran).get("rec-a")).toMatchObject({
      available: true,
    });
    for (const startedAt of [null, at(1.5)])
      expect(history([row(startedAt)], ran).get("rec-a")).toMatchObject({
        available: false,
        reason: "inconsistent",
        mismatch: "startedAt",
      });
  });

  it("accepts the status and error a redrive from a later stage kept on a row", () => {
    seq = 0;
    // G6: b was cancelled while it ran, the run was redriven from a later
    // stage, which kept b's row CANCELLED; then that run failed.
    const events = [
      ev("b", "stage:started", 1),
      run("workflow:cancelled", 2),
      run("workflow:started", 3),
      run("workflow:failed", 4),
    ];
    const b = {
      ...stage("b", "CANCELLED"),
      startedAt: at(1),
      completedAt: at(2),
      errorMessage: null,
    };
    const opts = { redriveCount: 1, runStatus: "FAILED" };
    expect(
      available(history([b], events, [], opts), "b").attempts.map(
        (a) => a.outcome,
      ),
    ).toEqual(["cancelled"]);
    // Reopened instead: PENDING with no error.
    expect(
      history([{ ...b, status: "PENDING", attempt: 1 }], events, [], opts).get(
        "rec-b",
      ),
    ).toMatchObject({ available: true });
    // A row a redrive could not have left: COMPLETED with no end recorded.
    expect(
      history([{ ...b, status: "COMPLETED" }], events, [], opts).get("rec-b"),
    ).toMatchObject({ available: false, mismatch: "status" });

    // Cancelled in a job retry's wait (its error kept), kept by a redrive
    // from a later stage, then a cancel of that run: still CANCELLED, error kept.
    seq = 0;
    const waited = [
      ev("b", "stage:started", 1),
      ev("b", "stage:retrying", 2, "503"),
      run("workflow:cancelled", 3),
      run("workflow:started", 4),
      run("workflow:cancelled", 5),
    ];
    const row = {
      ...stage("b", "CANCELLED"),
      startedAt: at(1),
      completedAt: at(3),
      errorMessage: "503",
    };
    const both = { redriveCount: 1, runStatus: "CANCELLED" };
    expect(history([row], waited, [], both).get("rec-b")).toMatchObject({
      available: true,
    });
    // Reopened and then cancelled: CANCELLED with no error.
    expect(
      history(
        [{ ...row, errorMessage: null, attempt: 1 }],
        waited,
        [],
        both,
      ).get("rec-b"),
    ).toMatchObject({ available: true });
    // Neither a kept nor a reset row has another error.
    expect(
      history([{ ...row, errorMessage: "other" }], waited, [], both).get(
        "rec-b",
      ),
    ).toMatchObject({ available: false, mismatch: "errorMessage" });
  });

  it("does not attribute an end written by an earlier execution to the attempt that is open", () => {
    seq = 0;
    const by = (event: AttemptEventInput, causationId: string) => ({
      ...event,
      causationId,
    });
    // G7: cancelled while running, redriven; the first execution's body
    // records its completion while the rerun is still running.
    const late = [
      by(ev("s", "stage:started", 1), "job:1:attempt:1"),
      run("workflow:cancelled", 2),
      run("workflow:started", 3),
      by(ev("s", "stage:started", 4), "job:2:attempt:1"),
      by(ev("s", "stage:completed", 5), "job:1:attempt:1"),
    ];
    const row = {
      ...stage("s", "COMPLETED", 1),
      startedAt: at(4),
      completedAt: at(5),
      errorMessage: null,
    };
    const opts = { redriveCount: 1, runStatus: "RUNNING" };
    expect(history([row], late, [], opts).get("rec-s")).toMatchObject({
      available: false,
      reason: "unproven-boundary",
    });
    // The rerun's own completion is its own.
    const own = late.map((e, i) =>
      i === 4 ? { ...e, causationId: "job:2:attempt:1" } : e,
    );
    expect(
      available(history([row], own, [], opts), "s").attempts.map(
        (a) => a.outcome,
      ),
    ).toEqual(["cancelled", "completed"]);
    // Before the rerun starts, the earlier execution's failure is not a
    // failure of the stage in its wait.
    const early = [
      ...late.slice(0, 3),
      by(ev("s", "stage:failed", 4, "late"), "job:1:attempt:1"),
    ];
    expect(
      history(
        [{ ...row, status: "FAILED", errorMessage: "late" }],
        early,
        [],
        opts,
      ).get("rec-s"),
    ).toMatchObject({ available: false, reason: "unproven-boundary" });
    // Ends written by other handlers (a poll) carry ids of their own.
    seq = 0;
    const polled = [
      by(ev("s", "stage:started", 1), "job:1:attempt:1"),
      by(ev("s", "stage:suspended", 2), "job:1:attempt:1"),
      by(ev("s", "stage:retrying", 3, "flaky"), "poll-a"),
      by(ev("s", "stage:completed", 4), "poll-b"),
    ];
    expect(
      available(
        history(
          [{ ...row, attempt: 1, startedAt: at(1), completedAt: at(4) }],
          polled,
        ),
        "s",
      ).attempts.map((a) => a.trigger),
    ).toEqual(["initial", "poll-retry"]);
    // A re-delivery under the same id ends under it.
    seq = 0;
    const again = [
      by(ev("s", "stage:started", 1), "job:1:attempt:1"),
      by(ev("s", "stage:started", 2), "job:1:attempt:1"),
      by(ev("s", "stage:completed", 3), "job:1:attempt:1"),
    ];
    expect(
      available(
        history(
          [{ ...row, attempt: 0, startedAt: at(2), completedAt: at(3) }],
          again,
        ),
        "s",
      ).attempts.map((a) => a.trigger),
    ).toEqual(["initial", "redelivery"]);
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
      run("workflow:failed", 6),
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
  // A run's outbox starts with its `workflow:created` at sequence 1.
  const e = (sequence: number) =>
    ({
      sequence,
      eventType: sequence === 1 ? "workflow:created" : "stage:started",
      occurredAt: at(sequence),
      stageId: sequence === 1 ? null : "a",
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

  it("covers the run from its start only when the first read begins with its workflow:created at sequence 1", () => {
    expect(fold(page(0, 3))?.coverage).toBe("from-start");
    // Every earlier row was removed and the store numbered the next ones from
    // 1 again (a redrive after a full purge): sequence 1 is not the creation.
    const restarted: StageEventPage = {
      ...page(0, 3),
      events: [
        { ...e(2), sequence: 1, eventType: "workflow:started", stageId: null },
        e(2),
        e(3),
      ],
    };
    expect(fold(restarted)?.coverage).toBe("gap");
    // A reader that calls a range complete without returning its first event.
    expect(fold({ ...page(0, 3), events: [e(2), e(3)] })?.coverage).toBe("gap");
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

  it("starts again from nothing when a read from what it holds ends below it, as after rows were removed", () => {
    const held = fold(page(0, 5))!;
    // The reader's answer to `after` 5 once the run's rows past 2 are gone.
    expect(
      mergeStageEvents(held, {
        events: [],
        after: 5,
        lastSequence: 2,
        complete: false,
        more: false,
      }),
    ).toBeNull();
    // A late answer to an earlier position changes nothing.
    expect(
      mergeStageEvents(held, {
        events: [],
        after: 3,
        lastSequence: 2,
        complete: false,
        more: false,
      }),
    ).toBe(held);
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

  it("reads the next chunk at once only while polling runs, and only past the last one asked for", () => {
    // Caught up: nothing to read.
    expect(catchUpStep(null, -1, false)).toEqual({ read: false, askedAt: -1 });
    // Behind at 2: read at once, and count 2 as asked.
    expect(catchUpStep(2, -1, false)).toEqual({ read: true, askedAt: 2 });
    // A reader that answers `more` without advancing is not asked again at once.
    expect(catchUpStep(2, 2, false)).toEqual({ read: false, askedAt: 2 });
    // Paused: no request of its own. Resuming re-polls from what is held, so
    // the held position counts as asked and the catch-up adds no second read.
    expect(catchUpStep(4, 2, true)).toEqual({ read: false, askedAt: 4 });
    expect(catchUpStep(4, 4, false)).toEqual({ read: false, askedAt: 4 });
    // The resume poll advanced to 6 with rows still left: read on at once.
    expect(catchUpStep(6, 4, false)).toEqual({ read: true, askedAt: 6 });
    // A reader that returns small chunks: at the cap per poll interval the
    // page waits for the interval instead of asking at server speed, and asks
    // from the same position after it.
    expect(catchUpStep(8, 6, false, CATCH_UP_READS_PER_INTERVAL - 1)).toEqual({
      read: true,
      askedAt: 8,
    });
    expect(catchUpStep(10, 8, false, CATCH_UP_READS_PER_INTERVAL)).toEqual({
      read: false,
      askedAt: 8,
      wait: true,
    });
    expect(catchUpStep(10, 8, false, 0)).toEqual({ read: true, askedAt: 10 });
  });
});
