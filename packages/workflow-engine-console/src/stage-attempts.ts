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
 * Attempt boundaries, from a stage's events and the run's `workflow:*`
 * boundary events, in `sequence` order:
 *  - `stage:started` opens attempt N. When an attempt is already open, the
 *    second start is itself the proof that a new execution began; what is
 *    unknown is how the earlier one ended (a worker crash and re-delivery, or
 *    a lease reaped by `lease.reapStale`, both write no event). The earlier
 *    attempt is closed as "lost" (no end recorded), its window ends at the
 *    new start, and the new attempt is a "redelivery". The engine does not
 *    count a re-delivery as an attempt of the stage row, so it is left out
 *    of the row-count check.
 *  - `stage:suspended` and the poll that later resumes the stage stay inside
 *    the open attempt.
 *  - `stage:completed` and `stage:failed` close the attempt. A `stage:started`
 *    after a closed attempt with no redrive in between is a "restart" (a job
 *    delivered again after its stage had ended, or one that ran after the
 *    run was cancelled).
 *  - `stage:failed` with no attempt open is a stage failed while it waited
 *    for its next execution (`run.reapStuck` fails every unfinished stage): a
 *    failed attempt that never started. Any other end event with no attempt
 *    open, or `stage:failed` for a stage that was not waiting, contradicts
 *    the history and is `unproven-boundary`.
 *  - `stage:retrying` closes the attempt as "retrying". If the stage was
 *    suspended when it fired, the retry happened in `stage.pollSuspended`:
 *    the stage stays SUSPENDED, no `stage:started` follows, and attempt N+1
 *    is open from that event. Otherwise it was a job retry and attempt N+1
 *    opens at the next `stage:started`.
 *  - `workflow:cancelled` closes the open attempt as "cancelled". `run.cancel`
 *    marks every non-terminal stage CANCELLED in one transaction and emits no
 *    stage event, so this event is the only proof that the execution ended.
 *  - `workflow:started` is emitted by the first claim and by every redrive
 *    (`run.redrive`, `run.rerunFrom`). It finds no attempt open, because a
 *    redrive takes only a COMPLETED, FAILED or CANCELLED run and each of those
 *    ends the attempts with an event; if one is open the history contradicts
 *    itself and the stage is `unproven-boundary`. The `stage:started` that
 *    follows a redrive is a `rerun` attempt, also for a stage whose last
 *    attempt was a job retry that a cancel interrupted.
 *
 * What the page states rests on two kinds of evidence. The events must cover
 * the run from its first outbox row (`coverage: "from-start"`): only then is
 * the first attempt the first run and "no event" proof that nothing happened.
 * And the stage row must agree with them: its status with the last attempt,
 * its `attempt` count (on a run never redriven), its `startedAt` with the
 * last `stage:started`, its `completedAt` with the event that ended it, and
 * its `errorMessage` with the last error event. The row and the event of one
 * write are stamped in one handler, the row first, so a row stamped after the
 * last retained event means the events that followed are not retained. A
 * disagreement makes the stage unavailable and names the field.
 *
 * Step rows carry no attempt marker of the stage, only `updatedAt`. A step
 * row records the step's latest state, so it is placed in the one attempt
 * whose window [start, end] contains `updatedAt`: the attempt in which the
 * step last changed, which is the attempt its status and error describe. The
 * window of a "lost" attempt closes where the next execution started, so the
 * steps placed in it are placed by time only.
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
  /** The row's fields checked against the events; `undefined` skips a check. */
  startedAt?: Time | null;
  completedAt?: Time | null;
  errorMessage?: string | null;
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
  /** Null on the run-level `workflow:*` events, which concern every stage. */
  stageId: string | null;
  error: string | null;
  /** True when `error` was cut by the reader. */
  errorTruncated?: boolean;
}

