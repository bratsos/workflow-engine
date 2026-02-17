/**
 * Handler: plugin.replayDLQ
 *
 * Resets DLQ outbox events (dlqAt and retryCount) so they are
 * picked up by the next outbox.flush invocation.
 *
 * This handler returns _events: [] — it does NOT produce new outbox events.
 */

import type { PluginReplayDLQCommand, PluginReplayDLQResult } from "../commands";
import type { KernelDeps, HandlerResult } from "../kernel";

export async function handlePluginReplayDLQ(
  command: PluginReplayDLQCommand,
  deps: KernelDeps,
): Promise<HandlerResult<PluginReplayDLQResult>> {
  const maxEvents = command.maxEvents ?? 100;
  const replayed = await deps.persistence.replayDLQEvents(maxEvents);
  return { replayed, _events: [] };
}
