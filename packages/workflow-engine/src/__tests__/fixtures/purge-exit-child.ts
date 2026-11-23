import { createRequire } from "node:module";
import { createKernel } from "../../kernel/kernel.js";
import { CollectingEventSink } from "../../kernel/testing/index.js";
import {
  createPrismaAICallLogger,
  createPrismaBlobStore,
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "../../persistence/prisma/index.js";
import { createPostgresClient } from "../utils/postgres-client.js";

async function main() {
  const [, , id, file] = process.argv;
  const fixtures = createRequire(import.meta.url)(
    "../../../../prisma-fixtures/index.cjs",
  );
  const client = file
    ? process.env.PRISMA_MAJOR === "8"
      ? fromPrisma8(await fixtures.openSqliteDb(file))
      : fixtures.openSqliteClient(file)
    : createPostgresClient(process.env.DATABASE_URL!);
  const options = {
    databaseType: file ? ("sqlite" as const) : ("postgresql" as const),
  };
  const jobs = createPrismaJobQueue(client, options);
  const deleteForRun = jobs.deleteForRun!.bind(jobs);
  jobs.deleteForRun = async (workflowRunId) => {
    await deleteForRun(workflowRunId);
    process.exit(77);
  };
  const kernel = createKernel({
    persistence: createPrismaWorkflowPersistence(client, options),
    blobStore: createPrismaBlobStore(client, options),
    jobTransport: jobs,
    services: { aiLogger: createPrismaAICallLogger(client, options) },
    clock: { now: () => new Date() },
    registry: { getWorkflow: () => undefined },
    eventSink: new CollectingEventSink(),
  });
  await kernel.dispatch({ type: "run.purge", workflowRunIds: [id!] });
  process.exit(1);
}

void main();
