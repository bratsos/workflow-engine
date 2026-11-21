const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");
const { generateOnce, withLock } = require("../generate-once.cjs");

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
  const generated = join(__dirname, ".generated");
  generateOnce(
    generated,
    [
      readFileSync(join(__dirname, "../../workflow-engine/prisma/contract-sqlite.prisma"), "utf8"),
      readFileSync(join(__dirname, "prisma.config.ts"), "utf8"),
      ...["prisma", "@prisma/orm-sqlite"].map((name) => moduleRequire(`${name}/package.json`).version),
    ],
    () => run("contract", "emit"),
  );
  // db init also writes the shared migrations baseline, so it takes the same lock.
  withLock(generated, () => run("db", "init"));

  const contract = contractFromJson(
    JSON.parse(
      readFileSync(join(__dirname, ".generated/contract.json"), "utf8"),
    ),
  );
  return sqlite({ contract, path: file });
};

// Opens a file that already holds tables, without `db init`: for a file this
// contract did not create (the date-storage guard's tests hand-build one whose
// dates are integers, as a Prisma 6 file's are).
exports.openSqliteDb = (file) => {
  execFileSync(process.execPath, [prismaBin, "contract", "emit"], {
    cwd: __dirname,
    env: { ...process.env, DATABASE_URL: `file:${file}` },
    stdio: "pipe",
  });
  const contract = contractFromJson(
    JSON.parse(
      readFileSync(join(__dirname, ".generated/contract.json"), "utf8"),
    ),
  );
  return sqlite({ contract, path: file });
};