export interface StageAttemptInput {
  redriveCount: number;
  stages: readonly AttemptStageInput[];
  steps: readonly AttemptStepInput[];
  /** Absent when the reader does not provide stage events. */
  stageEvents?: {
    events: readonly AttemptEventInput[];
    coverage: EventCoverage;
    /** False while the page is still reading the run's events in chunks. */
    caughtUp?: boolean;
  };
}

/** What the held events are known to cover of the run's outbox rows. */
export type EventCoverage =
  /** Every row from sequence 1 (the run's first event) to the last one read. */
  | "from-start"
  /** Rows are missing from what was read: purged or past retention. */
  | "gap"
  /** The run has no retained outbox row at all. */
  | "none";

/** What the page holds of a run's stage events between polls. */
export interface HeldStageEvents {
  events: readonly AttemptEventInput[];
  /** The highest outbox sequence read so far; the next read asks for rows after it. */
  lastSequence: number;
  /** Only ever narrows: once rows were missing, they stay missing for this view. */
  coverage: EventCoverage;
  /** True while rows past `lastSequence` remain to be read (a read stops at the reader's limit). */
  more: boolean;
}

/** One read of the run detail's `stageEvents`, as the server returns it. */
export interface StageEventPage {
  events: readonly AttemptEventInput[];
  after: number;
  lastSequence: number;
  complete: boolean;
  /** True when the read stopped at its limit and rows past `lastSequence` remain. */
  more?: boolean;
}

/**
 * Folds one read into the events the page already holds, and returns null
 * while nothing is held. Only a read from the start (`after` 0) can begin the
 * history; a first read that finds no row says the run has none retained,
 * never that its history is empty. After that, a read is taken only when it
 * continues what is held (`after` not past `lastSequence`) and reaches
 * further; anything else (a slow response that arrives late, an answer to a
 * request this page did not make) changes nothing. Events are appended by
 * sequence, so a reader that ignores `after` adds each event once. A read
 * that stopped at the reader's limit leaves `more` true: the page asks again
 * from `lastSequence` until it has caught up.
 */
export function mergeStageEvents(
  held: HeldStageEvents | null,
  page: StageEventPage,
): HeldStageEvents | null {
  const more = page.more === true;
  if (held === null) {
    if (page.after !== 0) return null;
    return {
      events: page.events,
      lastSequence: page.lastSequence,
      coverage:
        page.lastSequence <= 0 ? "none" : page.complete ? "from-start" : "gap",
      more,
    };
  }
  if (page.lastSequence <= held.lastSequence || page.after > held.lastSequence)
    return held;
  return {
    events: [
      ...held.events,
      ...page.events.filter((event) => event.sequence > held.lastSequence),
    ],
    lastSequence: page.lastSequence,
    // Rows that appear after a read found none are not the run's first ones.
    coverage:
      held.coverage === "from-start" && page.complete ? "from-start" : "gap",
    more,
  };
}

export type AttemptOutcome =
  | "completed"
  | "failed"
  | "retrying"
  | "suspended"
  | "running"
  | "cancelled"
  /**
   * No end was recorded: a second `stage:started` shows the stage started
   * again, and nothing says how this execution ended.
   */
  | "lost";

/** Why an attempt began: its first run, or what the previous attempt ended with. */
export type AttemptTrigger =
  | "initial"
  | "job-retry"
  | "poll-retry"
  /** After a redrive (`workflow:started`). */
  | "rerun"
  /** After the previous attempt ended, with no redrive recorded in between. */
  | "restart"
  /** Started again while the previous execution had no recorded end. */
  | "redelivery";

export type AttemptUnavailableReason =
  /** The reader returned no stage events. */
  | "no-event-history"
  /** Rows are missing from the run's outbox: purged or past retention. */
  | "events-incomplete"
  /** The run has no retained outbox row at all. */
  | "no-retained-events"
  /** The page has read only part of the run's events so far. */
  | "events-loading"
  /** The stage row says it ran, and no lifecycle event of it is retained. */
  | "no-stage-events"
  /**
   * The events contradict each other: an execution ends with no start
   * recorded, or a redrive starts while an execution has no recorded end.
   */
  | "unproven-boundary"
  /** A retained event has no readable time. */
  | "invalid-event-time"
  /** The events disagree with the stage's current row; `mismatch` names the field. */
  | "inconsistent";

