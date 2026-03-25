/**
 * @bratsos/workflow-engine-host-node
 *
 * Node.js host for the workflow engine command kernel.
 * Provides process loops, signal handling, and job processing.
 */

export {
  createNodeHost,
  type HostStats,
  type NodeHost,
  type NodeHostConfig,
} from "./host.js";

export {
  runAndWait,
  type RunAndWaitOptions,
  type RunAndWaitResult,
  type RunAndWaitPersistence,
  type StageStatus,
} from "./run-and-wait.js";
