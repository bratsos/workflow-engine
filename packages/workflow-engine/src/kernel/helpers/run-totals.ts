import type { KernelDeps } from "../kernel.js";

/**
 * Cost and tokens for the run row. The AI call logger is the ledger of every
 * model call made under `workflow.<runId>` (stages, `ctx.step.ai`, batches),
 * so its roll-up is authoritative when services are configured; the
 * per-stage `metrics` sum is the fallback for kernels without an
 * `aiLogger`. A logger failure never blocks the completion. Written on
 * COMPLETED and on FAILED runs alike, so a failed run's spend is queryable.
 */
export async function rollUpRunTotals(
  workflowRunId: string,
  stages: ReadonlyArray<{ metrics?: unknown }>,
  deps: KernelDeps,
): Promise<{ totalCost: number; totalTokens: number }> {
  const aiLogger = deps.services?.aiLogger;
  if (aiLogger) {
    try {
      const stats = await aiLogger.getStats(`workflow.${workflowRunId}`);
      return {
        totalCost: stats.totalCost,
        totalTokens: stats.totalInputTokens + stats.totalOutputTokens,
      };
    } catch {
      // fall through to the stage metrics
    }
  }
  let totalCost = 0;
  let totalTokens = 0;
  for (const stage of stages) {
    const metrics = stage.metrics as
      | { totalCost?: number; totalTokens?: number }
      | undefined;
    totalCost += metrics?.totalCost ?? 0;
    totalTokens += metrics?.totalTokens ?? 0;
  }
  return { totalCost, totalTokens };
}
