/**
 * Handler: stage.pollSuspended
 *
 * Polls suspended stages whose nextPollAt has passed, calls each stage's
 * checkCompletion() method, and either resumes (completes) or re-schedules
 * them for a future poll.
 *
 * Uses a multi-phase pattern per stage so that checkCompletion() — which
 * typically makes external HTTP calls to batch providers — runs outside
 * any database transaction:
 *
 *   Phase 1 (no transaction): Call checkCompletion() — external I/O
 *   Phase 2 (transaction):    Persist results + append outbox events
 *
 * This avoids Prisma P2028 interactive-transaction timeout errors when
 * batch provider APIs are slow to respond.
 */

import {
  type CreateOutboxEventInput,
  StaleVersionError,
} from "../../persistence/interface";
import type {
  StagePollSuspendedCommand,
  StagePollSuspendedResult,
} from "../commands";
import type { KernelEvent } from "../events";
import { createStorageShim, saveStageOutput } from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";

// ---------------------------------------------------------------------------
// Helper: build outbox event inputs from kernel events
// ---------------------------------------------------------------------------

function toOutboxEvents(
  workflowRunId: string,
  events: KernelEvent[],
): CreateOutboxEventInput[] {
  const causationId = crypto.randomUUID();
  return events.map((event) => ({
    workflowRunId,
    eventType: event.type,
    payload: event,
    causationId,
    occurredAt: event.timestamp,
  }));
}

async function markStageCancelled(
  stageId: string,
  deps: KernelDeps,
): Promise<void> {
  await deps.persistence.updateStage(stageId, {
    status: "CANCELLED",
    completedAt: deps.clock.now(),
    nextPollAt: null,
  });
}

