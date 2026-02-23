/**
 * @bratsos/workflow-engine-host-serverless
 *
 * Platform-agnostic serverless host for the workflow engine command kernel.
 * Works with Cloudflare Workers, AWS Lambda, Vercel Edge, Deno Deploy, etc.
 */

export {
  createServerlessHost,
  type JobMessage,
  type JobResult,
  type MaintenanceTickResult,
  type ProcessJobsResult,
  type ServerlessHost,
  type ServerlessHostConfig,
} from "./host.js";
