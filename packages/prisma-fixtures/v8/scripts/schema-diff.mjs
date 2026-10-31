// Compares the schemas of two databases with pg_dump: `node schema-diff.mjs
// <reference url> <candidate url>`. Exits 1 and prints the statements that
// differ. The comparison ignores only what cannot matter to the engine:
// - the prisma_contract schema, where Prisma 8 keeps its bookkeeping;
// - column order inside CREATE TABLE (Prisma 8 creates columns alphabetically;
//   the raw SQL names every column, including RETURNING "table".*, which is
//   read by name);
// - CURRENT_TIMESTAMP versus now(), which Prisma 7 and Prisma 8 write
//   respectively for the same column default.
import { execFileSync } from "node:child_process";

const [reference, candidate] = process.argv.slice(2);
if (!reference || !candidate) throw new Error("usage: schema-diff.mjs <reference url> <candidate url>");

function statements(url) {
  const dump = execFileSync("pg_dump", ["--schema-only", "--no-owner", "--no-privileges", url], {
    encoding: "utf8",
  });
  const result = [];
  let lines = [];
  for (const line of dump.split("\n")) {
    if (!line.trim() || /^(--|\\|SET |SELECT pg_catalog\.set_config)/.test(line)) continue;
    lines.push(line);
    if (!line.endsWith(";")) continue;
    if (lines[0].startsWith("CREATE TABLE")) {
      const body = lines.slice(1, -1).map((l) => l.replace(/,$/, "")).sort();
      lines = [lines[0], ...body.map((l, i) => (i < body.length - 1 ? `${l},` : l)), lines.at(-1)];
    }
    const text = lines.join("\n").replaceAll("CURRENT_TIMESTAMP", "now()");
    if (!text.includes("prisma_contract")) result.push(text);
    lines = [];
  }
  return new Set(result);
}

const a = statements(reference);
const b = statements(candidate);
const onlyReference = [...a].filter((s) => !b.has(s));
const onlyCandidate = [...b].filter((s) => !a.has(s));
for (const s of onlyReference) console.log(`only in the reference:\n${s}\n`);
for (const s of onlyCandidate) console.log(`only in the candidate:\n${s}\n`);
console.log(`${a.size} statements in the reference, ${b.size} in the candidate, ${onlyReference.length + onlyCandidate.length} differ`);
process.exit(onlyReference.length + onlyCandidate.length === 0 ? 0 : 1);
