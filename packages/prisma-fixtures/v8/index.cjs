const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// The raw Prisma 8 client for the reference contract that `pnpm run generate`
// emitted. The Postgres suites wrap it in `fromPrisma8` (a later change).
exports.createPostgresDb = (url) => {
  const postgres = require("@prisma/orm-postgres/runtime").default;
  const { contractFromJson } = require("@prisma/orm-postgres/static");
  const contract = contractFromJson(
    JSON.parse(readFileSync(join(__dirname, ".generated/contract.json"), "utf8")),
  );
  return postgres({ contract, url });
};
