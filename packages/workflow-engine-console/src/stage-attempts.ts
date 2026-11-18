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
 *  - `workflow:completed` and `workflow:failed` end the run; they close no
 *    attempt (each stage ended with its own event first) and are read for the
 *    run checks below.
 *  - `workflow:started` is emitted by the first claim and by every redrive
 *    (`run.redrive`, `run.rerunFrom`). It finds no attempt open, because a
 *    redrive takes only a COMPLETED, FAILED or CANCELLED run and each of those
 *    ends the attempts with an event; if one is open the history contradicts
 *    itself and the stage is `unproven-boundary`. The `stage:started` that
 *    follows a redrive is a `rerun` attempt, also for a stage whose last
 *    attempt was a job retry that a cancel interrupted. A `run.transition`
 *    dispatched before the claim also writes one, on a PENDING run with no
 *    stage rows, and leaves the run PENDING; the claim then writes its own.
 *    That second start, right after the first with no run event between,
 *    is read as part of the first: no redrive, and no event of the stages.
 *  - One `job.execute` writes a stage's start and that execution's end
 *    under one causation id. An end written under the id of a retained
 *    start that did not open the current attempt is the end of an earlier
 *    execution, one whose body kept running after a cancel or a lost lease
 *    and recorded its outcome later: which attempt it ended is not known,
 *    so the stage is `unproven-boundary`. Ends written by other handlers
 *    (a poll, `run.reapStuck`) carry ids of their own.
 *
 * What the page states rests on two kinds of evidence. The events must cover
 * the run from its first outbox row (`coverage: "from-start"`): an unbroken
 * range whose sequence 1 is the run's `workflow:created`. A store numbers a
 * run's rows from the highest one it still holds, so after every row of a run
 * was removed the next one is numbered 1 again; only `workflow:created`, which
 * `run.create` writes once and first, shows that a range starts where the run
 * did. A range that starts there and has no hole proves that no row is
 * missing from its start or its middle. It proves nothing about its end: the
 * store numbers the next row one past the highest it still holds, so when
 * rows are removed from the end of a run's outbox and the run then writes
 * again, the new rows take the removed numbers and the range is unbroken
 * again. Nothing in the engine deletes outbox rows (`run.purge` removes the
 * run and leaves them); only the operator's own SQL, such as a pruning job,
 * does, and a purged run has no page. What was
 * removed from the end is found only where what remains contradicts the run
 * or stage rows, by the checks that follow, none of which rests on the
 * numbering.
 *
 * The run's own events must follow the order the engine writes them in:
 * `workflow:created` first; one `workflow:started` for the claim, after
 * `workflow:created` and before any end (or two, a transition's and the
 * claim's, with the run PENDING after the first alone); every later `workflow:started` (a
 * redrive) after a `workflow:completed`, `workflow:failed` or
 * `workflow:cancelled`, because a redrive takes only an ended run;
 * `workflow:completed` only while the run is running, `workflow:failed` also
 * before the claim (a claim that fails writes no start), and
 * `workflow:cancelled` at any point (a cancel that races the run's own end
 * can follow it). The redrives found that way must be exactly the run row's
 * `redriveCount`, since each redrive writes one start and only a redrive adds
 * to the count; fewer is `fewer-redrives`, more contradicts the row. The run
 * state the last of them leaves must be the run row's status: PENDING before
 * the claim, RUNNING after a start, otherwise the status of the last end.
 *
 * And the stage row must agree with them: its status with the last attempt,
 * its `attempt` with the executions the engine counts on it, its `startedAt`
 * with the last `stage:started`, its `completedAt` with the event that ended
 * it, and its `errorMessage` with the last error event. A row starts at
 * attempt 0 and gains 1 per job retry (at the `stage:started` that follows a
 * `stage:retrying`) and per poll retry (at a `stage:retrying` while
 * suspended); a re-delivery and a start after the stage ended gain nothing.
 * A redrive leaves a row of an earlier execution group as it was, reopens a
 * row of the target group at its attempt plus 1 (`lastFailure`, `stage`),
 * creates the target group's rows one past the highest attempt of the rows
 * it replaced (`start`, or a stage new to the definition version), and lets
 * later groups' rows be created again at 0. The events do not say which, so
 * after a redrive each row may hold any of those values; the row's `attempt`
 * must be one the recorded executions can produce. Without a redrive that is
 * exactly one value. Its status and error may also be the ones it had before
 * the redrive (a row it kept), with a later cancel applied. The row and the
 * event of one write are stamped in one handler, the row first, so a row
 * stamped after the last retained event means the events that followed are
 * not retained. A disagreement makes the stage unavailable and names the
 * field.
 *
 * Only what every store writes the same way is read. The stores differ on
 * `startedAt` before a stage's first start: the Prisma store stamps a row
 * with the time it creates it (when the claim, `run.transition` or a redrive
 * creates it), the in-memory store leaves it null, and a redrive from the
 * start creates rows without it on both. So `startedAt` is compared only
 * after a retained `stage:started` with no redrive since, when `job.execute`
 * has stamped it on every store; a stage with no event of its own is read
 * from its status and `attempt` alone.
 *
 * Times stamped by different processes are never compared to decide whether
 * the history is available. `startedAt` is checked against the last
 * `stage:started` (as above), which `job.execute` writes in the transaction
 * that stamps it; `completedAt` against the `stage:completed` or `stage:failed` that ends a
 * COMPLETED or FAILED stage, also written in the transaction that stamps it.
 * Everything else is ordered by `sequence`.
 *
 * Step rows carry no attempt marker of the stage, only `updatedAt`. A step
 * row records the step's latest state, so it is placed in the one attempt
 * whose window [start, end] contains `updatedAt`. That compares the step's
 * time with event times that other processes may have stamped (a window that
 * ends where another worker started, a poll that resumed the stage, a
 * cancel), so the page says a step is placed by its recorded times, not that
 * it changed during that attempt.
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
  /**
   * The id a stage event was written under; `undefined` skips the check that
   * reads it. One `job.execute` writes a stage's start and that execution's
   * end under one id.
   */
  causationId?: string | null;
}