async function withClaimedRun<T>(
  workflowRunId: string,
  expectedVersion: number,
  deps: KernelDeps,
  fn: (tx: KernelDeps["persistence"]) => Promise<T>,
): Promise<{ status: "claimed"; value: T } | { status: "stale" }> {
  try {
    const value = await deps.persistence.withTransaction(async (tx) => {
      await tx.updateRun(workflowRunId, {
        expectedVersion,
      });
      return fn(tx);
    });
    return { status: "claimed", value };
  } catch (error) {
    if (error instanceof StaleVersionError) {
      return { status: "stale" };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleStagePollSuspended(
  command: StagePollSuspendedCommand,
  deps: KernelDeps,
): Promise<HandlerResult<StagePollSuspendedResult>> {
  const maxChecks = command.maxChecks ?? 50;

  // 1. Get suspended stages that are ready to be polled (no transaction)
  const suspendedStages = await deps.persistence.getSuspendedStages(
    deps.clock.now(),
  );

  // 2. Limit to maxChecks
  const stagesToCheck = suspendedStages.slice(0, maxChecks);

  let checked = 0;
  let resumed = 0;
  let failed = 0;
  const resumedWorkflowRunIds = new Set<string>();

  // 3. Process each suspended stage
  for (const stageRecord of stagesToCheck) {
    checked++;

    // 3a. Get workflow run (no transaction — read-only lookup)
    const run = await deps.persistence.getRun(stageRecord.workflowRunId);
    if (!run) continue;

    // 3a.1 Skip cancelled runs — mark the suspended stage as cancelled
    if (run.status === "CANCELLED") {
      await markStageCancelled(stageRecord.id, deps);
      continue;
    }

    // 3b. Get workflow from registry
    const workflow = deps.registry.getWorkflow(run.workflowId);
    if (!workflow) {
      await deps.persistence.withTransaction(async (tx) => {
        await tx.updateStage(stageRecord.id, {
          status: "FAILED",
          completedAt: deps.clock.now(),
          errorMessage: `Workflow ${run.workflowId} not found in registry`,
        });
        await tx.appendOutboxEvents(
          toOutboxEvents(stageRecord.workflowRunId, [
            {
              type: "stage:failed",
              timestamp: deps.clock.now(),
              workflowRunId: stageRecord.workflowRunId,
              stageId: stageRecord.stageId,
              stageName: stageRecord.stageName,
              error: `Workflow ${run.workflowId} not found in registry`,
            },
          ]),
        );
      });
      failed++;
      continue;
    }

    // 3c. Get stage definition
    const stageDef = workflow.getStage(stageRecord.stageId);
    if (!stageDef || !stageDef.checkCompletion) {
      const errorMsg = !stageDef
        ? `Stage ${stageRecord.stageId} not found in workflow ${run.workflowId}`
        : `Stage ${stageRecord.stageId} does not support checkCompletion`;

      await deps.persistence.withTransaction(async (tx) => {
        await tx.updateStage(stageRecord.id, {
          status: "FAILED",
          completedAt: deps.clock.now(),
          errorMessage: errorMsg,
        });
        await tx.appendOutboxEvents(
          toOutboxEvents(stageRecord.workflowRunId, [
            {
              type: "stage:failed",
              timestamp: deps.clock.now(),
              workflowRunId: stageRecord.workflowRunId,
              stageId: stageRecord.stageId,
              stageName: stageRecord.stageName,
              error: errorMsg,
            },
          ]),
        );
      });
      failed++;
      continue;
    }

    // 3d. Create storage shim and log function (uses non-transactional deps)
    const storage = createStorageShim(
      stageRecord.workflowRunId,
      run.workflowType,
      deps,
    );

    const logFn = async (
      level: any,
      message: string,
      meta?: Record<string, unknown>,
    ) => {
      await deps.persistence
        .createLog({
          workflowRunId: stageRecord.workflowRunId,
          workflowStageId: stageRecord.id,
          level: level as any,
          message,
          metadata: meta,
        })
        .catch(() => {});
    };

    // 3e. Build check context
    const checkContext = {
      workflowRunId: run.id,
      stageId: stageRecord.stageId,
      stageRecordId: stageRecord.id,
      config: stageRecord.config || {},
      log: logFn,
      onLog: logFn,
      storage,
    };

    try {
      // ── Phase 1: checkCompletion (no transaction) ──────────────────
      // External HTTP calls happen here — no DB connection held open.
      const checkResult = await stageDef.checkCompletion(
        stageRecord.suspendedState as any,
        checkContext,
      );

      // ── Phase 2: persist results (transaction) ─────────────────────
      if (checkResult.error) {
        const claimResult = await withClaimedRun(
          stageRecord.workflowRunId,
          run.version,
          deps,
          async (tx) => {
            await tx.updateStage(stageRecord.id, {
              status: "FAILED",
              completedAt: deps.clock.now(),
              errorMessage: checkResult.error,
              nextPollAt: null,
            });

            await tx.updateRun(stageRecord.workflowRunId, {
              status: "FAILED",
              completedAt: deps.clock.now(),
            });

            await tx.appendOutboxEvents(
              toOutboxEvents(stageRecord.workflowRunId, [
                {
                  type: "stage:failed",
                  timestamp: deps.clock.now(),
                  workflowRunId: stageRecord.workflowRunId,
                  stageId: stageRecord.stageId,
                  stageName: stageRecord.stageName,
                  error: checkResult.error!,
                },
                {
                  type: "workflow:failed",
                  timestamp: deps.clock.now(),
                  workflowRunId: stageRecord.workflowRunId,
                  error: checkResult.error!,
                },
              ]),
            );
          },
        );

        if (claimResult.status === "stale") {
          const latestStatus = await deps.persistence.getRunStatus(
            stageRecord.workflowRunId,
          );
          if (latestStatus === "CANCELLED") {
            await markStageCancelled(stageRecord.id, deps);
          }
          continue;
        }

        failed++;
      } else if (checkResult.ready) {
        // Save output to blob store (not a DB operation)
        let outputRef: { _artifactKey: string } | undefined;
        if (checkResult.output !== undefined) {
          let validatedOutput = checkResult.output;
          try {
            validatedOutput = stageDef.outputSchema.parse(checkResult.output);
          } catch {
            // Fall back to raw output on validation failure
          }

          const outputKey = await saveStageOutput(
            stageRecord.workflowRunId,
            run.workflowType,
            stageRecord.stageId,
            validatedOutput,
            deps,
          );
          outputRef = { _artifactKey: outputKey };
        }

        const duration =
          deps.clock.now().getTime() -
          (stageRecord.startedAt?.getTime() ?? deps.clock.now().getTime());

        const claimResult = await withClaimedRun(
          stageRecord.workflowRunId,
          run.version,
          deps,
          async (tx) => {
            await tx.updateStage(stageRecord.id, {
              status: "COMPLETED",
              completedAt: deps.clock.now(),
              duration,
              outputData: outputRef as any,
              nextPollAt: null,
              metrics: checkResult.metrics as any,
              embeddingInfo: checkResult.embeddings as any,
            });

            await tx.appendOutboxEvents(
              toOutboxEvents(stageRecord.workflowRunId, [
                {
                  type: "stage:completed",
                  timestamp: deps.clock.now(),
                  workflowRunId: stageRecord.workflowRunId,
                  stageId: stageRecord.stageId,
                  stageName: stageRecord.stageName,
                  duration,
                },
              ]),
            );
          },
        );

        if (claimResult.status === "stale") {
          const latestStatus = await deps.persistence.getRunStatus(
            stageRecord.workflowRunId,
          );
          if (latestStatus === "CANCELLED") {
            await markStageCancelled(stageRecord.id, deps);
          }
          continue;
        }

        resumed++;
        resumedWorkflowRunIds.add(stageRecord.workflowRunId);
      } else {
        // Not ready -- update nextPollAt for next check
        const pollInterval =
          checkResult.nextCheckIn ?? stageRecord.pollInterval ?? 60000;

        const nextPollAt = new Date(deps.clock.now().getTime() + pollInterval);

        const claimResult = await withClaimedRun(
          stageRecord.workflowRunId,
          run.version,
          deps,
          async (tx) => {
            await tx.updateStage(stageRecord.id, {
              nextPollAt,
            });
          },
        );

        if (claimResult.status === "stale") {
          const latestStatus = await deps.persistence.getRunStatus(
            stageRecord.workflowRunId,
          );
          if (latestStatus === "CANCELLED") {
            await markStageCancelled(stageRecord.id, deps);
          }
          continue;
        }
      }
    } catch (error) {
      // Unexpected error during checkCompletion
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const claimResult = await withClaimedRun(
        stageRecord.workflowRunId,
        run.version,
        deps,
        async (tx) => {
          await tx.updateStage(stageRecord.id, {
            status: "FAILED",
            completedAt: deps.clock.now(),
            errorMessage,
            nextPollAt: null,
          });

          await tx.updateRun(stageRecord.workflowRunId, {
            status: "FAILED",
            completedAt: deps.clock.now(),
          });

          await tx.appendOutboxEvents(
            toOutboxEvents(stageRecord.workflowRunId, [
              {
                type: "stage:failed",
                timestamp: deps.clock.now(),
                workflowRunId: stageRecord.workflowRunId,
                stageId: stageRecord.stageId,
                stageName: stageRecord.stageName,
                error: errorMessage,
              },
              {
                type: "workflow:failed",
                timestamp: deps.clock.now(),
                workflowRunId: stageRecord.workflowRunId,
                error: errorMessage,
              },
            ]),
          );
        },
      );

      if (claimResult.status === "stale") {
        const latestStatus = await deps.persistence.getRunStatus(
          stageRecord.workflowRunId,
        );
        if (latestStatus === "CANCELLED") {
          await markStageCancelled(stageRecord.id, deps);
        }
        continue;
      }

      failed++;
    }
  }

  // Events are written directly to outbox per-stage above, so _events is empty
  return {
    checked,
    resumed,
    failed,
    resumedWorkflowRunIds: [...resumedWorkflowRunIds],
    _events: [],
  };
}
