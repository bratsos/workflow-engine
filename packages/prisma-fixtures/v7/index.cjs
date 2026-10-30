const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const schema = require("../schema.cjs");

exports.createPostgresClient = (url) => {
  const { PrismaClient } = require("@prisma/client");
  const { PrismaPg } = require("@prisma/adapter-pg");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
};

// Generates a SQLite client and creates the table in `file`, then connects.
exports.createSqliteClient = (file) => {
  const sqlite = schema.sqlite(__dirname, { withUrl: false });
  const url = `file:${file}`;
  const prisma = (...args) =>
    execFileSync(
      process.execPath,
      [require.resolve("prisma/build/index.js"), ...args, "--schema", sqlite],
      { cwd: __dirname, env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
    );
  prisma("generate");
  prisma("db", "push");
  const { PrismaClient } = require(join(__dirname, ".generated/sqlite-client"));
  const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
};
