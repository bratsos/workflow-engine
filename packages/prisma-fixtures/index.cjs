// Loader for the Postgres and SQLite suites: exposes `createPostgresClient(url)`
// and `createSqliteClient(file)` for the Prisma major in PRISMA_MAJOR (default 7).
// Each major is the workspace package ./v<major>; add a new major as a new
// directory next to v6 and v7 and it is picked up here and by pnpm-workspace.yaml.
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const major = process.env.PRISMA_MAJOR || "7";
if (!/^\d+$/.test(major) || !existsSync(join(__dirname, `v${major}`))) {
  throw new Error(`PRISMA_MAJOR=${major} has no fixture in ${__dirname}`);
}

module.exports = require(`./v${major}`);
