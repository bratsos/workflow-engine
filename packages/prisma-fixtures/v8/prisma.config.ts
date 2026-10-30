import { defineConfig } from "@prisma/orm-postgres/config";
import { definePrismaConfig } from "prisma/config";

// The contract is the engine's shipped reference. Everything the CLI writes
// (contract.json, the migration baseline and its refs) goes to .generated.
export default definePrismaConfig({
  orm: defineConfig({
    contract: "../../workflow-engine/prisma/contract.prisma",
    output: "./.generated",
    db: { connection: process.env.DATABASE_URL ?? "" },
    migrations: { dir: "./.generated/migrations" },
  }),
});
