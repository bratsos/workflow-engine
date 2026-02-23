/**
 * @bratsos/workflow-engine-host-node
 *
 * Node.js host for the workflow engine command kernel.
 * Provides process loops, signal handling, and job processing.
 */

export {
  createNodeHost,
  type NodeHost,
  type NodeHostConfig,
  type HostStats,
} from "./host.js";
