const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");

// The raw Prisma 8 client for the reference contract that `pnpm run generate`
// emitted. The Postgres suites wrap it in `fromPrisma8` themselves, from the
// engine's source, which this CommonJS package cannot load.
// `max`: the most connections the client's pool opens (the suites' pool of
// one), through a `pg` pool of the runtime's own `pg`.
exports.createPostgresDb = (url, { max, statusEnumName = "Status" } = {}) => {
  const runtime = require.resolve("@prisma/orm-postgres/runtime");
  const postgres = require(runtime).default;
  const { contractFromJson } = require("@prisma/orm-postgres/static");
  const contract = contractFromJson(
    JSON.parse(
      readFileSync(join(__dirname, ".generated/contract.json"), "utf8")
        .replaceAll('"Status"', JSON.stringify(statusEnumName)),
    ),
  );
  if (max === undefined) return postgres({ contract, url });
  const { Pool } = createRequire(runtime)("pg");
  const pool = new Pool({ connectionString: url, max });
  const db = postgres({ contract, pg: pool });
  // The runtime leaves a pool it was given open: close ends it too.
  const close = db.close.bind(db);
  db.close = async () => {
    await close();
    await pool.end();
  };
  return db;
};

exports.createSqliteDb = (file) =>
  require("../v8-sqlite").createSqliteDb(file);

exports.openSqliteDb = (file) => require("../v8-sqlite").openSqliteDb(file);
