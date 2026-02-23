/**
 * Kernel Factory
 *
 * Creates a Kernel instance with a typed `dispatch` method that routes
 * commands to their corresponding handlers. Events are written to a
 * transactional outbox (not emitted directly). Use the `outbox.flush`
 * command to publish pending outbox events through EventSink.
 *
 * Commands with idempotency keys are deduplicated: a replay returns the
 * cached result without re-executing the handler.
 */

import type { Workflow } from "../core/workflow";
import type { CreateOutboxEventInput } from "../persistence/interface";
import type {
  CommandResult,
  JobExecuteCommand,
  KernelCommand,
  LeaseReapStaleCommand,
  OutboxFlushCommand,
  PluginReplayDLQCommand,
  RunCancelCommand,
  RunClaimPendingCommand,
  RunCreateCommand,
  RunRerunFromCommand,
  RunTransitionCommand,
  StagePollSuspendedCommand,
} from "./commands";
import { IdempotencyInProgressError } from "./errors";
import type { KernelEvent } from "./events";
import { handleJobExecute } from "./handlers/job-execute";
import { handleLeaseReapStale } from "./handlers/lease-reap-stale";
import { handleOutboxFlush } from "./handlers/outbox-flush";
import { handlePluginReplayDLQ } from "./handlers/plugin-replay-dlq";
import { handleRunCancel } from "./handlers/run-cancel";
import { handleRunClaimPending } from "./handlers/run-claim-pending";
import { handleRunCreate } from "./handlers/run-create";
import { handleRunRerunFrom } from "./handlers/run-rerun-from";
import { handleRunTransition } from "./handlers/run-transition";
import { handleStagePollSuspended } from "./handlers/stage-poll-suspended";
import type {
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
  scheduler: Scheduler;
  clock: Clock;
  registry: WorkflowRegistry;
}

export interface Kernel {
  dispatch<T extends KernelCommand>(command: T): Promise<CommandResult<T>>;
}

// ============================================================================
// Shared dependency bundle passed to every handler
// ============================================================================

export interface KernelDeps {
  persistence: Persistence;
  blobStore: BlobStore;
  jobTransport: JobTransport;
  eventSink: EventSink;
  scheduler: Scheduler;
  clock: Clock;
  registry: WorkflowRegistry;
}

// ============================================================================
// Internal handler result type (includes _events for central emission)
// ============================================================================

export type HandlerResult<T> = T & { _events: KernelEvent[] };

// ============================================================================
// Helpers
// ============================================================================

/** Extract idempotency key from commands that carry one. */
function getIdempotencyKey(command: KernelCommand): string | undefined {
  if (command.type === "run.create") return command.idempotencyKey;
  if (command.type === "job.execute") return command.idempotencyKey;
  return undefined;
}

// ============================================================================
// Factory
// ============================================================================

export function createKernel(config: KernelConfig): Kernel {
  const {
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry,
  } = config;

  const deps: KernelDeps = {
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry,
  };

  async function dispatch<T extends KernelCommand>(
    command: T,
  ): Promise<CommandResult<T>> {
    // -----------------------------------------------------------------
    // outbox.flush routes directly — no outbox write, no idempotency
    // -----------------------------------------------------------------
    if (command.type === "outbox.flush") {
      const result = await handleOutboxFlush(
        command as OutboxFlushCommand,
        deps,
      );
      const { _events: _, ...publicResult } = result;
      return publicResult as CommandResult<T>;
    }

    // -----------------------------------------------------------------
    // plugin.replayDLQ routes directly — no outbox write, no idempotency
    // -----------------------------------------------------------------
    if (command.type === "plugin.replayDLQ") {
      const result = await handlePluginReplayDLQ(
        command as PluginReplayDLQCommand,
        deps,
      );
      const { _events: _, ...publicResult } = result;
      return publicResult as CommandResult<T>;
    }

    // -----------------------------------------------------------------
    // Idempotency acquisition
    // -----------------------------------------------------------------
    const idempotencyKey = getIdempotencyKey(command);
    let idempotencyAcquired = false;

    if (idempotencyKey) {
      const acquired = await persistence.acquireIdempotencyKey(
        idempotencyKey,
        command.type,
      );

      if (acquired.status === "replay") {
        return acquired.result as CommandResult<T>;
      }
      if (acquired.status === "in_progress") {
        throw new IdempotencyInProgressError(idempotencyKey, command.type);
      }
      idempotencyAcquired = true;
    }

    try {
      // ---------------------------------------------------------------
      // Route to handler + append outbox events in one transaction
      // ---------------------------------------------------------------
      const publicResult = await persistence.withTransaction(async (tx) => {
        const txDeps: KernelDeps = { ...deps, persistence: tx };
        let result: HandlerResult<any>;

        switch (command.type) {
          case "run.create":
            result = await handleRunCreate(command as RunCreateCommand, txDeps);
            break;
          case "run.claimPending":
            result = await handleRunClaimPending(
              command as RunClaimPendingCommand,
              txDeps,
            );
            break;
          case "run.transition":
            result = await handleRunTransition(
              command as RunTransitionCommand,
              txDeps,
            );
            break;
          case "run.cancel":
            result = await handleRunCancel(command as RunCancelCommand, txDeps);
            break;
          case "run.rerunFrom":
            result = await handleRunRerunFrom(
              command as RunRerunFromCommand,
              txDeps,
            );
            break;
          case "job.execute":
            result = await handleJobExecute(
              command as JobExecuteCommand,
              txDeps,
            );
            break;
          case "stage.pollSuspended":
            result = await handleStagePollSuspended(
              command as StagePollSuspendedCommand,
              txDeps,
            );
            break;
          case "lease.reapStale":
            result = await handleLeaseReapStale(
              command as LeaseReapStaleCommand,
              txDeps,
            );
            break;
          default: {
            const _exhaustive: never = command;
            throw new Error(
              `Unknown command type: ${(_exhaustive as KernelCommand).type}`,
            );
          }
        }

        const events = result._events as KernelEvent[];
        if (events.length > 0) {
          const causationId = idempotencyKey ?? crypto.randomUUID();
          const outboxEvents: CreateOutboxEventInput[] = events.map(
            (event) => ({
              workflowRunId: event.workflowRunId,
              eventType: event.type,
              payload: event,
              causationId,
              occurredAt: event.timestamp,
            }),
          );
          await tx.appendOutboxEvents(outboxEvents);
        }

        const { _events: _, ...stripped } = result;
        return stripped as CommandResult<T>;
      });

      if (idempotencyKey && idempotencyAcquired) {
        await persistence.completeIdempotencyKey(
          idempotencyKey,
          command.type,
          publicResult,
        );
      }

      return publicResult;
    } catch (error) {
      if (idempotencyKey && idempotencyAcquired) {
        await persistence
          .releaseIdempotencyKey(idempotencyKey, command.type)
          .catch(() => {});
      }
      throw error;
    }
  }

  return { dispatch };
}
