import { describe, expect, it } from "vitest";
import {
  type AttemptEventInput,
  type AttemptStageInput,
  type AttemptStepInput,
  buildStageAttemptHistory,
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
  options: { redriveCount?: number; complete?: boolean } = {},
) {
  return buildStageAttemptHistory({
    redriveCount: options.redriveCount ?? 0,
    stages,
    steps,
    stageEvents: { events, complete: options.complete ?? true },
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
    expect(open("CANCELLED").outcome).toBe("cancelled");
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

    // Without a redrive the row would have counted the second attempt.
    expect(
      history([stage("a", "COMPLETED", 0)], events).get("rec-a"),
    ).toMatchObject({ available: false, reason: "inconsistent" });
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
    expect(reason(history(stages, events, [], { complete: false }))).toBe(
      "events-incomplete",
    );
    expect(reason(history(stages, []))).toBe("no-stage-events");
    // The start was purged: the first retained event is the end.
    expect(reason(history(stages, [events[1]!]))).toBe("history-gap");
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
      stageEvents: { events: asJson, complete: true },
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
});
