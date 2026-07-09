/**
 * Kernel Factory
 *
 * Creates a Kernel instance with a typed `dispatch` method that routes
 * commands to their corresponding handlers. Events are written to a
 * transactional outbox (not emitted directly). Use the `outbox.flush`
 * command to publish pending outbox events through EventSink.
 *
 * Most commands execute inside a single database transaction (handler
 * logic + outbox event writes). Two exceptions manage their own
 * transactions to avoid holding connections during external I/O:
 *
 *  - `job.execute` — multi-phase pattern (see `handlers/job-execute.ts`)
 *  - `stage.pollSuspended` — per-stage transactions so that
 *    checkCompletion() HTTP calls run outside any transaction
 *    (see `handlers/stage-poll-suspended.ts`)
 *
 * Commands with idempotency keys are deduplicated: a replay returns the
 * cached result without re-executing the handler.
 */

import type { Workflow } from "../core/workflow";
import type {
  AnnotationActor,
  AnnotationFilters,
  AnnotationScope,
  CreateAnnotationInput,
  CreateOutboxEventInput,
  WorkflowAnnotationRecord,
} from "../persistence/interface";
import type {
  CommandResult,
  JobExecuteResult,
  KernelCommand,
  LeaseReapStaleResult,
  OutboxFlushResult,
  PluginReplayDLQResult,
  RunCancelResult,
  RunClaimPendingResult,
  RunCreateResult,
  RunReapStuckResult,
  RunRerunFromResult,
  RunTransitionResult,
  StagePollSuspendedResult,
} from "./commands";
import { IdempotencyInProgressError } from "./errors";
import type { KernelEvent } from "./events";
import { createLocalExecutor } from "./executor/local-executor.js";
import { handleJobExecute } from "./handlers/job-execute";
import { handleLeaseReapStale } from "./handlers/lease-reap-stale";
import { handleOutboxFlush } from "./handlers/outbox-flush";
import { handlePluginReplayDLQ } from "./handlers/plugin-replay-dlq";
import { handleRunCancel } from "./handlers/run-cancel";
import { handleRunClaimPending } from "./handlers/run-claim-pending";
import { handleRunCreate } from "./handlers/run-create";
import { handleRunReapStuck } from "./handlers/run-reap-stuck";
import { handleRunRerunFrom } from "./handlers/run-rerun-from";
import { handleRunTransition } from "./handlers/run-transition";
import { handleStagePollSuspended } from "./handlers/stage-poll-suspended";
import {
  buildAnnotationEvents,
  filterCouldMatchLegacy,
  synthesizeLegacyMetadata,
} from "./helpers/index.js";
import type {
  ActivityExecutor,
  BlobStore,
  Clock,
  EventSink,
  JobTransport,
  Persistence,
  Scheduler,
} from "./ports";

// ============================================================================
// Public interfaces
// ============================================================================

export interface WorkflowRegistry {
  getWorkflow(id: string): Workflow<any, any> | undefined;
}

export interface KernelConfig {
  persistence: Persistence;
  blobStore: BlobStore;
  jobTransport: JobTransport;
  eventSink: EventSink;
  /**
   * @deprecated The Scheduler port is unused by the kernel (zero
   * `schedule()`/`cancel()` call sites). Omit it — the kernel supplies an
   * internal no-op. Will be removed at 1.0.
   */
  scheduler?: Scheduler;
  clock: Clock;
  registry: WorkflowRegistry;
  executor?: ActivityExecutor;
  /**
   * How long an idempotency key may sit `in_progress` before a subsequent
   * dispatch is allowed to reclaim it. Guards against a dispatcher that
   * crashed between committing its transaction and calling
   * `completeIdempotencyKey`, which would otherwise leave the key
   * permanently stuck and every future dispatch with that key throwing
   * `IdempotencyInProgressError`. Defaults to 10 minutes. Set to
   * `Infinity` to disable reclaiming.
   */
  idempotencyStaleInProgressMs?: number;
}

/** Default TTL after which a stuck `in_progress` idempotency key can be reclaimed. */
const DEFAULT_IDEMPOTENCY_STALE_IN_PROGRESS_MS = 10 * 60 * 1000;

