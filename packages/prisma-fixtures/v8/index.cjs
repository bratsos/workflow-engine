const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");
const { generateOnce } = require("../generate-once.cjs");

function contractPath(statusEnumName) {
  const generated = join(__dirname, ".generated");
  if (statusEnumName === "Status") return join(generated, "contract.json");
  if (!/^[A-Za-z_]\w*$/.test(statusEnumName)) {
    throw new Error("Expected a plain status enum identifier");
  }
  const dir = join(generated, `enum-${statusEnumName}`);
  const source = join(dir, "contract.prisma");
  const contract = readFileSync(join(__dirname, "../../workflow-engine/prisma/contract.prisma"), "utf8")
    .replace(/^native_enum Status(?=\s*\{)/m, `native_enum ${statusEnumName}`)
    .replace(/^([ \t]*\w+[ \t]+)pg\.enum\(Status\)/gm, `$1pg.enum(${statusEnumName})`);
  const versions = ["prisma", "@prisma/orm-postgres"].map((name) => require(`${name}/package.json`).version);
  generateOnce(dir, [contract, readFileSync(join(__dirname, "prisma.config.ts"), "utf8"), ...versions], () => {
    writeFileSync(source, contract);
    execFileSync(process.execPath, [
      join(dirname(require.resolve("prisma/package.json")), "dist/prisma.js"),
      "contract", "emit", "--output-path", dir,
    ], {
      cwd: __dirname,
      env: { ...process.env, PRISMA_FIXTURE_CONTRACT: source },
      stdio: "pipe",
    });
  });
  return join(dir, "contract.json");
}

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
    JSON.parse(readFileSync(contractPath(statusEnumName), "utf8")),
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
