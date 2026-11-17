/**
 * Groups a run's stage history by attempt.
 *
 * Pure and dependency-free: the UI bundle imports it, and so do its tests.
 *
 * What the database keeps is the latest state only: the stage row holds its
 * current `attempt` and last error, and a step row holds its last status and
 * error. The history lives in the retained outbox events, so attempts are
 * derived from a stage's lifecycle events and then checked against the rows;
 * when the two disagree, or the events cannot be trusted, the stage is
 * reported as `available: false` and the caller shows the flat view.
 *
 * Attempt boundaries, from a stage's events in `sequence` order:
 *  - `stage:started` opens attempt N when no attempt is open. When one is
 *    already open it is a re-delivery of the same job after a crash (the
 *    engine does not bump the stage's attempt for it) and joins that attempt.
 *  - `stage:suspended` and the poll that later resumes the stage stay inside
 *    the open attempt.
 *  - `stage:completed` and `stage:failed` close the attempt.
 *  - `stage:retrying` closes the attempt as "retrying". If the stage was
 *    suspended when it fired, the retry happened in `stage.pollSuspended`:
 *    the stage stays SUSPENDED, no `stage:started` follows, and attempt N+1
 *    is open from that event. Otherwise it was a job retry and attempt N+1
 *    opens at the next `stage:started`.
 *  - A `stage:started` after `stage:completed` or `stage:failed` is a rerun
 *    (a redrive, or a fresh execution of a failed stage) and opens a new attempt.
 *
 * Step rows carry no attempt marker of the stage, only `updatedAt`. A step
 * row records the step's latest state, so it is placed in the one attempt
 * whose window [start, end] contains `updatedAt`: the attempt in which the
 * step last changed, which is the attempt its status and error describe.
 * A step that ran in an earlier attempt and again later appears only in the
 * later one (its `attempt` count says it executed more than once). A step
 * whose `updatedAt` is in no window, or on the boundary shared by two, is
 * returned in `unplacedSteps` rather than guessed.
 */

type Time = Date | string;

export interface AttemptStageInput {
  /** The stage record id (`StepSummary.stageRecordId` points here). */
  id: string;
  /** The stage definition id (`StageEvent.stageId` points here). */
  stageId: string;
  attempt: number;
  status: string;
}

export interface AttemptStepInput {
  stageRecordId: string;
  stepId: string;
  seq: number;
  kind: string;
  status: string;
  attempt: number;
  externalKey: string | null;
  error: string | null;
  createdAt: Time;
  updatedAt: Time;
}

export interface AttemptEventInput {
  sequence: number;
  eventType: string;
  occurredAt: Time;
  stageId: string;
  error: string | null;
}

export interface StageAttemptInput {
  redriveCount: number;
  stages: readonly AttemptStageInput[];
  steps: readonly AttemptStepInput[];
  /** Absent when the reader does not provide stage events. */
  stageEvents?: {
    events: readonly AttemptEventInput[];
    complete: boolean;
  };
}

export type AttemptOutcome =
  | "completed"
  | "failed"
  | "retrying"
  | "suspended"
  | "running"
  | "cancelled";

/** Why an attempt began: its first run, or what the previous attempt ended with. */
export type AttemptTrigger = "initial" | "job-retry" | "poll-retry" | "rerun";

export type AttemptUnavailableReason =
  /** The reader returned no stage events. */
  | "no-event-history"
  /** Events are purged, past retention, or were cut off by a read limit. */
  | "events-incomplete"
  /** The stage has run but no lifecycle event of it is retained. */
  | "no-stage-events"
  /** The retained events are missing a link (they do not start at `stage:started`, or skip one). */
  | "history-gap"
  /** The events disagree with the stage's current row. */
  | "inconsistent";

export interface AttemptEventEntry {
  sequence: number;
  eventType: string;
  /** ISO 8601. */
  occurredAt: string;
  error: string | null;
}