/** Input for the public `kernel.annotations.attach` helper. */
export interface AnnotateAttachInput {
  attributes: Record<string, unknown>;
  actor?: AnnotationActor;
  /**
   * Defaults to "run". Set to "stage" with `scopeId` to scope an
   * annotation to a specific stage (e.g., from a plugin observing
   * stage events).
   */
  scope?: AnnotationScope;
  scopeId?: string | null;
  workflowStageRecordId?: string | null;
  attempt?: number;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  /**
   * If true, the engine writes an `annotation:created` outbox event
   * for each attribute in this batch, in the same transaction as the
   * annotation rows. Off by default.
   */
  emitEvent?: boolean;
}

/**
 * Public helpers for working with annotations directly — for plugins,
 * post-hoc reviews, external integrations, and query tooling. The
 * `attach` path commits in a single transaction; the `list` path is a
 * read-only query honoring the persistence-port filters.
 */
export interface KernelAnnotations {
  attach(workflowRunId: string, input: AnnotateAttachInput): Promise<void>;
  list(
    workflowRunId: string,
    filters?: AnnotationFilters,
  ): Promise<WorkflowAnnotationRecord[]>;
}

export interface Kernel {
  dispatch<T extends KernelCommand>(command: T): Promise<CommandResult<T>>;
  annotations: KernelAnnotations;
}

// ============================================================================
// Shared dependency bundle passed to every handler
// ============================================================================

export interface KernelDeps {
  persistence: Persistence;
  blobStore: BlobStore;
  jobTransport: JobTransport;
  eventSink: EventSink;
  scheduler?: Scheduler;
  clock: Clock;
  registry: WorkflowRegistry;
  executor: ActivityExecutor;
}

// ============================================================================
// Internal handler result type (includes _events for central emission)
// ============================================================================

export type HandlerResult<T> = T & {
  _events: KernelEvent[];
  /**
   * Optional side effect to run only after the enclosing transaction has
   * committed — e.g. deleting blob artifacts that a rollback could not
   * bring back. Handlers routed through the kernel's generic transaction
   * path (see the `switch` in `dispatchAny`) may set this instead of
   * performing the side effect inline mid-transaction.
   */
  _postCommit?: (deps: KernelDeps) => Promise<unknown>;
};

// ============================================================================
// Helpers
// ============================================================================

/** Extract idempotency key from commands that carry one. */
function getIdempotencyKey(command: KernelCommand): string | undefined {
  if (command.type === "run.create") return command.idempotencyKey;
  if (command.type === "job.execute") return command.idempotencyKey;
  if (command.type === "run.rerunFrom") return command.idempotencyKey;
  return undefined;
}

/** Union of every command's result type — `dispatchAny`'s return type. */
type AnyCommandResult =
  | RunCreateResult
  | RunClaimPendingResult
  | RunTransitionResult
  | RunCancelResult
  | RunRerunFromResult
  | JobExecuteResult
  | StagePollSuspendedResult
  | LeaseReapStaleResult
  | OutboxFlushResult
  | PluginReplayDLQResult
  | RunReapStuckResult;

/** Strip the internal `_events`/`_postCommit` fields off a handler result. */
function stripEvents<R>(result: HandlerResult<R>): R {
  const { _events, _postCommit, ...rest } = result;
  return rest as R;
}

/**
 * No-op `Scheduler` supplied when `KernelConfig.scheduler` is omitted. The
 * Scheduler port is unused by the kernel today — see the @deprecated note
 * on `kernel/testing/noop-scheduler.ts`, which remains for existing test
 * fixtures that still construct one explicitly.
 */
const internalNoopScheduler: Scheduler = {
  async schedule() {},
  async cancel() {},
};

// ============================================================================
// Factory
// ============================================================================

