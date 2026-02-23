/**
 * Handler: run.create
 *
 * Creates a new workflow run record after validating input and config.
 */

import type { RunCreateCommand, RunCreateResult } from "../commands";
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
    ],
  };
}