export interface AttemptStepEntry {
  stepId: string;
  seq: number;
  kind: string;
  status: string;
  /** The step's own execution count (`StepSummary.attempt`), across all stage attempts. */
  attempt: number;
  /**
   * `updatedAt - createdAt` of a step that executed once and has finished;
   * null otherwise, because the row does not keep per-execution timings.
   */
  durationMs: number | null;
  error: string | null;
  externalKey: string | null;
}

export interface StageAttempt {
  /** 1-based position in the retained history; not the stage row's `attempt`. */
  number: number;
  trigger: AttemptTrigger;
  /**
   * ISO 8601: the `stage:started` time, or for a `poll-retry` the time the
   * retry was recorded (the stage is replayed on a later poll).
   */
  startedAt: string;
  /** ISO 8601 of the event that closed the attempt; null while it is open. */
  endedAt: string | null;
  outcome: AttemptOutcome;
  /** The error of the event that closed the attempt (`stage:retrying` or `stage:failed`). */
  error: string | null;
  events: AttemptEventEntry[];
  steps: AttemptStepEntry[];
}

export type StageAttemptHistory =
  | {
      stageRecordId: string;
      available: true;
      attempts: StageAttempt[];
      /** Steps whose last change matches no attempt, or two. */
      unplacedSteps: AttemptStepEntry[];
    }
  | {
      stageRecordId: string;
      available: false;
      reason: AttemptUnavailableReason;
    };

interface Work {
  trigger: AttemptTrigger;
  startMs: number;
  endMs: number | null;
  outcome: AttemptOutcome | null;
  error: string | null;
  events: AttemptEventEntry[];
}

const toMs = (value: Time) =>
  value instanceof Date ? value.getTime() : Date.parse(value);
const iso = (ms: number) => new Date(ms).toISOString();

function stepEntry(step: AttemptStepInput): AttemptStepEntry {
  const finished = step.status === "completed" || step.status === "failed";
  const span = toMs(step.updatedAt) - toMs(step.createdAt);
  return {
    stepId: step.stepId,
    seq: step.seq,
    kind: step.kind,
    status: step.status,
    attempt: step.attempt,
    durationMs:
      finished && step.attempt === 1 && Number.isFinite(span)
        ? Math.max(0, span)
        : null,
    error: step.error,
    externalKey: step.externalKey,
  };
}

