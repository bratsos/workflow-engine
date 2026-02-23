/**
 * @bratsos/workflow-engine-host-serverless
 *
 * Platform-agnostic serverless host for the workflow engine command kernel.
 * Works with Cloudflare Workers, AWS Lambda, Vercel Edge, Deno Deploy, etc.
 */

export {
  createServerlessHost,
  type ServerlessHost,
  type ServerlessHostConfig,
  type JobMessage,
  type JobResult,
  type ProcessJobsResult,
  type MaintenanceTickResult,
} from "./host.js";
