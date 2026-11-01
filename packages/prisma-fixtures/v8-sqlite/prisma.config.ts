import { defineConfig } from "@prisma/orm-sqlite/config";
import { definePrismaConfig } from "prisma/config";

export default definePrismaConfig({
  orm: defineConfig({
    contract: "../../workflow-engine/prisma/contract-sqlite.prisma",
    output: "./.generated",
    db: { connection: process.env.DATABASE_URL ?? "" },
    migrations: { dir: "./.generated/migrations" },
  }),
});