export interface StageAttemptInput {
  redriveCount: number;
  /**
   * The run row's status. When given, the run state its last retained
   * `workflow:*` event leaves must match it.
   */
  runStatus?: string;
  stages: readonly AttemptStageInput[];
  steps: readonly AttemptStepInput[];
  /** Absent when the reader does not provide stage events. */
  stageEvents?: {
    events: readonly AttemptEventInput[];
    coverage: EventCoverage;
    /** False while the page is still reading the run's events in chunks. */
    caughtUp?: boolean;
    /** True while the page makes no request on its own (polling paused). */
    paused?: boolean;
  };
}

/** What the held events are known to cover of the run's outbox rows. */
export type EventCoverage =
  /** Every row from sequence 1, the run's `workflow:created`, to the last one read. */
  | "from-start"
  /** Rows are missing from what was read, or it does not begin with the run's creation. */
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
 * never that its history is empty, and a first read covers the run from its
 * start only when it begins with the run's `workflow:created` at sequence 1
 * (rows numbered from 1 again after every earlier row was removed do not).
 * After that, a read is taken only when it
 * continues what is held (`after` not past `lastSequence`) and reaches
 * further; anything else (a slow response that arrives late, an answer to a
 * request this page did not make) changes nothing. Events are appended by
 * sequence, so a reader that ignores `after` adds each event once. A read
 * that stopped at the reader's limit leaves `more` true: the page asks again
 * from `lastSequence` until it has caught up. A read from the held position
 * whose `lastSequence` is below it says the run's rows past some point were
 * removed: what is held may no longer be the run's rows, so null is returned
 * and the page reads the run again from the start.
 */
