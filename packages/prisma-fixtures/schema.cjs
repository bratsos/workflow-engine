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

// SQLite has no native enums or PostgreSQL native types. Keep every shipped
// model so the same adapter suites can exercise the complete schema.
exports.sqlite = (dir, { withUrl }) => {
  const schema = shipped
    .replace(
      'generator client {\n  provider = "prisma-client-js"\n}',
      'generator client {\n  provider = "prisma-client-js"\n  output   = "./sqlite-client"\n}',
    )
    .replace('provider = "postgresql"', `provider = "sqlite"${withUrl ? urlLine : ""}`)
    .replace(/^enum Status \{[\s\S]*?^\}\n\n/m, "")
    .replace(/(\bstatus\s+)Status\s+@default\(PENDING\)/g, '$1String @default("PENDING")')
    .replace(
      /(\bconfig\s+Json)\s+@default\("\{\}"\)/,
      "$1 @default(dbgenerated(\"'{}'\"))",
    )
    .replace(/\s+@db\.Text/g, "");
  return write(
    dir,
    "sqlite.prisma",
    schema,
  );
};

if (require.main === module) {
  const [kind, flag] = process.argv.slice(2);
  exports[kind](process.cwd(), { withUrl: flag === "--url" });
}
