/**
 * Handler: run.create
 *
 * Creates a new workflow run record after validating input and config.
 * Run-creation annotations (if provided) are written in the same
 * transaction.
 */

import type { CreateAnnotationInput } from "../../persistence/interface";
import type { RunCreateCommand, RunCreateResult } from "../commands";
import type { KernelEvent } from "../events";
import { buildAnnotationEvents } from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";

export async function handleRunCreate(
  command: RunCreateCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunCreateResult>> {
  // 1. Get workflow from registry
  const workflow = deps.registry.getWorkflow(command.workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${command.workflowId} not found in registry`);
  }

  // 2. Validate input against workflow's input schema
  try {
    workflow.inputSchema.parse(command.input);
  } catch (error) {
    throw new Error(`Invalid workflow input: ${error}`);
  }

  // 3. Get default config and merge with provided config
  const defaultConfig = workflow.getDefaultConfig?.() ?? {};
  const mergedConfig = { ...defaultConfig, ...command.config };

  // 4. Validate merged config
  const configValidation = workflow.validateConfig(mergedConfig);
  if (!configValidation.valid) {
    const errors = configValidation.errors
      .map((e) => `${e.stageId}: ${e.error}`)
      .join(", ");
    throw new Error(`Invalid workflow config: ${errors}`);
  }

  // 5. Calculate priority
  const priority = command.priority ?? 5;

  // 6. Create the run record
  const run = await deps.persistence.createRun({
    workflowId: command.workflowId,
    workflowName: workflow.name,
    workflowType: command.workflowId,
    input: command.input,
    config: mergedConfig,
    priority,
    metadata: command.metadata,
  });

  // 7. Attach run-creation annotations, if any (atomic with createRun
  //    since this handler runs inside kernel.dispatch's withTransaction).
  const annotationEvents: KernelEvent[] = [];
  if (command.annotations && command.annotations.length > 0) {
    const annotationInputs: CreateAnnotationInput[] = [];
    for (const entry of command.annotations) {
      for (const [key, value] of Object.entries(entry.attributes)) {
        // Skip undefined and null values (OTel pattern; Prisma requires
        // explicit Prisma.JsonNull for JSON null and we don't want to
        // leak that into the public API).
        if (value === undefined || value === null) continue;
        annotationInputs.push({
          workflowRunId: run.id,
          scope: "run",
          actor: entry.actor,
          key,
          value,
          payload: entry.payload,
          idempotencyKey: entry.idempotencyKey,
          emitEvent: entry.emitEvent,
        });
      }
    }
    if (annotationInputs.length > 0) {
      await deps.persistence.appendAnnotations(annotationInputs);
      annotationEvents.push(
        ...buildAnnotationEvents(annotationInputs, deps.clock.now()),
      );
    }
  }

  return {
    workflowRunId: run.id,
    status: "PENDING" as const,
    _events: [
      {
        type: "workflow:created",
        timestamp: deps.clock.now(),
        workflowRunId: run.id,
        workflowId: command.workflowId,
      },
      ...annotationEvents,
    ],
  };
}
