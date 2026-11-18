const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { generateOnce } = require("../generate-once.cjs");
const schema = require("../schema.cjs");

// `options` are extra PrismaClient options, e.g. `log` to record the SQL.
exports.createPostgresClient = (url, options = {}) => {
  const { PrismaClient } = require("@prisma/client");
  return new PrismaClient({ datasourceUrl: url, ...options });
};

const versions = ["prisma", "@prisma/client"].map((name) => require(`${name}/package.json`).version);

// Generates a SQLite client once and creates every table in `file`, then connects.
exports.createSqliteClient = (file, options = {}) => {
  const sqlite = schema.sqlite(__dirname, { withUrl: true });
  const url = `file:${file}?connection_limit=1`;
  const prisma = (...args) =>
    execFileSync(
      process.execPath,
      [require.resolve("prisma/build/index.js"), ...args, "--schema", sqlite],
      { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
    );
  generateOnce(join(__dirname, ".generated"), [readFileSync(sqlite, "utf8"), ...versions], () =>
    prisma("generate"),
  );
  prisma("db", "push", "--skip-generate");
  const { PrismaClient } = require(join(__dirname, ".generated/sqlite-client"));
  return new PrismaClient({ datasourceUrl: url, ...options });
};
