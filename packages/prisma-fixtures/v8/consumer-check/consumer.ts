// A Prisma 8 consumer, type-checked against the built packages the way an
// application sees them: package exports, `dist/*.d.ts`, no casts, a real
// `postgres({ contract: contractFromJson<Contract>(json), url })` client.
// Never run. `pnpm run check:consumer` needs `pnpm run generate` here and a
// build of @bratsos/workflow-engine and @bratsos/workflow-engine-console.
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import {
  createPrismaAICallLogger,
  createPrismaBlobStore,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "@bratsos/workflow-engine/persistence/prisma";
import { createPrismaConsoleReadPort } from "@bratsos/workflow-engine-console";
import contractJson from "../.generated/contract.json";
import type { Contract } from "../.generated/contract";

const db = postgres({
  contract: contractFromJson<Contract>(contractJson),
  url: "postgres://localhost/consumer",
});

// The root client.
const client = fromPrisma8(db);
createPrismaWorkflowPersistence(client);
await createPrismaJobQueue(client).enqueue({
  workflowRunId: "run",
  workflowId: "workflow",
  stageId: "stage",
});
createPrismaAICallLogger(client);
createPrismaStepLedger(client);
createPrismaBlobStore(client);
createPrismaConsoleReadPort(client);

// The `tx` of the consumer's own transaction: their writes and the engine's
// commit or roll back together.
await db.transaction(async (tx) => {
  const inTransaction = fromPrisma8(tx, { contract: db.contract });
  createPrismaWorkflowPersistence(inTransaction);
  createPrismaJobQueue(inTransaction);
  createPrismaAICallLogger(inTransaction);
  createPrismaStepLedger(inTransaction);
  createPrismaBlobStore(inTransaction);
  createPrismaConsoleReadPort(inTransaction);
  await tx.orm.public.WorkflowLog.create({ level: "INFO", message: "mine" });
});