export function mergeStageEvents(
  held: HeldStageEvents | null,
  page: StageEventPage,
): HeldStageEvents | null {
  const more = page.more === true;
  if (held === null) {
    if (page.after !== 0) return null;
    const first = page.events[0];
    const fromCreation =
      first?.sequence === 1 && first.eventType === "workflow:created";
    return {
      events: page.events,
      lastSequence: page.lastSequence,
      coverage:
        page.lastSequence <= 0
          ? "none"
          : page.complete && fromCreation
            ? "from-start"
            : "gap",
      more,
    };
  }
  if (page.after === held.lastSequence && page.lastSequence < page.after)
    return null;
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
  /** Rows are missing from the run's outbox: removed by SQL, such as a pruning job. */
  | "events-incomplete"
  /** The run has no retained outbox row at all. */
  | "no-retained-events"
  /** The page has read only part of the run's events so far. */
  | "events-loading"
  /** As `events-loading`, while the page is paused and reads nothing on its own. */
  | "events-paused"
  /** The run row counts more redrives than the retained `workflow:started` events. */
  | "fewer-redrives"
  /**
   * The run's retained `workflow:*` events contradict the engine's order or
   * the run row; `runMismatch` says which. Rows removed from the end of the
   * run's outbox, after which the run wrote again, leave this.
   */
  | "run-inconsistent"
  /** The stage row says it ran, and no lifecycle event of it is retained. */
  | "no-stage-events"
  /**
   * The events contradict each other: an execution ends with no start
   * recorded, a redrive starts while an execution has no recorded end, or
   * an end was written by an earlier execution than the open attempt's.
   */
  | "unproven-boundary"
  /** A retained event has no readable time. */
  | "invalid-event-time"
  /** The events disagree with the stage's current row; `mismatch` names the field. */
  | "inconsistent";

/** What of the run's own events is contradicted. */
export type AttemptRunMismatch =
  /** An event the engine writes only after another, with that other not before it. */
  | "order"
  /** More redrives recorded than the run row counts. */
  | "redrives"
  /** The run state the events end in is not the run row's status. */
  | "status";

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
      /** Set with `run-inconsistent`. */
      runMismatch?: AttemptRunMismatch;
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
  possibleAttempts: ReadonlySet<number>,
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
    // stage; its row must say the same: not past what a stage that never ran
    // can be, on an `attempt` the run's redrives can give a row that never
    // ran. `startedAt` is not read: the Prisma store stamps it when it
    // creates the row, so a row that never ran can carry one.
    const neverRan =
      possibleAttempts.has(stage.attempt) &&
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
  // A redrive keeps the rows of execution groups before its target as they
  // were; the events do not say which group it targeted. Each entry is a
  // state the row may have kept (its statuses and error) through the
  // redrives since this stage's last event; a later cancel turns a kept
  // PENDING row CANCELLED, and the stage's next event ends them all.
  let kept: { statuses: Set<string>; error: typeof rowError }[] = [];
  // The statuses a row whose last attempt is closed can hold now.
  const closedStatuses = (last: Work | undefined) => {
    const statuses = new Set<string>();
    if (last?.outcome === "completed") statuses.add("COMPLETED");
    if (last?.outcome === "failed") statuses.add("FAILED");
    // Waiting for its next job attempt, or for a redrive's.
    if (waiting) statuses.add("PENDING");
    // Cancelled in that wait, or while it ran.
    if (
      runCancelled &&
      (last?.outcome === "retrying" ||
        last?.outcome === "cancelled" ||
        cancelledIdle)
    )
      statuses.add("CANCELLED");
    return statuses;
  };
  // The causation id of each retained `stage:started`, and of the one that
  // opened the current attempt (null for a poll retry, which has none).
  const startIds = new Set<string>();
  let openStartId: string | null = null;

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
        // `run.cancel` marks every unfinished row CANCELLED.
        for (const world of kept) {
          if (world.statuses.delete("PENDING")) world.statuses.add("CANCELLED");
        }
      } else if (event.eventType === "workflow:started") {
        if (open !== null) return unavailable("unproven-boundary");
        if (attempts.length > 0) {
          kept.push({
            statuses: closedStatuses(attempts[attempts.length - 1]),
            error: rowError,
          });
        }
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

    // The stage's own handler wrote its row with this event.
    kept = [];
    const cause = event.causationId ?? null;
    if (event.eventType !== "stage:started") {
      // Written under the id of a start that did not open the current
      // attempt: the end of an earlier execution that kept running (after a
      // cancel or a lost lease), so which attempt it ended is not known.
      const current: string | null = open !== null ? openStartId : null;
      if (cause !== null && startIds.has(cause) && cause !== current)
        return unavailable("unproven-boundary");
    }

    if (event.eventType === "stage:started") {
      if (cause !== null) startIds.add(cause);
      openStartId = cause;
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
        openStartId = null;
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
    // Closed: the row must say what the closing event says, or what a
    // redrive that kept the row left. A stage waiting for its next job
    // attempt (or for a redrive's) is PENDING, and one cancelled in that wait
    // is CANCELLED.
    kept.unshift({ statuses: closedStatuses(last), error: rowError });
    kept = kept.filter((world) => world.statuses.has(stage.status));
    if (kept.length === 0) return unavailable("inconsistent", "status");
  }

  // The row's attempt must be one the recorded executions produce (see
  // `foldRunEvents`): a row ahead of every such value counts executions whose
  // events are not retained.
  if (!possibleAttempts.has(stage.attempt))
    return unavailable("inconsistent", "attempt");

  // `job.execute` stamps `startedAt` before it writes `stage:started`, so
  // after a retained start the row's start is never later than it; a later
  // one is a start whose event is not retained, and none is a row that did
  // not start. Before any start, and after a redrive (which keeps a row's
  // start, or recreates the row), the row holds no start or the time the
  // store created it: the Prisma store stamps a new row, the in-memory
  // store does not, so a value there says nothing.
  if (stage.startedAt !== undefined) {
    const rowStart = stage.startedAt === null ? null : toMs(stage.startedAt);
    const agrees =
      lastStartMs === null ||
      redrivenSinceStart ||
      (rowStart !== null && rowStart <= lastStartMs);
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
    // The error of the current state, or of a kept one with the row's status.
    const errors = last.endMs === null ? [rowError] : kept.map((w) => w.error);
    const agrees = errors.some((error) =>
      error.text === null
        ? row === null
        : row !== null &&
          (row === error.text || (error.cut && row.startsWith(error.text))),
    );
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

/** At most this many immediate reads of a long history per poll interval. */
export const CATCH_UP_READS_PER_INTERVAL = 4;

/**
 * Whether the page reads the next chunk of a run's events at once, and what
 * it then counts as asked. `behindAt` is the held `lastSequence` while rows
 * past it remain, else null. A chunk is read only past the last one asked
 * for, so a reader that stops advancing is not asked again at once. While
 * paused the page reads nothing on its own; resuming polls from what it
 * holds, so the position it holds counts as asked. `recentReads` is how many
 * such reads the page made within the current poll interval: at
 * `CATCH_UP_READS_PER_INTERVAL` it reads nothing and `wait` says to ask again
 * when the interval has passed, so a reader that returns small chunks costs
 * a bounded number of requests per interval.
 */
export function catchUpStep(
  behindAt: number | null,
  askedAt: number,
  paused: boolean,
  recentReads = 0,
): { read: boolean; askedAt: number; wait?: boolean } {
  if (behindAt === null || behindAt <= askedAt) return { read: false, askedAt };
  if (!paused && recentReads >= CATCH_UP_READS_PER_INTERVAL)
    return { read: false, askedAt, wait: true };
  return { read: !paused, askedAt: behindAt };
}

/** Attempt history of every stage, keyed by stage record id. */
export function buildStageAttemptHistory(
  input: StageAttemptInput,
): Map<string, StageAttemptHistory> {
  const result = new Map<string, StageAttemptHistory>();
  const log = input.stageEvents;
  const events = log
    ? [...log.events].sort((a, b) => a.sequence - b.sequence)
    : [];
  const readReason = !log
    ? "no-event-history"
    : log.caughtUp === false
      ? log.paused
        ? "events-paused"
        : "events-loading"
      : log.coverage === "none"
        ? "no-retained-events"
        : log.coverage === "gap"
          ? "events-incomplete"
          : null;
  const fold =
    readReason === null
      ? foldRunEvents(
          events,
          input.stages.map((stage) => stage.stageId),
          input.redriveCount,
          input.runStatus,
        )
      : null;
  for (const stage of input.stages) {
    if (readReason !== null || fold!.unavailable) {
      result.set(stage.id, {
        stageRecordId: stage.id,
        available: false,
        ...(readReason !== null ? { reason: readReason } : fold!.unavailable!),
      });
    } else {
      result.set(
        stage.id,
        historyForStage(
          stage,
          events.filter(
            (event) =>
              (event.stageId === null || event.stageId === stage.stageId) &&
              !fold!.claims.has(event.sequence),
          ),
          input.steps.filter((step) => step.stageRecordId === stage.id),
          fold!.attempts.get(stage.stageId)!,
        ),
      );
    }
  }
  return result;
}

type RunState = "created" | "running" | "COMPLETED" | "FAILED" | "CANCELLED";

/**
 * One pass over a run's events in sequence order: checks the run's own
 * events against the engine's order and the run row (see the header), and
 * collects for every stage the `attempt` values its row can hold.
 */
function foldRunEvents(
  events: readonly AttemptEventInput[],
  rowStageIds: readonly string[],
  redriveCount: number,
  runStatus: string | undefined,
): {
  unavailable?: {
    reason: "fewer-redrives" | "run-inconsistent";
    runMismatch?: AttemptRunMismatch;
  };
  attempts: Map<string, Set<number>>;
  /** Sequences of claims' `workflow:started` that followed a transition's. */
  claims: Set<number>;
} {
  const attempts = new Map<string, Set<number>>();
  const claims = new Set<number>();
  const stageState = new Map<
    string,
    { suspended: boolean; retryPending: boolean }
  >();
  const own = (stageId: string) => {
    if (!attempts.has(stageId)) attempts.set(stageId, new Set([0]));
    let state = stageState.get(stageId);
    if (!state) {
      state = { suspended: false, retryPending: false };
      stageState.set(stageId, state);
    }
    return state;
  };
  for (const stageId of rowStageIds) own(stageId);
  for (const event of events) if (event.stageId !== null) own(event.stageId);
  const bump = (stageId: string) =>
    attempts.set(
      stageId,
      new Set([...attempts.get(stageId)!].map((value) => value + 1)),
    );
  const order = {
    unavailable: {
      reason: "run-inconsistent" as const,
      runMismatch: "order" as const,
    },
    attempts,
    claims,
  };

  let run: RunState | null = null;
  let redrives = 0;
  // The run's first `workflow:started`, with no run event since. A
  // `run.transition` of a PENDING run with no stage rows writes one and
  // leaves the run PENDING; the claim then writes its own.
  let firstStartOnly = false;
  for (const event of events) {
    if (event.stageId !== null) {
      const state = own(event.stageId);
      switch (event.eventType) {
        case "stage:started":
          // `job.execute` adds 1 when it starts a retry of a stage whose
          // last attempt threw (PENDING with its error kept).
          if (state.retryPending) bump(event.stageId);
          state.retryPending = false;
          state.suspended = false;
          break;
        case "stage:suspended":
          state.suspended = true;
          break;
        case "stage:retrying":
          // A poll retry adds 1 at once and the stage stays suspended.
          if (state.suspended) bump(event.stageId);
          else state.retryPending = true;
          break;
        case "stage:completed":
        case "stage:failed":
          state.suspended = false;
          state.retryPending = false;
          break;
      }
      continue;
    }
    const ended =
      run === "COMPLETED" || run === "FAILED" || run === "CANCELLED";
    switch (event.eventType) {
      case "workflow:created":
        if (run !== null) return order;
        run = "created";
        break;
      case "workflow:started":
        if (run === "running" && firstStartOnly) {
          // The claim after a transition: no redrive, no change to a row.
          firstStartOnly = false;
          claims.add(event.sequence);
          continue;
        }
        firstStartOnly = run === "created";
        if (ended) {
          // A redrive: each row may now hold any value the header lists.
          redrives++;
          const any = new Set<number>();
          for (const values of attempts.values())
            for (const value of values) any.add(value + 1);
          for (const [stageId, values] of attempts) {
            // Kept, 0, or one past some row's value (its own reopened, or the
            // highest of those a restart replaced).
            const next = new Set<number>([0, ...any, ...values]);
            attempts.set(stageId, next);
          }
        } else if (run !== "created") return order;
        run = "running";
        for (const state of stageState.values()) {
          state.suspended = false;
          state.retryPending = false;
        }
        break;
      case "workflow:completed":
        firstStartOnly = false;
        if (run !== "running") return order;
        run = "COMPLETED";
        break;
      case "workflow:failed":
        firstStartOnly = false;
        if (run !== "running" && run !== "created") return order;
        run = "FAILED";
        break;
      case "workflow:cancelled":
        firstStartOnly = false;
        if (run === null) return order;
        run = "CANCELLED";
        // A cancelled stage is not PENDING, so a later start is no retry.
        for (const state of stageState.values()) {
          state.suspended = false;
          state.retryPending = false;
        }
        break;
    }
  }
  if (redrives < redriveCount)
    return { unavailable: { reason: "fewer-redrives" }, attempts, claims };
  if (redrives > redriveCount)
    return {
      unavailable: { reason: "run-inconsistent", runMismatch: "redrives" },
      attempts,
      claims,
    };
  if (runStatus !== undefined) {
    const expected =
      run === "created" ? "PENDING" : run === "running" ? "RUNNING" : run;
    // After a transition's start alone the run is still PENDING.
    const pendingAfterTransition =
      firstStartOnly && run === "running" && runStatus === "PENDING";
    if (runStatus !== expected && !pendingAfterTransition)
      return {
        unavailable: { reason: "run-inconsistent", runMismatch: "status" },
        attempts,
        claims,
      };
  }
  return { attempts, claims };
}
