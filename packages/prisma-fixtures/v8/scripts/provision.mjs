// Provisions DATABASE_URL from the reference contract with Prisma 8 tooling
// only: emit, plan a baseline from the empty database, give the mixed-order
// indexes their sort direction, and migrate. The contract cannot express a sort
// direction, so the baseline's createIndex calls are edited, as
// workflow-engine/prisma/mixed-order-indexes.sql describes.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prismaBin = join(
  dirname(createRequire(import.meta.url).resolve("prisma/package.json")),
  "dist/prisma.js",
);
const run = (file, ...args) =>
  execFileSync(process.execPath, [file, ...args], { cwd: root, stdio: "inherit" });
const prisma = (...args) => run(prismaBin, ...args);

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

const migrations = join(root, ".generated/migrations");
rmSync(migrations, { recursive: true, force: true });
prisma("contract", "emit");
prisma("migration", "plan", "--from", "@empty", "--name", "baseline");

const dir = join(migrations, "app", readdirSync(join(migrations, "app")).find((d) => d.endsWith("_baseline")));
const file = join(dir, "migration.ts");
const companion = readFileSync(
  join(root, "../../workflow-engine/prisma/mixed-order-indexes.sql"),
  "utf8",
);
let source = readFileSync(file, "utf8");
const indexes = [...companion.matchAll(/^CREATE INDEX "([^"]+)" ON "[^"]+" \((.+)\);$/gm)];
if (indexes.length === 0) throw new Error("no CREATE INDEX statements in mixed-order-indexes.sql");
for (const [, name, elements] of indexes) {
  const columns = new RegExp(`(index: '${name}',\\n\\s*)columns: \\[[^\\]]*\\],`);
  if (!columns.test(source)) throw new Error(`baseline has no createIndex for ${name}`);
  source = source.replace(columns, (_, head) => `${head}expression: sql\`${elements}\`,`);
}
writeFileSync(file, source);
run(file); // re-emits ops.json and migration.json from the edited source
prisma("db", "migrate", "--db", process.env.DATABASE_URL);
