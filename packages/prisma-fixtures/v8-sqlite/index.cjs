const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");

const moduleRequire = createRequire(__filename);
const sqlite = moduleRequire("@prisma/orm-sqlite/runtime").default;
const { contractFromJson } = moduleRequire("@prisma/orm-sqlite/static");
const prismaBin = join(
  dirname(moduleRequire.resolve("prisma/package.json")),
  "dist/prisma.js",
);

exports.createSqliteDb = (file) => {
  const run = (...args) =>
    execFileSync(process.execPath, [prismaBin, ...args], {
      cwd: __dirname,
      env: { ...process.env, DATABASE_URL: `file:${file}` },
      stdio: "pipe",
    });

  mkdirSync(dirname(file), { recursive: true });
  run("contract", "emit");
  run("db", "init");

  const contract = contractFromJson(
    JSON.parse(
      readFileSync(join(__dirname, ".generated/contract.json"), "utf8"),
    ),
  );
  return sqlite({ contract, path: file });
};
