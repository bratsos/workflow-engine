const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const schema = require("../schema.cjs");

exports.createPostgresClient = (url) => {
  const { PrismaClient } = require("@prisma/client");
  return new PrismaClient({ datasourceUrl: url });
};

// Generates a SQLite client and creates every table in `file`, then connects.
exports.createSqliteClient = (file) => {
  const sqlite = schema.sqlite(__dirname, { withUrl: true });
  const url = `file:${file}?connection_limit=1`;
  const prisma = (...args) =>
    execFileSync(
      process.execPath,
      [require.resolve("prisma/build/index.js"), ...args, "--schema", sqlite],
      { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
    );
  prisma("generate");
  prisma("db", "push", "--skip-generate");
  const { PrismaClient } = require(join(__dirname, ".generated/sqlite-client"));
  return new PrismaClient({ datasourceUrl: url });
};
