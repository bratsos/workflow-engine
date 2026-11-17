const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
execFileSync(
  "psql",
  [
    process.env.DATABASE_URL,
    "-v", "ON_ERROR_STOP=1",
    "--single-transaction",
    "-f", join(__dirname, "../workflow-engine/prisma/outbox-heads.postgresql.sql"),
  ],
  { stdio: "inherit" },
);