function historyForStage(
  stage: AttemptStageInput,
  events: readonly AttemptEventInput[],
  steps: readonly AttemptStepInput[],
  redriveCount: number,
): StageAttemptHistory {
  const unavailable = (
    reason: AttemptUnavailableReason,
  ): StageAttemptHistory => ({
    stageRecordId: stage.id,
    available: false,
    reason,
  });

  if (events.length === 0) {
    // A stage that has never run is still PENDING on its first attempt (0).
    const neverRan =
      stage.attempt === 0 &&
      (stage.status === "PENDING" ||
        stage.status === "SKIPPED" ||
        stage.status === "CANCELLED");
    return neverRan
      ? {
          stageRecordId: stage.id,
          available: true,
          attempts: [],
          unplacedSteps: [],
        }
      : unavailable("no-stage-events");
  }

  const attempts: Work[] = [];
  let open: Work | null = null;
  let suspended = false;
  let next: AttemptTrigger = "initial";

  for (const event of events) {
    const at = toMs(event.occurredAt);
    if (Number.isNaN(at)) return unavailable("inconsistent");
    const entry: AttemptEventEntry = {
      sequence: event.sequence,
      eventType: event.eventType,
      occurredAt: iso(at),
      error: event.error,
    };

    if (event.eventType === "stage:started") {
      if (open === null) {
        open = {
          trigger: next,
          startMs: at,
          endMs: null,
          outcome: null,
          error: null,
          events: [],
        };
        attempts.push(open);
      }
      open.events.push(entry);
      suspended = false;
      continue;
    }

    if (open === null) return unavailable("history-gap");
    open.events.push(entry);

    if (event.eventType === "stage:suspended") {
      suspended = true;
    } else if (event.eventType === "stage:retrying") {
      open.endMs = at;
      open.outcome = "retrying";
      open.error = event.error;
      if (suspended) {
        open = {
          trigger: "poll-retry",
          startMs: at,
          endMs: null,
          outcome: null,
          error: null,
          events: [],
        };
        attempts.push(open);
      } else {
        open = null;
        next = "job-retry";
      }
    } else if (
      event.eventType === "stage:failed" ||
      event.eventType === "stage:completed"
    ) {
      open.endMs = at;
      open.outcome =
        event.eventType === "stage:failed" ? "failed" : "completed";
      open.error = event.eventType === "stage:failed" ? event.error : null;
      open = null;
      suspended = false;
      next = "rerun";
    }
  }

  // An attempt still open takes its outcome from the stage's row.
  const last = attempts[attempts.length - 1];
  if (!last) return unavailable("history-gap");
  if (last.endMs === null) {
    const live: Record<string, AttemptOutcome | undefined> = {
      RUNNING: "running",
      SUSPENDED: "suspended",
      CANCELLED: "cancelled",
    };
    const outcome = live[stage.status];
    if (!outcome) return unavailable("inconsistent");
    last.outcome = outcome;
  } else {
    // Closed: the row must say what the closing event says. A stage waiting
    // for its next job attempt (or for a redrive's) is PENDING, and one
    // cancelled in that wait is CANCELLED.
    const agrees =
      (stage.status === "COMPLETED" && last.outcome === "completed") ||
      (stage.status === "FAILED" && last.outcome === "failed") ||
      (stage.status === "PENDING" && last.endMs !== null) ||
      (stage.status === "CANCELLED" && last.outcome === "retrying");
    if (!agrees) return unavailable("inconsistent");
  }

  // Without a redrive the row's attempt starts at 0 and gains exactly 1 per
  // retry, so it must equal the events' count. A redrive breaks that in both
  // directions (it numbers a reopened row one past the highest in its
  // execution group, and recreates the rows of later stages at 0), so after
  // one the events' completeness is what is relied on.
  if (redriveCount === 0 && stage.attempt !== attempts.length - 1)
    return unavailable("inconsistent");

  const placed: AttemptStepEntry[][] = attempts.map(() => []);
  const unplacedSteps: AttemptStepEntry[] = [];
  const ordered = [...steps].sort(
    (a, b) => a.seq - b.seq || (a.stepId < b.stepId ? -1 : 1),
  );
  for (const step of ordered) {
    const changed = toMs(step.updatedAt);
    const inside = attempts.flatMap((attempt, index) =>
      changed >= attempt.startMs &&
      changed <= (attempt.endMs ?? Number.POSITIVE_INFINITY)
        ? [index]
        : [],
    );
    const slot = inside.length === 1 ? placed[inside[0]!] : undefined;
    (slot ?? unplacedSteps).push(stepEntry(step));
  }

  return {
    stageRecordId: stage.id,
    available: true,
    attempts: attempts.map((attempt, index) => ({
      number: index + 1,
      trigger: attempt.trigger,
      startedAt: iso(attempt.startMs),
      endedAt: attempt.endMs === null ? null : iso(attempt.endMs),
      outcome: attempt.outcome!,
      error: attempt.error,
      events: attempt.events,
      steps: placed[index]!,
    })),
    unplacedSteps,
  };
}

/** Attempt history of every stage, keyed by stage record id. */
export function buildStageAttemptHistory(
  input: StageAttemptInput,
): Map<string, StageAttemptHistory> {
  const result = new Map<string, StageAttemptHistory>();
  const log = input.stageEvents;
  for (const stage of input.stages) {
    if (!log) {
      result.set(stage.id, {
        stageRecordId: stage.id,
        available: false,
        reason: "no-event-history",
      });
    } else if (!log.complete) {
      result.set(stage.id, {
        stageRecordId: stage.id,
        available: false,
        reason: "events-incomplete",
      });
    } else {
      result.set(
        stage.id,
        historyForStage(
          stage,
          log.events
            .filter((event) => event.stageId === stage.stageId)
            .sort((a, b) => a.sequence - b.sequence),
          input.steps.filter((step) => step.stageRecordId === stage.id),
          input.redriveCount,
        ),
      );
    }
  }
  return result;
}
