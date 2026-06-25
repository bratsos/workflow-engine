/**
 * Remote activity worker — standalone entrypoint.
 *
 * Run by orchestrator.ts via child_process.spawn; can also be started manually:
 *   tsx examples/cross-process/worker.ts <brokerBaseUrl> <authToken> [workerId]
 *
 * Reads broker URL and auth token from argv (argv[2], argv[3]) or from the
 * environment variables BROKER_URL / BROKER_AUTH_TOKEN. Connects to the broker
 * over HTTP, leases tasks for the "heavy" stage, runs them, and reports results.
 */

import { createActivityWorker } from "../../src/worker/worker.js";
import { createHttpWorkerTransport } from "../../src/transport/http/worker-client.js";
import { heavyStage } from "./shared-stages.js";

const baseUrl = process.argv[2] ?? process.env["BROKER_URL"] ?? "";
const authToken = process.argv[3] ?? process.env["BROKER_AUTH_TOKEN"];
const workerId = process.argv[4] ?? `worker-${process.pid}`;

if (!baseUrl) {
  console.error("[worker] Usage: tsx worker.ts <brokerBaseUrl> [authToken] [workerId]");
  process.exit(1);
}

console.log(`[worker:${workerId}] Starting — broker=${baseUrl}`);

const transport = createHttpWorkerTransport({ baseUrl, authToken });

const worker = createActivityWorker({
  registry: new Map([["heavy", heavyStage]]),
  transport,
  workerId,
  stageIds: ["heavy"],
  stageCodeVersion: "v1",
  idleDelayMs: 100,
});

worker.start();

// Graceful shutdown on SIGTERM (sent by orchestrator when it's done).
process.on("SIGTERM", () => {
  console.log(`[worker:${workerId}] SIGTERM received — stopping`);
  worker.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  worker.stop();
  process.exit(0);
});
