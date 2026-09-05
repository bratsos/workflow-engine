/**
 * `createMockStepLedger` — seed durable step outcomes, and read them back.
 *
 * A mocked step is not an interception layer wrapped around the step API: it
 * is a pre-seeded ledger row. The engine already decides what to do with a
 * step by looking the row up (`completed` short-circuits, `failed` rethrows,
 * a wait past its `deadlineAt` times out), so a mock only has to write the
 * row the engine was about to write, with a different outcome in it. Every
 * assertion below therefore reads the real ledger, and a mocked step is
 * indistinguishable from one that genuinely produced that outcome.
 *
 * The seed is applied as a patch on the record the engine passed to
 * `claim()`, so `stageRecordId`, `stepId`, `seq`, `kind` and `externalKey`
 * are always the engine's own values — a mock can never disagree with the
 * engine about what step it is.
 *
 * A seed answers for the whole run, not just the first attempt: when the
 * engine reopens a failed stage's step rows for a fresh attempt, the seed is
 * re-asserted, so a mocked step never falls back to its real body part-way
 * through a run. Call `clearMocks()` to hand a step back to its body.
 */

import type {
  Clock,
  StepLedger,
  StepRecord,
  StepRecordExpectation,
  StepRecordPatch,
} from "../kernel/ports.js";

/**
 * The `attempt` a mocked failure is recorded at.
 *
 * `step.run` rethrows a stored failure only once `attempt` has passed the
 * step's own `retries` budget; below it the step is reclaimed and the real
 * body runs. A mocked error is meant to be the step's final answer, so it is
 * recorded above any retry budget a step could declare. Pass
 * `mockError(id, err, { attempt })` to seed a lower attempt and let the
 * step's own retries re-enter the real body.
 */
export const MOCKED_FAILURE_ATTEMPT = Number.MAX_SAFE_INTEGER;

type LedgerKind = StepRecord["kind"];

interface StepMock {
  readonly seed: (
    record: Omit<StepRecord, "createdAt" | "updatedAt">,
    now: Date,
  ) => Omit<StepRecord, "createdAt" | "updatedAt">;
  /** Ledger kinds this mock is valid for; undefined means every kind. */
  readonly kinds?: ReadonlySet<LedgerKind>;
  /** Message thrown when the step turns out to be a kind this mock cannot serve. */
  readonly wrongKind: (kind: LedgerKind) => string;
}

/** Seeding and assertion surface exposed as `harness.steps`. */
export interface StepMockApi {
  /**
   * The next claim of `stepId` records a completed step with this result,
   * without running its body. Applies to `step.run`, `step.waitFor` and
   * `step.waitForSignal`.
   */
  mockResult(stepId: string, result: unknown): void;
  /**
   * The next claim of `stepId` records a failed step, so the step throws the
   * stored error instead of running its body.
   *
   * Recorded at {@link MOCKED_FAILURE_ATTEMPT} so the step's own `retries`
   * do not re-enter the real body. Pass `{ attempt }` to seed a lower one
   * when the retry path is what you are testing.
   */
  mockError(stepId: string, error: unknown, opts?: { attempt?: number }): void;
  /**
   * The next claim of `stepId` records a wait whose deadline has already
   * passed, so the step fails with `StepTimeoutError` through the engine's
   * own timeout path. Only `step.waitFor` and `step.waitForSignal` have a
   * deadline; mocking any other kind this way throws.
   */
  mockTimeout(stepId: string): void;
  /** `step.sleep(stepId, …)` returns immediately instead of suspending. */
  skipSleep(stepId: string): void;
  /** Every `step.sleep` returns immediately instead of suspending. */
  skipSleeps(): void;
  /** Drop every seed, including `skipSleeps()`. Recorded rows are untouched. */
  clearMocks(): void;
  /** True once a seed has decided `stepId`'s recorded outcome. */
  wasMocked(stepId: string): boolean;