export function createKernel(config: KernelConfig): Kernel {
  const { persistence, blobStore, jobTransport, eventSink, clock, registry } =
    config;

  // Default to LocalExecutor if none provided
  const executor = config.executor ?? createLocalExecutor();
  // The Scheduler port is unused by the kernel (see internalNoopScheduler
  // above) — default so callers aren't required to supply one.
  const scheduler = config.scheduler ?? internalNoopScheduler;
  const idempotencyStaleInProgressMs =
    config.idempotencyStaleInProgressMs ??
    DEFAULT_IDEMPOTENCY_STALE_IN_PROGRESS_MS;

  const deps: KernelDeps = {
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry,
    executor,
  };

  /**
   * Idempotency-key choreography shared by job.execute's own transaction
   * phasing and the generic transactional path below: acquire → replay a
   * cached result / reject an in-progress duplicate / run `fn` then cache
   * its result on success, releasing the key on failure so a later
   * dispatch may retry.
   */
  async function withIdempotency<R>(
    key: string | undefined,
    commandType: string,
    fn: () => Promise<R>,
  ): Promise<R> {
    if (!key) return fn();

    const acquired = await persistence.acquireIdempotencyKey(key, commandType, {
      now: clock.now(),
      staleInProgressAfterMs: idempotencyStaleInProgressMs,
    });

    if (acquired.status === "replay") {
      return acquired.result as R;
    }
    if (acquired.status === "in_progress") {
      throw new IdempotencyInProgressError(key, commandType);
    }

    try {
      const result = await fn();
      await persistence.completeIdempotencyKey(key, commandType, result);
      return result;
    } catch (error) {
      await persistence.releaseIdempotencyKey(key, commandType).catch(() => {});
      throw error;
    }
  }

  /**
   * Concrete-union-typed dispatch core. Unlike the public `dispatch<T>`,
   * `command` here is `KernelCommand` (not a generic type parameter), so
   * every `command.type === "..."` / `switch (command.type)` check below
   * narrows `command` natively — no `command as XxxCommand` casts.
   */
  async function dispatchAny(
    command: KernelCommand,
  ): Promise<AnyCommandResult> {
    // -----------------------------------------------------------------
    // outbox.flush routes directly — no outbox write, no idempotency
    // -----------------------------------------------------------------
    if (command.type === "outbox.flush") {
      const result = await handleOutboxFlush(command, deps);
      return stripEvents(result);
    }

    // -----------------------------------------------------------------
    // plugin.replayDLQ routes directly — no outbox write, no idempotency
    // -----------------------------------------------------------------
    if (command.type === "plugin.replayDLQ") {
      const result = await handlePluginReplayDLQ(command, deps);
      return stripEvents(result);
    }

    // -----------------------------------------------------------------
    // stage.pollSuspended manages its own per-stage transactions so
    // that checkCompletion() (which makes external HTTP calls) does
    // not hold a database transaction open.
    // -----------------------------------------------------------------
    if (command.type === "stage.pollSuspended") {
      const result = await handleStagePollSuspended(command, deps);
      return stripEvents(result);
    }

    // -----------------------------------------------------------------
    // job.execute manages its own multi-phase transactions so that
    // RUNNING status is visible immediately and long-running stage
    // execution does not hold a database transaction open.
    // -----------------------------------------------------------------
    if (command.type === "job.execute") {
      return withIdempotency(command.idempotencyKey, command.type, async () => {
        const result = await handleJobExecute(command, deps);
        return stripEvents(result);
      });
    }

    // -----------------------------------------------------------------
    // Every remaining command shares one transactional path: route to
    // handler + append outbox events in one transaction.
    // -----------------------------------------------------------------
    const idempotencyKey = getIdempotencyKey(command);

    return withIdempotency(idempotencyKey, command.type, async () => {
      let postCommit: ((deps: KernelDeps) => Promise<unknown>) | undefined;

      const publicResult = await persistence.withTransaction(async (tx) => {
        const txDeps: KernelDeps = { ...deps, persistence: tx };
        let result: HandlerResult<any>;

        switch (command.type) {
          case "run.create":
            result = await handleRunCreate(command, txDeps);
            break;
          case "run.claimPending":
            result = await handleRunClaimPending(command, txDeps);
            break;
          case "run.transition":
            result = await handleRunTransition(command, txDeps);
            break;
          case "run.cancel":
            result = await handleRunCancel(command, txDeps);
            break;
          case "run.rerunFrom":
            result = await handleRunRerunFrom(command, txDeps);
            break;
          case "lease.reapStale":
            result = await handleLeaseReapStale(command, txDeps);
            break;
          case "run.reapStuck":
            result = await handleRunReapStuck(command, txDeps);
            break;
          default: {
            const _exhaustive: never = command;
            throw new Error(
              `Unknown command type: ${(_exhaustive as KernelCommand).type}`,
            );
          }
        }

        const events = result._events;
        if (events.length > 0) {
          const causationId = idempotencyKey ?? crypto.randomUUID();
          const outboxEvents: CreateOutboxEventInput[] = events.map(
            (event: KernelEvent) => ({
              workflowRunId: event.workflowRunId,
              eventType: event.type,
              payload: event,
              causationId,
              occurredAt: event.timestamp,
            }),
          );
          await tx.appendOutboxEvents(outboxEvents);
        }

        postCommit = result._postCommit;
        return stripEvents(result);
      });

      if (postCommit) {
        // Runs only now that the transaction has committed — the DB
        // state this side effect depends on (e.g. deleted stage rows)
        // can no longer be rolled back out from under it.
        await postCommit(deps);
      }

      return publicResult;
    });
  }

  /**
   * Public dispatch: a thin generic wrapper around `dispatchAny`. `T` is
   * a generic type parameter, so it can't narrow through the discriminant
   * checks that give `dispatchAny` its native narrowing — this cast is
   * the one place that bridges `KernelCommand`'s concrete result back to
   * the caller's specific `CommandResult<T>`.
   */
  function dispatch<T extends KernelCommand>(
    command: T,
  ): Promise<CommandResult<T>> {
    return dispatchAny(command) as Promise<CommandResult<T>>;
  }

  const annotations: KernelAnnotations = {
    async attach(workflowRunId, input) {
      const scope = input.scope ?? "run";
      const inputs: CreateAnnotationInput[] = [];
      for (const [key, value] of Object.entries(input.attributes)) {
        // Skip `undefined` values (OTel pattern). This lets callers write
        // { "x.id": maybeId } without guarding — present-or-absent.
        if (value === undefined || value === null) continue;
        inputs.push({
          workflowRunId,
          workflowStageRecordId: input.workflowStageRecordId ?? null,
          attempt: input.attempt,
          scope,
          scopeId: input.scopeId ?? null,
          actor: input.actor,
          key,
          value,
          payload: input.payload,
          idempotencyKey: input.idempotencyKey,
          emitEvent: input.emitEvent,
        });
      }
      if (inputs.length === 0) return;
      // One causation id per attach call — matches the kernel's
      // dispatch convention where all events from a single command
      // share a causationId. Prefer the caller's idempotency key when
      // supplied (stable across retries); otherwise a fresh UUID.
      const causationId = input.idempotencyKey ?? crypto.randomUUID();
      // Wrap in a transaction so all attributes commit atomically.
      // Without this, an external-attach batch could partial-commit if
      // the persistence layer fails mid-write.
      await persistence.withTransaction(async (tx) => {
        await tx.appendAnnotations(inputs);
        const events = buildAnnotationEvents(inputs, clock.now());
        if (events.length > 0) {
          await tx.appendOutboxEvents(
            events.map((event) => ({
              workflowRunId: event.workflowRunId,
              eventType: event.type,
              payload: event,
              causationId,
              occurredAt: event.timestamp,
            })),
          );
        }
      });
    },
    async list(workflowRunId, filters) {
      const persisted = await persistence.listAnnotations(
        workflowRunId,
        filters,
      );

      // Lazy migration shim for the deprecated WorkflowRun.metadata
      // column. Synthesize virtual `legacy.metadata.*` rows iff:
      //   - the filter could match legacy keys (cheap pre-check)
      //   - AND no migrated `legacy.metadata.*` rows exist on the run
      //     (detected via a separate, filter-agnostic query so that
      //     a consumer's narrow filter — e.g. `{ keyPrefix: "x" }` or
      //     a low `limit` — can't hide an already-migrated row and
      //     trigger spurious synthesis)
      // See helpers/legacy-metadata-shim.ts for the contract.
      if (!filterCouldMatchLegacy(filters ?? {})) return persisted;

      const migrationCheck = await persistence.listAnnotations(workflowRunId, {
        keyPrefix: "legacy.metadata.",
        limit: 1,
      });
      if (migrationCheck.length > 0) return persisted;

      const run = await persistence.getRun(workflowRunId);
      if (!run) return persisted;
      const synthesized = synthesizeLegacyMetadata(run, filters);
      if (synthesized.length === 0) return persisted;

      const merged = [...persisted, ...synthesized].sort((a, b) => {
        const cmp = a.createdAt.getTime() - b.createdAt.getTime();
        if (cmp !== 0) return cmp;
        return a.id.localeCompare(b.id);
      });

      const limit = filters?.limit ?? 1000;
      return merged.slice(0, limit);
    },
  };

  return { dispatch, annotations };
}
