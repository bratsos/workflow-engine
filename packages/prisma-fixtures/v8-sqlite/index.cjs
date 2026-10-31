const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleRequire = createRequire(__filename);
const prismaBin = join(
  dirname(moduleRequire.resolve("prisma/package.json")),
  "dist/prisma.js",
);

exports.createSqliteDb = async (file) => {
  const run = (...args) =>
    execFileSync(process.execPath, [prismaBin, ...args], {
      cwd: __dirname,
      env: { ...process.env, DATABASE_URL: `file:${file}` },
      stdio: "pipe",
    });

  mkdirSync(dirname(file), { recursive: true });
  run("contract", "emit");
  run("db", "init");

  const sqlite = (
    await import(
      pathToFileURL(
        join(__dirname, "node_modules/@prisma/orm-sqlite/dist/runtime.mjs"),
      ).href
    )
  ).default;
  const contract = JSON.parse(
    readFileSync(join(__dirname, ".generated/contract.json"), "utf8"),
  );
  return sqlite({ contract, path: file });
};