  /** The recorded row for `stepId`, or null when the step never ran. */
  record(stepId: string): Promise<StepRecord | null>;
  /** Every row this ledger holds, in `(stage, seq)` order. */
  records(): Promise<StepRecord[]>;
  /** Recorded status of `stepId`, or undefined when the step never ran. */
  status(stepId: string): Promise<StepRecord["status"] | undefined>;
  /** Recorded result of `stepId`. Undefined when the step never ran. */
  result<T = unknown>(stepId: string): Promise<T | undefined>;
  /** Recorded error message of `stepId`, when it failed. */
  error(stepId: string): Promise<string | undefined>;
}

/** A `StepLedger` that also seeds and reports step outcomes. */
export type MockStepLedger = StepLedger & { readonly steps: StepMockApi };

const WAIT_KINDS: ReadonlySet<LedgerKind> = new Set<LedgerKind>([
  "wait",
  "signal",
]);
const SLEEP_KINDS: ReadonlySet<LedgerKind> = new Set<LedgerKind>(["sleep"]);

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wraps a `StepLedger` so step outcomes can be seeded before a run and read
 * back after one.
 *
 * Seeds match by step id across every stage: a step id is unique within a
 * stage, so this only matters when two stages deliberately reuse one, and
 * then the seed applies to whichever claims it first.
 */
