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

import { createAIHelper } from "../ai/ai-helper.js";
import type { Workflow } from "../core/workflow";
import type {
  AnnotationActor,
  AnnotationFilters,
  AnnotationScope,
  CreateAnnotationInput,
  CreateOutboxEventInput,
  ServedDefinition,
  WorkflowAnnotationRecord,
} from "../persistence/interface";
import type {
  CommandResult,
  JobExecuteResult,
  JobHeartbeatResult,
  KernelCommand,
  LeaseReapStaleResult,
  OutboxFlushResult,
  PluginReplayDLQResult,
  RunCancelResult,
  RunClaimPendingResult,
  RunCreateResult,
  RunListVersionsResult,
  RunPurgeResult,
  RunReapStuckResult,
  RunRedriveResult,
  RunRerunFromResult,
  RunTransitionResult,
  StagePollSuspendedResult,
  StepSignalResult,
} from "./commands";
import { IdempotencyInProgressError } from "./errors";
import type { KernelEvent } from "./events";
import { createLocalExecutor } from "./executor/local-executor.js";
import { handleJobExecute } from "./handlers/job-execute";
import { handleJobHeartbeat } from "./handlers/job-heartbeat";
import { handleLeaseReapStale } from "./handlers/lease-reap-stale";
import { handleOutboxFlush } from "./handlers/outbox-flush";
import { handlePluginReplayDLQ } from "./handlers/plugin-replay-dlq";
import { handleRunCancel } from "./handlers/run-cancel";
import { handleRunClaimPending } from "./handlers/run-claim-pending";
import { handleRunCreate } from "./handlers/run-create";
import { handleRunListVersions } from "./handlers/run-list-versions";
import { handleRunPurge } from "./handlers/run-purge";
import { handleRunReapStuck } from "./handlers/run-reap-stuck";
import { handleRunRedrive } from "./handlers/run-redrive";
import { handleRunRerunFrom } from "./handlers/run-rerun-from";
import { handleRunTransition } from "./handlers/run-transition";
import { handleStagePollSuspended } from "./handlers/stage-poll-suspended";
import { handleStepSignal } from "./handlers/step-signal.js";
import { servedDefinitions } from "./helpers/definition-pinning.js";
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
  KernelServices,
  Persistence,
  StepLedger,
} from "./ports";
import { createPayloadSpill, withStepResultSpill } from "./spill.js";

// ============================================================================
// Public interfaces
// ============================================================================

export interface WorkflowRegistry {
  getWorkflow(id: string): Workflow<any, any> | undefined;
  /**
   * Every workflow this process can execute. Optional for backwards
   * compatibility — but supplying it is what turns version-filtered
   * claiming on: `run.claimPending` uses it to claim only runs pinned to a
   * definition version this build actually serves, which is what makes a
   * rolling deploy safe by construction. Without it, claiming is
   * unfiltered, as it was before definition versioning.
   *
   * `createWorkflowRegistry(workflows)` implements this for you.
   */
  listWorkflows?(): ReadonlyArray<Workflow<any, any>>;
}

/**
 * Builds a {@link WorkflowRegistry} from a list of built workflows,
 * including the `listWorkflows` enumeration that enables version-filtered
 * claiming.
 *
 * @example
 * ```typescript
 * const kernel = createKernel({
 *   registry: createWorkflowRegistry([invoiceWorkflow, reportWorkflow]),
 *   // ...
 * });
 * ```
 */
export function createWorkflowRegistry(
  workflows: ReadonlyArray<Workflow<any, any>>,
): WorkflowRegistry {
  const byId = new Map<string, Workflow<any, any>>();
  for (const workflow of workflows) {
    const existing = byId.get(workflow.id);
    if (existing && existing !== workflow) {
      throw new Error(
        `Two different workflows share the id "${workflow.id}". Workflow ids must be unique within a registry.`,
      );
    }
    byId.set(workflow.id, workflow);
  }
  const all = Array.from(byId.values());
  return {
    getWorkflow: (id) => byId.get(id),
    listWorkflows: () => all,
  };
}

