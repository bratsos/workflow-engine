/**
 * The console's write vocabulary.
 *
 * Modelled on verbs rather than HTTP methods, so an `authorize` callback
 * grants "may cancel a run" rather than "may POST". Every write dispatches
 * a kernel command — the console never issues SQL of its own. That is not
 * squeamishness: the kernel owns run state, and a console that wrote
 * `UPDATE workflow_runs SET status='CANCELLED'` would be a second,
 * unaudited writer against state the kernel believes it is alone in
 * changing, skipping the leases, idempotency and outbox events every other
 * path goes through.
 */

/** Every action the console can be asked to perform, read or write. */
export const CONSOLE_ACTIONS = [
  "runs.read",
  "run.read",
  "queue.read",
  "suspended.read",
  "deadLetters.read",
  "workers.read",
  "costs.read",
  "run.cancel",
  "run.rerun",
  "step.signal",
  "deadLetters.replay",
] as const;

export type ConsoleAction = (typeof CONSOLE_ACTIONS)[number];

/** The subset that changes state. Each is refused unless `actions` is enabled. */
export const WRITE_ACTIONS: readonly ConsoleAction[] = [
  "run.cancel",
  "run.rerun",
  "step.signal",
  "deadLetters.replay",
] as const;

export function isWriteAction(action: ConsoleAction): boolean {
  return WRITE_ACTIONS.includes(action);
}

/**
 * The minimum of the engine's kernel the console needs: a dispatcher.
 *
 * Declared structurally rather than imported so the package carries no
 * runtime dependency on the engine and nothing in the engine can come to
 * depend on the console.
 */
export interface ConsoleKernel {
  dispatch(command: {
    readonly type: string;
    readonly [key: string]: unknown;
  }): Promise<unknown>;
}

/** What `authorize` is asked, and what `onAction` is told afterwards. */
export interface ConsoleAuthorizeContext {
  action: ConsoleAction;
  request: Request;
  /** Present for the actions scoped to one run. */
  runId?: string;
  /** Present for the actions scoped to one durable step (`step.signal`). */
  stageId?: string;
  stepId?: string;
}

export interface ConsoleActionEvent {
  action: ConsoleAction;
  runId?: string;
  stageId?: string;
  stepId?: string;
  request: Request;
  result: unknown;
  at: Date;
}
