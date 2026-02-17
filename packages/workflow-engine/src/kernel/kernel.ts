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

import { randomUUID } from "node:crypto";
import type { Workflow } from "../core/workflow";
import type {
  KernelCommand,
  CommandResult,
  RunCreateCommand,
  RunClaimPendingCommand,
  RunTransitionCommand,
  RunCancelCommand,
  JobExecuteCommand,
  StagePollSuspendedCommand,
  LeaseReapStaleCommand,
  OutboxFlushCommand,
  PluginReplayDLQCommand,
} from "./commands";
import type {
  Persistence,
  BlobStore,
  JobTransport,
  EventSink,
  Scheduler,
  Clock,
} from "./ports";
import type { CreateOutboxEventInput } from "../persistence/interface";
import type { KernelEvent } from "./events";
import { handleRunCreate } from "./handlers/run-create";
import { handleRunClaimPending } from "./handlers/run-claim-pending";
import { handleRunTransition } from "./handlers/run-transition";
import { handleRunCancel } from "./handlers/run-cancel";
import { handleJobExecute } from "./handlers/job-execute";
import { handleStagePollSuspended } from "./handlers/stage-poll-suspended";
import { handleLeaseReapStale } from "./handlers/lease-reap-stale";
import { handleOutboxFlush } from "./handlers/outbox-flush";
import { handlePluginReplayDLQ } from "./handlers/plugin-replay-dlq";

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
    // Idempotency check
    // -----------------------------------------------------------------
    const idempotencyKey = getIdempotencyKey(command);
    if (idempotencyKey) {
      const cached = await persistence.checkIdempotencyKey(
        idempotencyKey,
        command.type,
      );
      if (cached.exists) {
        return cached.result as CommandResult<T>;
      }
    }

    // -----------------------------------------------------------------
    // Route to handler
    // -----------------------------------------------------------------
    let result: HandlerResult<any>;

    switch (command.type) {
      case "run.create":
        result = await handleRunCreate(command as RunCreateCommand, deps);
        break;
      case "run.claimPending":
        result = await handleRunClaimPending(
          command as RunClaimPendingCommand,
          deps,
        );
        break;
      case "run.transition":
        result = await handleRunTransition(
          command as RunTransitionCommand,
          deps,
        );
        break;
      case "run.cancel":
        result = await handleRunCancel(command as RunCancelCommand, deps);
        break;
      case "job.execute":
        result = await handleJobExecute(command as JobExecuteCommand, deps);
        break;
      case "stage.pollSuspended":
        result = await handleStagePollSuspended(
          command as StagePollSuspendedCommand,
          deps,
        );
        break;
      case "lease.reapStale":
        result = await handleLeaseReapStale(
          command as LeaseReapStaleCommand,
          deps,
        );
        break;
      default: {
        const _exhaustive: never = command;
        throw new Error(
          `Unknown command type: ${(_exhaustive as KernelCommand).type}`,
        );
      }
    }

    // -----------------------------------------------------------------
    // Write events to transactional outbox
    // -----------------------------------------------------------------
    const events = result._events as KernelEvent[];
    if (events.length > 0) {
      const causationId = idempotencyKey ?? randomUUID();
      const outboxEvents: CreateOutboxEventInput[] = events.map((event) => ({
        workflowRunId: event.workflowRunId,
        eventType: event.type,
        payload: event,
        causationId,
        occurredAt: event.timestamp,
      }));
      await persistence.appendOutboxEvents(outboxEvents);
    }

    // -----------------------------------------------------------------
    // Strip _events and cache result
    // -----------------------------------------------------------------
    const { _events: _, ...publicResult } = result;

    if (idempotencyKey) {
      await persistence.setIdempotencyKey(
        idempotencyKey,
        command.type,
        publicResult,
      );
    }

    return publicResult as CommandResult<T>;
  }

  return { dispatch };
}