export interface KernelConfig {
  persistence: Persistence;
  blobStore: BlobStore;
  jobTransport: JobTransport;
  eventSink: EventSink;
  clock: Clock;
  registry: WorkflowRegistry;
  executor?: ActivityExecutor;
  /** Optional durable step storage. Stages without ctx.step need none. */
  stepLedger?: StepLedger;
  /** Optional services exposed lazily through stage contexts. */
  services?: KernelServices;
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
  /**
   * Soft threshold, in bytes of serialised JSON, above which a durable step
   * result is written to `blobStore` and the ledger row keeps only a
   * reference. Defaults to `DEFAULT_SPILL_THRESHOLD_BYTES` (64 KiB).
   *
   * There is no hard ceiling above it — a payload larger than the threshold
   * is spilled, never rejected. Reads resolve the reference before the
   * value reaches the stage, so `ctx.step.run(...)` returns what it stored
   * either way. Set to `Number.POSITIVE_INFINITY` to keep every result
   * inline; already-spilled results still resolve on read.
   *
   * Job payloads use the same mechanism but are opt-in at wiring time,
   * because the transport is shared with the host: see
   * `createSpillingJobTransport`.
   */
  spillThresholdBytes?: number;
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
  /**
   * The `(workflowId, version)` pairs this kernel's registry presents, or
   * `undefined` when the registry cannot enumerate (in which case nothing
   * is filtered, the pre-1.0 behaviour).
   *
   * Hosts read it to narrow their job dequeue the same way
   * `run.claimPending` narrows claiming, so the decision "can this process
   * do this work" is made once and applied in every query that takes work.
   */
  servedDefinitions(): readonly ServedDefinition[] | undefined;
}

// ============================================================================
// Shared dependency bundle passed to every handler
// ============================================================================

export interface KernelDeps {
  persistence: Persistence;
  blobStore: BlobStore;
  jobTransport: JobTransport;
  eventSink: EventSink;
  clock: Clock;
  registry: WorkflowRegistry;
  executor: ActivityExecutor;
  stepLedger?: StepLedger;
  services?: KernelServices;
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
  if (command.type === "run.redrive") return command.idempotencyKey;
  return undefined;
}

/** Union of every command's result type — `dispatchAny`'s return type. */
type AnyCommandResult =
  | RunCreateResult
  | RunClaimPendingResult
  | RunTransitionResult
  | RunCancelResult
  | RunRerunFromResult
  | RunRedriveResult
  | RunListVersionsResult
  | JobExecuteResult
  | JobHeartbeatResult
  | StagePollSuspendedResult
  | StepSignalResult
  | LeaseReapStaleResult
  | OutboxFlushResult
  | PluginReplayDLQResult
  | RunReapStuckResult
  | RunPurgeResult;

/** Strip the internal `_events`/`_postCommit` fields off a handler result. */
function stripEvents<R>(result: HandlerResult<R>): R {
  const { _events, _postCommit, ...rest } = result;
  return rest as R;
}

// ============================================================================
// Factory
// ============================================================================

export function createKernel(config: KernelConfig): Kernel {
  const { persistence, blobStore, jobTransport, eventSink, clock, registry } =
    config;

  // Default to LocalExecutor if none provided
  const executor = config.executor ?? createLocalExecutor();
  const idempotencyStaleInProgressMs =
    config.idempotencyStaleInProgressMs ??
    DEFAULT_IDEMPOTENCY_STALE_IN_PROGRESS_MS;
  const services = config.services
    ? {
        ...config.services,
        ...(config.services.aiLogger && !config.services.ai
          ? { ai: createAIHelper }
          : {}),
      }
    : undefined;

  // Durable step results are the largest thing the engine writes per row
  // and are read back in full on every replay, so the ledger is spilled
  // through the blob store above a soft threshold. The kernel owns every
  // read and write of this port, so wrapping it here is invisible to
  // callers — see kernel/spill.ts.
  const stepLedger = config.stepLedger
    ? withStepResultSpill(
        config.stepLedger,
        createPayloadSpill({
          blobStore,
          ...(config.spillThresholdBytes !== undefined
            ? { thresholdBytes: config.spillThresholdBytes }
            : {}),
        }),
      )
    : undefined;

  const deps: KernelDeps = {
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    clock,
    registry,
    executor,
    stepLedger,
    services,
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
    // job.heartbeat routes directly — a lease touch and two reads, no
    // outbox write, no idempotency, no transaction.
    // -----------------------------------------------------------------
    if (command.type === "job.heartbeat") {
      const result = await handleJobHeartbeat(command, deps);
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
          case "run.redrive":
            result = await handleRunRedrive(command, txDeps);
            break;
          case "run.listVersions":
            result = await handleRunListVersions(command, txDeps);
            break;
          case "step.signal":
            result = await handleStepSignal(command, txDeps);
            break;
          case "lease.reapStale":
            result = await handleLeaseReapStale(command, txDeps);
            break;
          case "run.reapStuck":
            result = await handleRunReapStuck(command, txDeps);
            break;
          case "run.purge":
            result = await handleRunPurge(command, txDeps);
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

  return {
    dispatch,
    annotations,
    servedDefinitions: () => servedDefinitions(config.registry),
  };
}