/** The stage row field the events disagree with. */
export type AttemptRowMismatch =
  | "status"
  | "attempt"
  | "startedAt"
  | "completedAt"
  | "errorMessage";

export interface AttemptEventEntry {
  sequence: number;
  eventType: string;
  /** ISO 8601. */
  occurredAt: string;
  error: string | null;
  errorTruncated: boolean;
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
  /**
   * ISO 8601 of the event that closed the attempt; null while it is open and
   * for a "lost" attempt, whose end was never recorded.
   */
  endedAt: string | null;
  /**
   * ISO 8601 of where the attempt's window for placing steps closes: the
   * closing event, or for a "lost" attempt the start of the next execution.
   * Null while the attempt is open.
   */
  windowEndedAt: string | null;
  /**
   * False for a failed attempt that never started: the stage was failed while
   * it waited for its next execution (for example by `run.reapStuck`).
   */
  executed: boolean;
  outcome: AttemptOutcome;
  /** The error of the event that closed the attempt (`stage:retrying` or `stage:failed`). */
  error: string | null;
  /** True when `error` was cut by the reader. */
  errorTruncated: boolean;
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
      /** Set with `inconsistent`. */
      mismatch?: AttemptRowMismatch;
    };

interface Work {
  trigger: AttemptTrigger;
  startMs: number;
  /** Where the window for placing steps closes; null while open. */
  endMs: number | null;
  /** False when `endMs` is only where the next execution started. */
  endRecorded: boolean;
  executed: boolean;
  outcome: AttemptOutcome | null;
  error: string | null;
  errorTruncated: boolean;
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
    mismatch?: AttemptRowMismatch,
  ): StageAttemptHistory => ({
    stageRecordId: stage.id,
    available: false,
    reason,
    ...(mismatch ? { mismatch } : {}),
  });

  if (!events.some((event) => event.stageId !== null)) {
    // The events cover the run from its first row and hold none of this
    // stage; its row must say the same: never stamped by a start, still on
    // its first attempt (0), and not past what a stage that never ran can be.
    const neverRan =
      stage.attempt === 0 &&
      stage.startedAt == null &&
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
  const newAttempt = (trigger: AttemptTrigger, startMs: number): Work => {
    const work: Work = {
      trigger,
      startMs,
      endMs: null,
      endRecorded: true,
      executed: true,
      outcome: null,
      error: null,
      errorTruncated: false,
      events: [],
    };
    attempts.push(work);
    return work;
  };
  let open: Work | null = null;
  let suspended = false;
  let next: AttemptTrigger = "initial";
  // A `workflow:cancelled` with no redrive after it: what a CANCELLED row needs.
  let runCancelled = false;
  // The last `stage:started`, and whether a redrive followed it (a redrive
  // recreates later stages' rows with no `startedAt`).
  let lastStartMs: number | null = null;
  let redrivenSinceStart = false;
  // The error the row keeps: set by `stage:retrying` and `stage:failed`,
  // cleared by `stage:completed` and by a redrive.
  let rowError: { text: string | null; cut: boolean } = {
    text: null,
    cut: false,
  };
  // After the last attempt closed, a redrive began (`workflow:started`) and a
  // cancel followed it before the stage started: the row the cancel left is
  // CANCELLED with a closed last attempt, which only this sequence explains.
  let redriven = false;
  let cancelledIdle = false;
  // The stage is PENDING between executions: before its first start, after a
  // job retry, or after a redrive reopened it. Only then can a `stage:failed`
  // arrive with no attempt open (`run.reapStuck` fails every unfinished stage).
  let waiting = true;

  for (const event of events) {
    const at = toMs(event.occurredAt);
    if (Number.isNaN(at)) return unavailable("invalid-event-time");
    const entry: AttemptEventEntry = {
      sequence: event.sequence,
      eventType: event.eventType,
      occurredAt: iso(at),
      error: event.error,
      errorTruncated: event.errorTruncated === true,
    };

    if (event.stageId === null) {
      if (event.eventType === "workflow:cancelled") {
        if (open !== null) {
          open.events.push(entry);
          open.endMs = at;
          open.outcome = "cancelled";
          open = null;
          suspended = false;
          next = "restart";
        } else if (redriven) {
          cancelledIdle = true;
        }
        waiting = false;
        runCancelled = true;
      } else if (event.eventType === "workflow:started") {
        if (open !== null) return unavailable("unproven-boundary");
        runCancelled = false;
        if (attempts.length > 0) {
          next = "rerun";
          redriven = true;
          cancelledIdle = false;
          waiting = true;
          redrivenSinceStart = true;
          rowError = { text: null, cut: false };
        }
      }
      continue;
    }

    if (event.eventType === "stage:started") {
      let trigger: AttemptTrigger = next;
      if (open !== null) {
        // A second start is the proof that a new execution began; nothing
        // says how the earlier one ended, so its window closes here.
        open.endMs = at;
        open.endRecorded = false;
        open.outcome = "lost";
        trigger = "redelivery";
      }
      open = newAttempt(trigger, at);
      open.events.push(entry);
      lastStartMs = at;
      redrivenSinceStart = false;
      suspended = false;
      redriven = false;
      cancelledIdle = false;
      waiting = false;
      continue;
    }

    if (open === null) {
      // A stage failed while it waited for its next execution never started.
      if (event.eventType !== "stage:failed" || !waiting) {
        return unavailable("unproven-boundary");
      }
      const never = newAttempt(next, at);
      never.executed = false;
      never.events.push(entry);
      never.endMs = at;
      never.outcome = "failed";
      never.error = event.error;
      never.errorTruncated = event.errorTruncated === true;
      rowError = { text: event.error, cut: never.errorTruncated };
      waiting = false;
      next = "restart";
      continue;
    }
    open.events.push(entry);
    if (
      event.eventType === "stage:retrying" ||
      event.eventType === "stage:failed"
    ) {
      rowError = { text: event.error, cut: event.errorTruncated === true };
    } else if (event.eventType === "stage:completed") {
      rowError = { text: null, cut: false };
    }

    if (event.eventType === "stage:suspended") {
      suspended = true;
    } else if (event.eventType === "stage:retrying") {
      open.endMs = at;
      open.outcome = "retrying";
      open.error = event.error;
      open.errorTruncated = event.errorTruncated === true;
      if (suspended) {
        open = newAttempt("poll-retry", at);
      } else {
        open = null;
        next = "job-retry";
        waiting = true;
      }
    } else if (
      event.eventType === "stage:failed" ||
      event.eventType === "stage:completed"
    ) {
      const failed = event.eventType === "stage:failed";
      open.endMs = at;
      open.outcome = failed ? "failed" : "completed";
      open.error = failed ? event.error : null;
      open.errorTruncated = failed && event.errorTruncated === true;
      open = null;
      suspended = false;
      next = "restart";
      waiting = false;
    }
  }

  // An attempt still open takes its outcome from the stage's row.
  const last = attempts[attempts.length - 1];
  if (!last) return unavailable("unproven-boundary");
  if (last.endMs === null) {
    // A CANCELLED row with an attempt open: the execution started after the
    // run was cancelled and was cancelled when it tried to record its outcome,
    // which writes no event. Only a retained cancel explains it.
    // A SUSPENDED row needs its `stage:suspended` (a poll retry stays
    // suspended from the one before it): without it, the suspension and what
    // followed it are not retained.
    const live: Record<string, AttemptOutcome | undefined> = {
      RUNNING: "running",
      ...(suspended ? { SUSPENDED: "suspended" as const } : {}),
      ...(runCancelled ? { CANCELLED: "cancelled" as const } : {}),
    };
    const outcome = live[stage.status];
    if (!outcome) return unavailable("inconsistent", "status");
    last.outcome = outcome;
  } else {
    // Closed: the row must say what the closing event says. A stage waiting
    // for its next job attempt (or for a redrive's) is PENDING, and one
    // cancelled in that wait is CANCELLED.
    const agrees =
      (stage.status === "COMPLETED" && last.outcome === "completed") ||
      (stage.status === "FAILED" && last.outcome === "failed") ||
      (stage.status === "PENDING" && waiting) ||
      (stage.status === "CANCELLED" &&
        runCancelled &&
        (last.outcome === "retrying" ||
          last.outcome === "cancelled" ||
          cancelledIdle));
    if (!agrees) return unavailable("inconsistent", "status");
  }

  // Without a redrive the row's attempt starts at 0 and gains exactly 1 per
  // retry, so it must equal the events' count of attempts the engine counts:
  // a re-delivery does not bump the row, and an attempt that never started
  // has no execution to count. A redrive breaks the rule in both directions
  // (it numbers a reopened row one past the highest in its execution group,
  // and recreates the rows of later stages at 0), so after one the events'
  // completeness is what is relied on.
  const counted = attempts.filter(
    (attempt) => attempt.executed && attempt.trigger !== "redelivery",
  ).length;
  if (redriveCount === 0 && stage.attempt !== Math.max(0, counted - 1))
    return unavailable("inconsistent", "attempt");

  // `job.execute` stamps `startedAt` before it writes `stage:started`, so the
  // row's start is never later than the last retained start; a later one is
  // a start whose event is not retained. A redrive keeps a reopened row's
  // start and recreates a later stage's row without one.
  if (stage.startedAt !== undefined) {
    const rowStart = stage.startedAt === null ? null : toMs(stage.startedAt);
    const agrees =
      rowStart === null
        ? lastStartMs === null || redrivenSinceStart
        : lastStartMs !== null && rowStart <= lastStartMs;
    if (!agrees) return unavailable("inconsistent", "startedAt");
  }
  // The same for the end of a COMPLETED or FAILED stage and its event.
  if (
    stage.completedAt !== undefined &&
    (stage.status === "COMPLETED" || stage.status === "FAILED")
  ) {
    const rowEnd = stage.completedAt === null ? null : toMs(stage.completedAt);
    if (rowEnd === null || last.endMs === null || rowEnd > last.endMs)
      return unavailable("inconsistent", "completedAt");
  }
  if (stage.errorMessage !== undefined) {
    const row = stage.errorMessage;
    const agrees =
      rowError.text === null
        ? row === null
        : row !== null &&
          (row === rowError.text ||
            (rowError.cut && row.startsWith(rowError.text)));
    if (!agrees) return unavailable("inconsistent", "errorMessage");
  }

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
      endedAt:
        attempt.endMs === null || !attempt.endRecorded
          ? null
          : iso(attempt.endMs),
      windowEndedAt: attempt.endMs === null ? null : iso(attempt.endMs),
      executed: attempt.executed,
      outcome: attempt.outcome!,
      error: attempt.error,
      errorTruncated: attempt.errorTruncated,
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
    } else if (log.caughtUp === false || log.coverage !== "from-start") {
      result.set(stage.id, {
        stageRecordId: stage.id,
        available: false,
        reason:
          log.caughtUp === false
            ? "events-loading"
            : log.coverage === "none"
              ? "no-retained-events"
              : "events-incomplete",
      });
    } else {
      result.set(
        stage.id,
        historyForStage(
          stage,
          log.events
            .filter(
              (event) =>
                event.stageId === null || event.stageId === stage.stageId,
            )
            .sort((a, b) => a.sequence - b.sequence),
          input.steps.filter((step) => step.stageRecordId === stage.id),
          input.redriveCount,
        ),
      );
    }
  }
  return result;
}