export function createMockStepLedger(
  inner: StepLedger,
  clock: Clock,
): MockStepLedger {
  const mocks = new Map<string, StepMock>();
  let skipEverySleep = false;
  /** Every stage whose rows this ledger has touched, in first-seen order. */
  const stages = new Set<string>();
  /** Step ids whose recorded row was written by a seed. */
  const applied = new Set<string>();

  function track(stageRecordId: string): void {
    stages.add(stageRecordId);
  }

  function set(stepId: string, mock: StepMock): void {
    if (!stepId) throw new Error("Step id must not be empty");
    mocks.set(stepId, mock);
  }

  function pick(record: Omit<StepRecord, "createdAt" | "updatedAt">) {
    const mock = mocks.get(record.stepId);
    if (mock) {
      if (mock.kinds && !mock.kinds.has(record.kind)) {
        throw new Error(mock.wrongKind(record.kind));
      }
      return mock;
    }
    if (skipEverySleep && record.kind === "sleep") return skipSleepMock;
    return undefined;
  }

  const skipSleepMock: StepMock = {
    seed: (record) => ({
      ...record,
      status: "completed",
      result: null,
      error: null,
      leaseExpiresAt: null,
    }),
    kinds: SLEEP_KINDS,
    wrongKind: (kind) =>
      `skipSleep can only mock a sleep step; "${kind}" steps are not sleeps.`,
  };

  const steps: StepMockApi = {
    mockResult(stepId, result) {
      set(stepId, {
        seed: (record) => ({
          ...record,
          status: "completed",
          result,
          error: null,
          leaseExpiresAt: null,
        }),
        wrongKind: (kind) =>
          `mockResult cannot mock a "${kind}" step: a sleep has no result. Use skipSleep instead.`,
        kinds: new Set<LedgerKind>(["run", "wait", "signal"]),
      });
    },

    mockError(stepId, error, opts) {
      const message = toMessage(error);
      const attempt = opts?.attempt ?? MOCKED_FAILURE_ATTEMPT;
      set(stepId, {
        seed: (record) => ({
          ...record,
          status: "failed",
          error: message,
          attempt,
          leaseExpiresAt: null,
        }),
        wrongKind: () => "",
      });
    },

    mockTimeout(stepId) {
      set(stepId, {
        seed: (record, now) => ({
          ...record,
          status: "pending",
          // One millisecond in the past: the engine's own deadline check
          // fires on the first claim and writes the timeout itself.
          deadlineAt: new Date(now.getTime() - 1),
        }),
        kinds: WAIT_KINDS,
        wrongKind: (kind) =>
          `mockTimeout can only mock a step with a deadline (waitFor, waitForSignal); "${kind}" steps have none. Use mockError for a run step, or skipSleep for a sleep.`,
      });
    },

    skipSleep(stepId) {
      set(stepId, {
        seed: skipSleepMock.seed,
        kinds: SLEEP_KINDS,
        wrongKind: skipSleepMock.wrongKind,
      });
    },

    skipSleeps() {
      skipEverySleep = true;
    },

    clearMocks() {
      mocks.clear();
      skipEverySleep = false;
    },

    wasMocked(stepId) {
      return applied.has(stepId);
    },

    async records() {
      const all: StepRecord[] = [];
      for (const stageRecordId of stages) {
        all.push(...(await inner.list(stageRecordId)));
      }
      return all;
    },

    async record(stepId) {
      const matches = (await steps.records()).filter(
        (record) => record.stepId === stepId,
      );
      if (matches.length === 0) return null;
      // Two stages may reuse one step id; the freshest row is the one a
      // caller asserting mid-run means.
      return matches.reduce((newest, candidate) =>
        candidate.updatedAt.getTime() >= newest.updatedAt.getTime()
          ? candidate
          : newest,
      );
    },

    async status(stepId) {
      return (await steps.record(stepId))?.status;
    },

    async result<T = unknown>(stepId: string) {
      return (await steps.record(stepId))?.result as T | undefined;
    },

    async error(stepId) {
      return (await steps.record(stepId))?.error ?? undefined;
    },
  };

  const ledger: MockStepLedger = {
    steps,

    async claim(record) {
      track(record.stageRecordId);
      const mock = pick(record);
      if (!mock) return inner.claim(record);

      const seeded = mock.seed(record, clock.now());
      const claimed = await inner.claim(seeded);
      applied.add(record.stepId);
      // Report it as pre-existing so the engine reads the outcome off the
      // row instead of running the body it was about to run.
      if (claimed.created) return { created: false, record: claimed.record };

      // The row already exists. That is either a plain replay — rewriting
      // the same outcome changes nothing — or the engine has reset the row
      // for a fresh stage attempt (a failed `run` step that named an
      // external effect is kept and reopened rather than deleted). A seed
      // is the step's answer for the whole run, not just its first attempt,
      // so re-assert it either way.
      const restored = await inner.update(record.stageRecordId, record.stepId, {
        status: seeded.status,
        attempt: seeded.attempt,
        result: seeded.result,
        error: seeded.error,
        leaseExpiresAt: seeded.leaseExpiresAt,
        deadlineAt: seeded.deadlineAt,
        waitState: seeded.waitState,
      });
      return { created: false, record: restored };
    },

    async get(stageRecordId: string, stepId: string) {
      track(stageRecordId);
      return inner.get(stageRecordId, stepId);
    },

    async update(
      stageRecordId: string,
      stepId: string,
      patch: StepRecordPatch,
    ) {
      track(stageRecordId);
      return inner.update(stageRecordId, stepId, patch);
    },

    async compareAndSet(
      stageRecordId: string,
      stepId: string,
      expected: StepRecordExpectation,
      patch: StepRecordPatch,
    ) {
      track(stageRecordId);
      return inner.compareAndSet(stageRecordId, stepId, expected, patch);
    },

    async list(stageRecordId: string) {
      track(stageRecordId);
      return inner.list(stageRecordId);
    },

    async clear(stageRecordId: string) {
      track(stageRecordId);
      return inner.clear(stageRecordId);
    },
  };

  // `clearExcept` is optional on the port and the kernel branches on whether
  // it exists, so the wrapper must mirror the wrapped ledger exactly: always
  // defining it would make a ledger that cannot do a partial reset claim it
  // can, and never defining it would silently downgrade one that can.
  if (inner.clearExcept) {
    const clearExcept = inner.clearExcept.bind(inner);
    ledger.clearExcept = async (stageRecordId: string, keep: string[]) => {
      track(stageRecordId);
      return clearExcept(stageRecordId, keep);
    };
  }

  return ledger;
}
