const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { generateOnce } = require("../generate-once.cjs");
const schema = require("../schema.cjs");

// `max`: the most connections the client's pool opens (the suites' pool of one).
exports.createPostgresClient = (url, { max } = {}) => {
  const { PrismaClient } = require("@prisma/client");
  const { PrismaPg } = require("@prisma/adapter-pg");
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, ...(max ? { max } : {}) }),
  });
};

const versions = ["prisma", "@prisma/client"].map((name) => require(`${name}/package.json`).version);

// Generates a SQLite client once and creates every table in `file`, then connects.
exports.createSqliteClient = (file) => {
  const sqlite = schema.sqlite(__dirname, { withUrl: false });
  const url = `file:${file}`;
  const prisma = (...args) =>
    execFileSync(
      process.execPath,
      [require.resolve("prisma/build/index.js"), ...args, "--schema", sqlite],
      { cwd: __dirname, env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
    );
  generateOnce(join(__dirname, ".generated"), [readFileSync(sqlite, "utf8"), ...versions], () =>
    prisma("generate"),
  );
  // Prisma 7's db push no longer generates, so it cannot touch the shared client.
  prisma("db", "push");
  const { PrismaClient } = require(join(__dirname, ".generated/sqlite-client"));
  const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
};
