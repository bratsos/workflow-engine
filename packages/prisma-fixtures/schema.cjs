// Every fixture schema is derived from the engine's shipped schema, so no model
// is declared twice. Written to ./.generated under the calling fixture.
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const shipped = readFileSync(
  join(__dirname, "../workflow-engine/prisma/schema.prisma"),
  "utf8",
);
const urlLine = '\n  url      = env("DATABASE_URL")';

function write(dir, name, text) {
  mkdirSync(join(dir, ".generated"), { recursive: true });
  const file = join(dir, ".generated", name);
  writeFileSync(file, text);
  return file;
}

// Prisma 6 needs `url` in the datasource block; Prisma 7 and later reject it.
exports.postgres = (dir, { withUrl }) =>
  write(
    dir,
    "postgres.prisma",
    withUrl
      ? shipped.replace('provider = "postgresql"', `$&${urlLine}`)
      : shipped,
  );

// SQLite has no enums or native types, and only the definitions table is
// exercised there. It gets its own client so the Postgres one is untouched.
exports.sqlite = (dir, { withUrl }) => {
  const model = shipped.match(/^model WorkflowDefinition \{[\s\S]*?^\}/m)[0];
  return write(
    dir,
    "sqlite.prisma",
    `generator client {
  provider = "prisma-client-js"
  output   = "./sqlite-client"
}

datasource db {
  provider = "sqlite"${withUrl ? urlLine : ""}
}

${model}
`,
  );
};

if (require.main === module) {
  const [kind, flag] = process.argv.slice(2);
  exports[kind](process.cwd(), { withUrl: flag === "--url" });
}
