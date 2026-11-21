import { UNCOMMITTED_READS } from "./sqlite-date-guard.js";
import { maxTimerMs, rolledBackWrite } from "./transaction-writes.js";
/**
 * `fromPrisma8(db)`: lets the Prisma adapters run on a Prisma 8 client.
 *
 *   const db = postgres({ contract, url });
 *   createPrismaWorkflowPersistence(fromPrisma8(db));
 *
 * Inside your own transaction, pass its `tx` and the contract (a `tx` has
 * none); your writes and the engine's then commit or roll back together:
 *
 *   await db.transaction(async (tx) => {
 *     createPrismaWorkflowPersistence(fromPrisma8(tx, { contract: db.contract }));
 *   });
 *
 * A Prisma 8 client has no model delegates, no `$transaction`, no increments
 * and no raw `Date` or array parameters. This wrapper gives it the client
 * surface the adapters call, nothing more: each delegate call is compiled to
 * SQL through the client's raw lane, using the column types in `db.contract`. Every argument shape it accepts behaves as it does on Prisma 6
 * and 7 (see the "argument parity" cases of the Postgres conformance suite);
 * anything else throws before any SQL runs, so it is never ignored or coerced.
 *
 * - Delegates are lazy: a call runs when awaited, or inside `$transaction([...])`.
 * - Timestamps use UTC text: `Date` in becomes ISO text, text out becomes `Date`.
 * - Raw reads must declare their columns (`client.$withColumns(...)`), since Prisma 8 drops
 *   the ones they do not.
 * - SQLite root writes share a queue, including entire transactions; a statement
 *   that may write reaches the root connection only in its turn (`inTurn`).
 *
 * Imports nothing from Prisma, like the rest of the package.
 */

import type { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "../../utils/logger";
import type { BlobPrismaClient } from "./blob-store";
import type { EnginePrismaClient, RawColumns } from "./prisma-client-type";

const logger = createLogger("fromPrisma8");

type Row = Record<string, any>;
type Args = Record<string, any>;

interface Column {
  codecId: string;
  nullable: boolean;
  /** Present when the database fills the column in. */
  default?: unknown;
  typeParams?: { typeName?: string };
  /** The members of a native enum, from the contract. */
  members?: string[];
}
interface Relation {
  cardinality: string;
  on: { localFields: string[]; targetFields: string[] };
  to: { model: string };
}
interface Contract {
  target: "postgres" | "sqlite";
  storage: {
    namespaces: {
      [namespace: string]: {
        entries: {
          table: Record<
            string,
            {
              columns: Record<string, Column>;
              primaryKey: { columns: string[] };
              indexes: Array<{ columns: string[]; unique: boolean }>;
              uniques?: Array<{ columns: string[] }>;
            }
          >;
          native_enum?: Record<string, { members: string[] }>;
        };
      };
    };
  };
  domain: {
    namespaces: {
      [namespace: string]: {
        models: Record<
          string,
          { relations: Record<string, Relation>; storage: { table: string } }
        >;
      };
    };
  };
  execution?: {
    mutations?: {
      defaults?: Array<{
        ref: { entry: string; field: string };
        onCreate?: { id: string };
        onUpdate?: { id: string };
      }>;
    };
  };
}

/** The part of a Prisma 8 client, or of the `tx` of its `transaction()`, this uses. */
export interface Prisma8Tx {
  raw: { sql: (strings: any, ...values: any[]) => any };
  query(plan: any): { toArray(): Promise<Row[]> };
  execute(plan: any): Promise<{ affectedRows: number }>;
}
type Executor = Prisma8Tx;
export interface Prisma8Db extends Prisma8Tx {
  contract: unknown;
  transaction(fn: (tx: any) => Promise<any>): Promise<any>;
}

/**
 * What `fromPrisma8` returns: the engine's client with the raw members
 * required, so it also fits the console's client type. `workflowBlob` is there
 * when the contract has the `WorkflowBlob` model, which the blob store needs.
 */
export interface Prisma8Client
  extends Omit<EnginePrismaClient, "$withColumns">,
    BlobPrismaClient {
  readonly $databaseType?: "postgresql" | "sqlite";
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
  $withColumns(columns: RawColumns): Prisma8Client;
}

interface Model {
  sqlite: boolean;
  name: string;
  table: string;
  cols: Record<string, Column>;
  primaryKey: string[];
  /** Primary and unique keys by Prisma's compound name, `a_b`. */
  keys: Map<string, string[]>;
  relations: Record<string, Relation & { target: Model }>;
  onCreate: Record<string, string>;
  onUpdate: Record<string, string>;
}

const TEXT = "pg/text@1";
const INT4 = "pg/int4@1";
const INT8 = "pg/int8@1";
const JSONB = "pg/jsonb@1";
const ENUM = "pg/enum@1";
const FLOAT8 = "pg/float8@1";
const TIMESTAMP = "pg/timestamp-string@1";
const SQL_TYPES: Record<string, string> = {
  [TEXT]: "text",
  [INT4]: "int4",
  [FLOAT8]: "float8",
  [JSONB]: "jsonb",
  [TIMESTAMP]: "timestamp",
};
const RAW_TYPES: Record<string, string> = {
  text: TEXT,
  int: INT4,
  bigint: INT8,
  float: FLOAT8,
  bool: "pg/bool@1",
  json: JSONB,
  timestamp: TIMESTAMP,
};
const SQLITE_TYPES: Record<string, string> = {
  text: "sqlite/text@1",
  int: "sqlite/integer@1",
  bigint: "sqlite/bigint@1",
  float: "sqlite/real@1",
  bool: "sqlite/integer@1",
  json: "sqlite/json@1",
  timestamp: "sqlite/datetime@1",
};
const SQLITE_KINDS: Record<string, string> = {
  "sqlite/text@1": TEXT,
  "sqlite/integer@1": INT4,
  "sqlite/real@1": FLOAT8,
  "sqlite/json@1": JSONB,
  "sqlite/datetime@1": TIMESTAMP,
};
const kindOf = (c: Column) => SQLITE_KINDS[c.codecId] ?? c.codecId;
const ISOLATION: Record<string, string> = {
  ReadUncommitted: "READ UNCOMMITTED",
  ReadCommitted: "READ COMMITTED",
  RepeatableRead: "REPEATABLE READ",
  Serializable: "SERIALIZABLE",
};
let lastIdTime = 0;
let lastIdCount = 0;
/**
 * Ids sort in creation order (hex time, then a counter within the millisecond),
 * like the cuids of 6 and 7: the adapters break `createdAt` ties on `id`.
 * Prisma 8's own cuid2 is random and would not.
 */
function sortableId(): string {
  const time = Math.max(Date.now(), lastIdTime);
  lastIdCount = time === lastIdTime ? lastIdCount + 1 : 0;
  lastIdTime = time;
  const random = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!;
  return `${time.toString(16).padStart(12, "0")}${lastIdCount.toString(16).padStart(4, "0")}${random.toString(16).padStart(8, "0")}`;
}
const GENERATORS: Record<string, () => unknown> = {
  cuid2: sortableId,
  timestampStringNow: () => new Date(),
  timestampNow: () => new Date(),
};
const REQUIRED_TABLES = [
  "workflow_runs",
  "workflow_stages",
  "workflow_logs",
  "workflow_artifacts",
  "workflow_annotations",
  "outbox_events",
  "idempotency_keys",
  "job_queue",
  "ai_calls",
  "workflow_steps",
];
const OPTIONAL_TABLES = ["workflow_definitions", "workflow_blobs"];
/** The most bind parameters Postgres takes in one statement. */
const MAX_PARAMS = 65_535;

const fail = (message: string): never => {
  throw new Error(`fromPrisma8: ${message}`);
};
const isObject = (value: unknown): value is Args =>
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Date) &&
  !Array.isArray(value);
const quote = (name: string) => `"${name}"`;

/** Prisma's error for `update` / `delete` of a row that is not there. */
const notFound = () =>
  Object.assign(
    new Error(
      "An operation failed because it depends on one or more records that were required but not found. Record not found.",
    ),
    { code: "P2025" },
  );

// ============================================================================
// SQL text and parameters
// ============================================================================

/** A raw parameter in a form the Prisma 8 raw lane takes: `Date` and arrays are not. */
function param(value: unknown, sqlite = false): unknown {
  if (value instanceof Date) return value.toISOString();
  // node:sqlite binds a boolean only from Node 24.21 and 26.8; 1 and 0 are what it stores.
  if (typeof value === "boolean" && sqlite) return Number(value);
  if (typeof value === "bigint") return sqlite ? value : String(value);
  if (Array.isArray(value)) {
    if (sqlite) fail("SQLite raw parameters do not support arrays");
    return arrayLiteral(value);
  }
  return value;
}

/** A Postgres array literal, every element quoted so commas, quotes and backslashes survive. */
function arrayLiteral(items: unknown[]): string {
  const element = (item: unknown) =>
    item == null
      ? "NULL"
      : `"${String(param(item)).replace(/[\\"]/g, "\\$&")}"`;
  return `{${items.map(element).join(",")}}`;
}

/**
 * A statement being built: SQL text parts and the parameters between them.
 * A null is written into the text as `NULL`, since the raw lane cannot bind one.
 * Exported with `rowsOf` for the tests that drive a bare executor; not public API.
 */
export class Sql {
  readonly parts = [""];
  readonly values: unknown[] = [];

  t(text: string): this {
    this.parts[this.parts.length - 1] += text;
    return this;
  }

  /** A parameter, followed by `suffix` (a cast such as `::text`). */
  v(value: unknown, suffix = "", sqlite = false): this {
    const bound = param(value, sqlite);
    if (bound == null) return this.t(`NULL${suffix}`);
    this.values.push(bound);
    this.parts.push(suffix);
    return this;
  }

  /** `other`'s text and parameters, after this one's. */
  add(other: Sql): this {
    this.t(other.parts[0]!);
    for (let i = 0; i < other.values.length; i++) {
      this.values.push(other.values[i]);
      this.parts.push(other.parts[i + 1]!);
    }
    return this;
  }
}

/** Text with `$1`..`$n` placeholders: a repeated `$n` binds its value at each occurrence. */
function positional(text: string, values: unknown[], sqlite = false): Sql {
  const pieces = text.split(/\$(\d+)/);
  const q = new Sql().t(pieces[0]!);
  for (let i = 1; i < pieces.length; i += 2) {
    const index = Number(pieces[i]);
    if (index < 1 || index > values.length) {
      fail(`parameter $${index} has no value`);
    }
    q.v(values[index - 1], "", sqlite).t(pieces[i + 1]!);
  }
  return q;
}

function template(
  strings: readonly string[],
  values: unknown[],
  sqlite = false,
): Sql {
  const q = new Sql();
  strings.forEach((text, i) => {
    q.t(text);
    if (i < values.length) q.v(values[i], "", sqlite);
  });
  return q;
}

const sqlOf = (x: Executor, q: Sql) =>
  x.raw.sql(Object.assign(q.parts, { raw: q.parts }), ...q.values);
/** The plan names its database (`meta.target`); this is only Postgres, so an unknown one is treated as SQLite. */
const postgres = (plan: { meta?: { target?: string } }) =>
  plan.meta?.target === "postgres";

/**
 * The one place a statement becomes a plan, and every `x.query` and `x.execute`
 * here runs a plan built by it. What depends on the database (the NUL check,
 * SQLite's unsafe-integer read) is decided from the plan, never from the
 * executor: the root client, a transaction's, a consumer's `tx` and the driver's
 * own executor inside a chunked write all pass through here the same way.
 * With `spec` the plan returns rows, else it counts the rows it changes.
 */
function buildPlan(x: Executor, q: Sql, spec?: Record<string, string>) {
  const plan = (
    spec ? sqlOf(x, q).returnsRow(spec) : sqlOf(x, q).affectedCount()
  ).build();
  refuseNul(plan, q);
  if (!spec || postgres(plan)) return { plan };
  const statement = statementOf(q);
  const wire = sqliteRead(q, spec, statement);
  return {
    plan: sqlOf(x, wire.q).returnsRow(wire.spec).build(),
    overflow: wire.overflow,
    statement,
  };
}

/** The shared root connection of a SQLite client: it has `transaction`, a transaction's `tx` does not. */
const sqliteRoot = (x: Executor, plan: { meta?: { target?: string } }) =>
  !postgres(plan) &&
  typeof (x as Partial<Prisma8Db>).transaction === "function";

const affected = async (x: Executor, q: Sql): Promise<number> => {
  const { plan } = buildPlan(x, q);
  if (!sqliteRoot(x, plan)) return (await x.execute(plan)).affectedRows;
  await inTurn(x);
  try {
    return (await othersClosed(gateOf(x), () => x.execute(plan))).affectedRows;
  } catch (error) {
    // WAL: a root read still handing over rows keeps the root on a snapshot
    // older than another connection's commit, and a write on it fails at once
    // with SQLITE_BUSY_SNAPSHOT. Nothing ran; once those reads end it can.
    return (await afterStaleSnapshot(gateOf(x), error, () => x.execute(plan)))
      .affectedRows;
  }
};

/** Runs `retry` once the root reads in flight have ended, if `error` came from one. */
function afterStaleSnapshot<T>(
  gate: ReadGate | undefined,
  error: unknown,
  retry: () => Promise<T>,
): Promise<T> {
  if (!gate || gate.closed || !staleSnapshot(error)) throw error;
  return withoutReads(gate, retry);
}

function staleSnapshot(error: unknown): boolean {
  for (
    let depth = 0;
    depth < 5 && error && typeof error === "object";
    depth++
  ) {
    if ((error as { errcode?: unknown }).errcode === 517) return true;
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

let nulReadable: boolean | undefined;
/**
 * node:sqlite stores a NUL in TEXT, but before Node 24.16 and 26.1 (every 22.x)
 * it reads the value back cut at the NUL: nodejs/node#61954 made the read
 * length-aware. Tested on the running Node, not by version number.
 * `getBuiltinModule`, not `import()`: the bundler rewrites `node:sqlite` to `sqlite`.
 * Node has `getBuiltinModule` since 22.3 and `node:sqlite` since 22.5; another
 * runtime without it cannot be probed, so it counts as cutting.
 */
function readsNul(): boolean {
  if (nulReadable === undefined) {
    const sqlite = process.getBuiltinModule?.("node:sqlite");
    const db = sqlite && new sqlite.DatabaseSync(":memory:");
    try {
      nulReadable =
        !!db && db.prepare("SELECT ? AS v").get("a\0b")?.v === "a\0b";
    } finally {
      db?.close();
    }
  }
  return nulReadable;
}

/**
 * A NUL that would be read back cut changes an ID or text without an error: refuse it.
 * Postgres rejects a NUL itself.
 */
function refuseNul(plan: { meta?: { target?: string } }, q: Sql): void {
  if (postgres(plan)) return;
  if (!q.values.some((v) => typeof v === "string" && v.includes("\0"))) return;
  if (!readsNul())
    fail(
      `SQLite text containing a NUL character cannot be stored on Node ${process.versions.node}: node:sqlite reads it back cut at the NUL here (or could not be tested for it), which would change IDs and text without an error. Use Node 24.16+ or 26.1+, or remove the NUL`,
    );
}

/**
 * The one decision about a SQLite statement: `read` when it provably only
 * reads, that is SELECT, VALUES, EXPLAIN of anything, or WITH whose statement
 * is a SELECT or VALUES (SQLite refuses a write in a CTE body). Anything else,
 * PRAGMA included, may write: on the root client it is queued, and only its
 * queue turn may run it (`inTurn`, `rootWrite`). A read taken for a write
 * costs a wait in the queue; the reverse would lose writes.
 */
function statementOf(q: Sql) {
  const source = q.parts.join("\0");
  const tokens = [
    ...source.matchAll(
      /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\w$\u0080-￿]+|[(),;*]/g,
    ),
  ].filter(([s]) => !s.startsWith("--") && !s.startsWith("/*"));
  let depth = 0;
  const top = tokens.filter(([s]) => {
    if (s === ")") depth--;
    const outside = depth === 0;
    if (s === "(") depth++;
    return outside;
  });
  while (top[0]?.[0] === ";") top.shift();
  const words = top.map(([s]) => s.toUpperCase());
  const first = words[0];
  // SQLite runs a PRAGMA while preparing it, so `EXPLAIN PRAGMA x = 1` sets it.
  const explained =
    first === "EXPLAIN" ? words[words[1] === "QUERY" ? 3 : 1] : undefined;
  const verb =
    first === "WITH"
      ? words.find((w) =>
          /^(SELECT|VALUES|INSERT|UPDATE|DELETE|REPLACE)$/.test(w),
        )
      : first;
  return {
    source,
    top,
    first,
    returning: top.find((t) => /^RETURNING$/i.test(t[0])),
    read:
      (first === "EXPLAIN" && explained !== "PRAGMA") ||
      verb === "SELECT" ||
      verb === "VALUES",
  };
}

/**
 * rc.21 cannot finalize its native iterator when converting an INTEGER to a
 * JS number throws in next(). Carry unsafe integers as text instead: decoding
 * then happens after a row was yielded, where the runtime closes the iterator.
 * BigInt columns can read that text exactly; other columns must still reject it.
 */
function sqliteRead(
  q: Sql,
  spec: Record<string, string>,
  { source, top, first, returning, read }: ReturnType<typeof statementOf>,
) {
  // EXPLAIN returns the plan's own columns, whatever it explains.
  if (first === "EXPLAIN" || (!returning && !read)) return { q, spec };
  const bindings = q.values.map((value) => ({ value }));
  const slice = (start: number, end = source.length) => {
    const out = new Sql();
    const parts = source.slice(start, end).split("\0");
    const offset = source.slice(0, start).split("\0").length - 1;
    out.parts.splice(0, 1, ...parts);
    out.values.push(...bindings.slice(offset, offset + parts.length - 1));
    return out;
  };
  const end = top.at(-1)?.[0] === ";" ? top.at(-1)!.index! : source.length;
  const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
  let overflow = "__prisma8_integer_overflow";
  while (Object.keys(spec).some((name) => name.toLowerCase() === overflow))
    overflow += "_";
  let relation = "__prisma8_read";
  while (source.toLowerCase().includes(relation)) relation += "_";
  const unsafe = (value: Sql) =>
    new Sql()
      .t("(typeof(")
      .add(value)
      .t(") = 'integer' AND (")
      .add(value)
      .t(" < -9007199254740991 OR ")
      .add(value)
      .t(" > 9007199254740991))");
  const checks: Sql[] = [];
  const project = (value: Sql, name: string) => {
    if (spec[name] !== SQLITE_TYPES.bigint) checks.push(unsafe(value));
    return new Sql()
      .t("CASE WHEN ")
      .add(unsafe(value))
      .t(" THEN CAST(")
      .add(value)
      .t(" AS TEXT) ELSE ")
      .add(value)
      .t(` END AS ${ident(name)}`);
  };
  let out: Sql;
  let count = 0;
  if (returning) {
    out = slice(0, returning.index! + returning[0].length).t(" ");
    const separators = top.filter(
      (t) => t.index! > returning.index! && t[0] === ",",
    );
    const starts = [
      returning.index! + returning[0].length,
      ...separators.map((t) => t.index! + 1),
    ];
    const ends = [...separators.map((t) => t.index!), end];
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i]!,
        finish = ends[i]!;
      const text = source.slice(start, finish).trim();
      const fields = text === "*" ? Object.keys(spec) : undefined;
      if (fields) {
        for (const name of fields) {
          if (count++) out.t(", ");
          out.add(project(new Sql().t(ident(name)), name));
        }
        continue;
      }
      const own = top.filter((t) => t.index! >= start && t.index! < finish);
      const as = own.findLast((t) => /^AS$/i.test(t[0]));
      const alias = own.at(-1)?.[0] ?? text;
      const last = own.at(-1);
      const prefix = source.slice(start, last?.index ?? finish).trimEnd();
      const implicit =
        !as &&
        own.length > 1 &&
        /^(?:[a-z_]\w*|["'`\[])/i.test(alias) &&
        !/[.+\-*/%|<>=]$/.test(prefix);
      const plain = text
        .replace(
          /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g,
          (part) =>
            part.startsWith("--") || part.startsWith("/*") ? " " : part,
        )
        .trim()
        .replace(/^(?:\(\s*)+/, "")
        .replace(/(?:\s*\))+$/, "")
        .trim();
      const simple =
        /^(?:(?:"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|\w+)\s*\.\s*)?(?:"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|\w+)$/.test(
          plain,
        );
      const label =
        as || implicit
          ? alias
          : simple
            ? [...plain.matchAll(/"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|\w+/g)].at(
                -1,
              )![0]
            : text;
      const name =
        as || implicit || simple
          ? label
              .replace(/^(["'`])([\s\S]*)\1$/, (_s, quote, body) =>
                body.replaceAll(quote + quote, quote),
              )
              .replace(/^\[([\s\S]*)\]$/, "$1")
          : text;
      if (count++) out.t(", ");
      out.add(
        project(
          slice(start, as?.index ?? (implicit ? last!.index! : finish)).t("\n"),
          name,
        ),
      );
    }
  } else {
    out = new Sql()
      .t(`WITH ${ident(relation)} AS MATERIALIZED (`)
      .add(slice(0, end))
      .t("\n) SELECT ");
    Object.keys(spec).forEach((name, i) => {
      if (i) out.t(", ");
      out.add(project(new Sql().t(ident(name)), name));
      count++;
    });
  }
  out.t(`${count ? ", " : ""}CASE WHEN `);
  if (checks.length === 0) out.t("false");
  checks.forEach((check, i) => {
    if (i) out.t(" OR ");
    out.add(check);
  });
  out.t(` THEN 1 ELSE 0 END AS ${ident(overflow)}`);
  if (!returning) out.t(` FROM ${ident(relation)}`);
  // Reuse SQLite's numbered binds when RETURNING repeats an expression.
  const bound = new Sql().t(out.parts[0]!);
  const seen = new Map<object, number>();
  out.values.forEach((ref, i) => {
    const binding = ref as { value: unknown };
    const index = seen.get(binding);
    if (index !== undefined) bound.t(`?${index}`);
    else {
      seen.set(binding, seen.size + 1);
      bound.values.push(binding.value);
      bound.parts.push("");
    }
    bound.t(out.parts[i + 1]!);
  });
  return {
    q: bound,
    spec: { ...spec, [overflow]: SQLITE_TYPES.int! },
    overflow,
  };
}

/**
 * Fails unless this runs in the queue turn of `x`, the shared root connection
 * of a SQLite client. Only the queue's runner opens a turn (`enqueue`), one at
 * a time, and it ends when the queued call settles: so nothing that may write,
 * and no `BEGIN IMMEDIATE`, reaches the root outside the queue, and no other
 * caller's write can run inside a lock taken here.
 */
async function inTurn(x: Executor): Promise<void> {
  const store = (await context()).getStore();
  if (!store?.turn?.active || store.queue !== followQueue(writeQueues.get(x)))
    fail(
      "internal error: a SQLite statement that may write reached the root connection outside its write queue",
    );
}

/**
 * In the SQLite that node:sqlite ships on Node 22 and 24, a connection keeps
 * its page cache as of its last read when `journal_mode` takes it out of WAL,
 * though another connection (an engine transaction's) committed since: its next
 * write then drops rows or breaks indexes in the file. An unqualified
 * `journal_mode` change reaches every attached database too. So the root's
 * cache is dropped after any root statement that may have changed it, whether
 * it succeeded or threw: `PRAGMA shrink_memory` only releases the connection's
 * own memory (measured: it never waited, failed busy or left a statement open;
 * SQLite documents no lock for it), and it cannot free a page a read still
 * handing over rows holds (SQLite refuses the change then). A statement
 * whose text contains `journal_mode`, however spelled, counts: a drop after one
 * that only reads the mode costs just the cache. A failed drop is ignored, so
 * the statement's own result or error is what the caller sees.
 */
const mayChangeJournalMode = (statement: ReturnType<typeof statementOf>) =>
  /journal_mode/i.test(statement.source);
const DROP_CACHE = "PRAGMA shrink_memory";

/**
 * A statement that may write, on the root connection, in its queue turn.
 * node:sqlite leaves a statement that fails SQLITE_BUSY at its first step
 * active when it runs through `iterate()`, which the Prisma 8 driver uses for
 * every statement that returns rows; on the root, every later write then
 * reports success, is not committed, and is rolled back when the statement
 * object is collected. So a statement that returns rows runs under
 * `BEGIN IMMEDIATE`, which takes the write lock through `run()` (it fails
 * cleanly on BUSY after the busy_timeout), and one that returns none runs
 * through the driver's `execute`, which uses `run()` itself. A PRAGMA that
 * returns rows runs as it is: none of SQLite's opens a write transaction, and
 * `journal_mode = WAL` and `wal_checkpoint` cannot run inside one.
 */
async function rootWrite(
  x: Executor,
  q: Sql,
  plan: ReturnType<typeof buildPlan>["plan"],
  statement: ReturnType<typeof statementOf>,
): Promise<Row[]> {
  const rows = () => x.query(plan).toArray();
  if (!statement.returning) {
    try {
      await affected(x, q);
      return [];
    } catch (error) {
      // The driver refuses before it runs a statement that returns rows.
      if (!/cannot execute statements that return rows/.test(String(error)))
        throw error;
    }
    if (statement.first === "PRAGMA") return rows();
  }
  // No other root read starts inside this transaction: it would see rows a
  // failed COMMIT then takes back. Those in flight get a bounded wait.
  const gate = gateOf(x);
  const open = gate && !gate.closed ? await closeFileReads(gate) : undefined;
  try {
    await affected(x, new Sql().t("BEGIN IMMEDIATE"));
    try {
      const result = await rows();
      await affected(x, new Sql().t("COMMIT"));
      return result;
    } catch (error) {
      await affected(x, new Sql().t("ROLLBACK")).catch(() => {});
      throw error;
    }
  } finally {
    open?.();
  }
}

/**
 * Root reads in flight on a SQLite root client. The driver hands rows over one
 * at a time across microtasks, so a root read that returns rows holds its read
 * lock between them; on a rollback-journal file a transaction's COMMIT on
 * another connection of the same process then waits its busy_timeout
 * synchronously, the read cannot finish meanwhile, and the commit fails.
 */
interface ReadGate {
  /** Every root read in flight. */
  reading: number;
  /** Of those, the adapter's own (`rowsOf`): it drains them itself. */
  adapter: number;
  /** Counts every step of a read: a turn without one means none moved. */
  progress: number;
  /** Called when a read ends, for a write waiting on the adapter's reads. */
  ended?: () => void;
  /** Set while a write waits for the reads in flight; new root reads wait for it. */
  closed?: Promise<void>;
  /** `adopt` ran: the driver was looked up once, at the client's first use. */
  adopted?: boolean;
  /** Another client over the same driver owns the gate: use that one. */
  to?: ReadGate;
  /** Settles once the root's transaction state was read at the takeover. */
  ready?: Promise<void>;
  /**
   * Set while the root connection is inside a transaction this layer did not
   * open (a raw BEGIN sent before the takeover): `ended` settles when it ends.
   */
  foreign?: { ended: Promise<void>; end: () => void };
  /** Reads the root's transaction state again (`ownRootConnection`). */
  recheck?: () => Promise<void>;
  /**
   * In WAL, whether this root could start a write now, without waiting: no
   * connection holds the file's write lock. False on a rollback journal,
   * where a reader also holds a commit back (`ownRootConnection`).
   */
  writable?: () => Promise<boolean>;
  /** The gates of every root of this process on the same file (`joinFile`). */
  file?: Set<ReadGate>;
  /** The root driver was closed: it leaves, or never joins, its file. */
  left?: boolean;
  /** Removes the gate from its file, and the file once no root is left. */
  leave?: () => void;
}
const readGates = new WeakMap<object, ReadGate>();

function gateOf(x: object): ReadGate | undefined {
  let gate = readGates.get(x);
  while (gate?.to) gate = gate.to;
  return gate;
}

/**
 * Longest a write waits for root reads in flight: the driver's busy timeout,
 * which bounds how long a COMMIT would have waited for them itself.
 */
const READ_WAIT_MS = 5000;

/**
 * An engine write on a root connection that is inside a transaction this
 * layer did not open waits for that transaction to end, outside the write
 * queue so the consumer can still end it, for at most READ_WAIT_MS, and then
 * fails with this busy-class error. Joining it instead would let the
 * consumer's ROLLBACK, or a close without COMMIT, undo a write already
 * acknowledged.
 */
async function untilOwnRoot(db: object): Promise<void> {
  const gate = gateOf(db);
  await gate?.ready;
  if (!gate) return;
  const end = Date.now() + READ_WAIT_MS;
  for (;;) {
    // Any root of this process on the file: a transaction there that holds the
    // file's write lock would make this root's write wait synchronously.
    const holder: ReadGate | undefined = [...(gate.file ?? [gate])].find(
      (g) => g.foreign,
    );
    const open = holder?.foreign;
    if (!holder || !open) return;
    // In WAL a transaction of another root that has not written blocks no
    // writer: go ahead once no connection holds the write lock.
    const other = holder !== gate;
    if (other && (await gate.writable?.())) return;
    const left = end - Date.now();
    if (left <= 0)
      throw Object.assign(
        new Error(
          other
            ? "fromPrisma8: another SQLite root connection of this process on the same file (another client over the file) is inside a transaction this adapter did not open (a raw BEGIN sent through that client before the adapter's first call on it); the engine's write waited 5 s for it to end. COMMIT or ROLLBACK it, and open transactions with $transaction or db.transaction. In WAL only such a transaction that has written holds engine writes back"
            : "fromPrisma8: the SQLite root connection is inside a transaction this adapter did not open (a raw BEGIN sent through the client before the adapter's first call); the engine's write waited 5 s for it to end. COMMIT or ROLLBACK it, and open transactions with $transaction or db.transaction",
        ),
        { code: "SQLITE_BUSY", errcode: 5 },
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      open.ended,
      new Promise<void>((resolve) => {
        // Another root's transaction may stop holding the write lock without
        // ending (WAL): look again shortly.
        timer = setTimeout(resolve, other ? Math.min(left, 25) : left);
      }),
    ]);
    clearTimeout(timer);
  }
}

/**
 * `db.transaction(fn)` for the adapter's own transactions. Root reads that
 * start while it commits wait for the commit. On a rollback-journal file the
 * commit also waits for the root reads in flight (`closeReads`, bounded); a
 * WAL commit does not wait for readers. The mode is read only when reads are
 * in flight, at that commit, so a mode changed later is followed. Adapter
 * transactions run one at a time (the root write queue).
 */
function transactionOf<T>(
  db: Prisma8Db,
  fn: (raw: Executor) => Promise<T>,
): Promise<T> {
  adopt(db);
  const gate = gateOf(db);
  if (!gate) return db.transaction(fn);
  let open: (() => void) | undefined;
  return db
    .transaction(async (raw: Executor) => {
      const result = await fn(raw);
      const reading = readingFile(gate);
      const [mode] = reading
        ? await rowsOf(raw, new Sql().t("PRAGMA journal_mode"), {
            journal_mode: SQLITE_TYPES.text!,
          })
        : [];
      // Without reads in flight the mode is not read: closing costs nothing.
      if (!reading || mode?.journal_mode !== "wal") {
        const start = Date.now();
        open = await closeFileReads(gate);
        // Reads left in flight hold the file: COMMIT waits for them in its
        // busy timeout. This connection is the transaction's own, closed after
        // it: give COMMIT only what is left of the one wait, so it fails no
        // later than it would without the wait above.
        if (readingFile(gate))
          await rowsOf(
            raw,
            new Sql().t(
              `PRAGMA busy_timeout = ${Math.max(0, READ_WAIT_MS - (Date.now() - start))}`,
            ),
            { timeout: SQLITE_TYPES.int! },
          );
      }
      return result;
    })
    .finally(() => open?.());
}

/**
 * Holds new root reads back and waits, for at most READ_WAIT_MS, for those in
 * flight. The adapter's own reads are drained by the adapter, so they are
 * waited for. A read some consumer iterates (`db.orm`, `db.query`) is waited
 * for only while it moves: one whole event-loop turn without a step means its
 * consumer holds it, and may itself be waiting on this write, so the write
 * goes ahead and SQLite decides, as it would without this layer. Returns the
 * release. One waiter at a time: the callers run in write-queue turns.
 */
async function closeReads(gate: ReadGate): Promise<() => void> {
  const end = Date.now() + READ_WAIT_MS;
  let open!: () => void;
  gate.closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  let seen = -1;
  while (gate.reading > 0 && Date.now() < end) {
    if (gate.adapter > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        gate.ended = resolve;
        timer = setTimeout(resolve, end - Date.now());
      });
      clearTimeout(timer);
      gate.ended = undefined;
      continue;
    }
    if (gate.progress === seen) break;
    seen = gate.progress;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return () => {
    gate.closed = undefined;
    open();
  };
}

/** `closeReads` on every root of this process on the gate's file. */
async function closeFileReads(gate: ReadGate): Promise<() => void> {
  const gates = [...(gate.file ?? [gate])].filter((g) => !g.closed);
  const opens = await Promise.all(gates.map(closeReads));
  return () => {
    for (const open of opens) open();
  };
}

const readingFile = (gate: ReadGate) =>
  [...(gate.file ?? [gate])].some((g) => g.reading > 0);

/**
 * Runs an autocommit write on a root while the other roots of its file hold
 * no read: on a rollback-journal file its commit would wait for them
 * synchronously (`joinFile`). Only around the statement, never a whole queue
 * turn: a transaction's callback may read through another root, and its
 * COMMIT closes the reads itself (`transactionOf`). The root's own reads
 * stay open.
 */
async function othersClosed<T>(
  gate: ReadGate | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const others = gate?.file
    ? [...gate.file].filter((g) => g !== gate && !g.closed)
    : [];
  if (!others.length) return work();
  const reopen = await Promise.all(others.map(closeReads));
  try {
    return await work();
  } finally {
    for (const release of reopen) release();
  }
}

async function withoutReads<T>(gate: ReadGate, work: () => Promise<T>) {
  const open = await closeFileReads(gate);
  try {
    return await work();
  } finally {
    open();
  }
}

/** Rows for `spec` (column -> codec id); timestamps come back as `Date`. Not public API. */
export async function rowsOf(
  x: Executor,
  q: Sql,
  spec: Record<string, string>,
): Promise<Row[]> {
  const wire = buildPlan(x, q, spec);
  // A transaction's `tx` has a connection of its own, which goes with the transaction.
  let rows: Row[];
  if (wire.statement && !wire.statement.read && sqliteRoot(x, wire.plan)) {
    await inTurn(x);
    try {
      rows = await rootWrite(x, q, wire.plan, wire.statement);
    } finally {
      if (mayChangeJournalMode(wire.statement))
        await affected(x, new Sql().t(DROP_CACHE)).catch(() => {});
    }
  } else {
    adopt(x);
    const gate = gateOf(x);
    if (!gate) rows = await x.query(wire.plan).toArray();
    else {
      while (gate.closed) await gate.closed;
      gate.reading++;
      gate.adapter++;
      gate.progress++;
      try {
        // Marked, so the driver hook (`ownRootConnection`) leaves it to this count.
        const als = await context();
        rows = await als.run({ ...als.getStore(), read: true }, () =>
          x.query(wire.plan).toArray(),
        );
      } finally {
        gate.reading--;
        gate.adapter--;
        gate.progress++;
        gate.ended?.();
      }
    }
  }
  if (wire.overflow)
    for (const row of rows) {
      if (row[wire.overflow])
        throw Object.assign(
          new RangeError(
            "SQLite INTEGER cannot be represented as a JavaScript number",
          ),
          { code: "ERR_OUT_OF_RANGE" },
        );
      delete row[wire.overflow];
    }
  for (const row of rows) {
    for (const name in spec) {
      if (spec[name] === TIMESTAMP && typeof row[name] === "string") {
        row[name] = new Date(`${row[name]}Z`);
      }
    }
  }
  return rows;
}

// ============================================================================
// Columns and values
// ============================================================================

/** The codec a column is read with: a native enum is read as text. */
const codecOf = (c: Column) => (c.codecId === ENUM ? TEXT : c.codecId);

function castOf(c: Column): string {
  if (c.codecId.startsWith("sqlite/")) return "";
  if (c.codecId === ENUM) return `::"${c.typeParams?.typeName}"`;
  return `::${SQL_TYPES[c.codecId] ?? fail(`unsupported column codec ${c.codecId}`)}`;
}

const specOf = (m: Model, names: string[]) =>
  Object.fromEntries(names.map((n) => [n, codecOf(m.cols[n]!)]));

/** The values Prisma takes for each column type; a SQL cast would coerce others. */
const ACCEPTS: Record<string, (value: any, c: Column) => boolean> = {
  [TEXT]: (v) => typeof v === "string",
  [INT4]: (v) =>
    Number.isFinite(v) &&
    Math.trunc(v) >= -(2 ** 31) &&
    Math.trunc(v) < 2 ** 31,
  [FLOAT8]: (v) => Number.isFinite(v),
  [TIMESTAMP]: (v) => v instanceof Date && !Number.isNaN(v.getTime()),
  [ENUM]: (v, c) => c.members?.includes(v) === true,
};

function accept(c: Column, value: unknown, nullable = false): void {
  if (value === null ? !nullable : !ACCEPTS[kindOf(c)]?.(value, c)) {
    fail(`invalid value for a ${c.codecId} column`);
  }
}

/** 6 and 7 truncate a fractional Int; `retryBackoff` produces them. */
const int = (c: Column, value: any) =>
  kindOf(c) === INT4 && value !== null ? Math.trunc(value) : value;

/** A value written to, or compared with, column `c`. */
function bind(q: Sql, c: Column, value: unknown): void {
  // A JS null is the JSON value null on a JSON column, as on 6 and 7.
  if (kindOf(c) === JSONB) q.v(JSON.stringify(value), castOf(c));
  else {
    accept(c, value, c.nullable);
    q.v(int(c, value), castOf(c));
  }
}

function column(m: Model, name: string): Column {
  return m.cols[name] ?? fail(`${m.name} has no column "${name}"`);
}

function generate(id: string): unknown {
  return (GENERATORS[id] ?? fail(`unsupported default generator "${id}"`))();
}

// ============================================================================
// Compiling Prisma arguments
// ============================================================================

function check(op: string, args: Args, allowed: string[]): void {
  for (const key of Object.keys(args)) {
    if (args[key] !== undefined && !allowed.includes(key)) {
      fail(`${op} does not support the "${key}" argument`);
    }
  }
}

/**
 * `w` without what Prisma treats as absent: undefined values, and operator
 * objects, relation filters and `OR` children left empty by that. So `OR: [{}]`
 * matches nothing, and `{ id: {} }` is no filter at all.
 */
function prune(m: Model, w: unknown): Args {
  if (!isObject(w)) fail(`${m.name}: a filter must be an object`);
  const out: Args = {};
  for (const [key, v] of Object.entries(w as Args)) {
    const relation = m.relations[key];
    if (v === undefined) continue;
    if (key === "OR") {
      if (!Array.isArray(v)) fail("OR must be an array");
      out.OR = v
        .map((child: unknown) => prune(m, child))
        .filter((child: Args) => Object.keys(child).length > 0);
    } else if (relation?.cardinality === "1:N") {
      if (!isObject(v) || Object.keys(v).join() !== "none") {
        fail(`${m.name}.${key}: only a "none" filter is supported`);
      }
      if (v.none !== undefined) {
        out[key] = { none: prune(relation.target, v.none) };
      }
    } else if (relation || isObject(v)) {
      const child = relation
        ? prune(relation.target, v)
        : Object.fromEntries(
            Object.entries(v).filter(([, x]) => x !== undefined),
          );
      if (Object.keys(child).length > 0) out[key] = child;
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** A pruned `where`: fields, `OR` and relation filters. */
function where(q: Sql, m: Model, w: Args, a: string, d: number) {
  const entries = Object.entries(w);
  if (entries.length === 0) {
    q.t("true");
    return;
  }
  entries.forEach(([key, value], i) => {
    q.t(i ? " AND (" : "(");
    clause(q, m, key, value, a, d);
    q.t(")");
  });
}

function clause(q: Sql, m: Model, key: string, v: any, a: string, d: number) {
  const c = m.cols[key];
  const relation = m.relations[key];
  if (key === "OR") {
    if (v.length === 0) q.t("false");
    v.forEach((w: Args, i: number) => {
      q.t(i ? " OR (" : "(");
      where(q, m, w, a, d);
      q.t(")");
    });
  } else if (relation) {
    const child = `t${d + 1}`;
    const [local] = relation.on.localFields;
    const [target] = relation.on.targetFields;
    const toMany = relation.cardinality === "1:N";
    q.t(
      `${toMany ? "NOT " : ""}EXISTS (SELECT 1 FROM ${quote(relation.target.table)} ${child} WHERE ${child}.${quote(target!)} = ${a}.${quote(local!)} AND (`,
    );
    where(q, relation.target, toMany ? v.none : v, child, d + 1);
    q.t("))");
  } else if (!c) {
    fail(`${m.name} has no field "${key}" to filter on`);
  } else {
    const ref = `${a}.${quote(key)}`;
    if (kindOf(c) === JSONB && !isObject(v)) {
      fail(`${m.name}.${key}: a JSON filter must be an object`);
    }
    const ops: Args = isObject(v) ? v : { equals: v };
    if ("path" in ops) {
      const validPath = m.sqlite
        ? typeof ops.path === "string"
        : Array.isArray(ops.path) &&
          ops.path.every((part) => typeof part === "string");
      if (
        kindOf(c) !== JSONB ||
        Object.keys(ops).sort().join() !== "equals,path" ||
        !validPath
      ) {
        fail(`${m.name}.${key}: only { path, equals } is supported on JSON`);
      }
      if (m.sqlite) {
        // Compare JSON text, as Prisma 6/7 do: json_extract would conflate
        // true with 1, and JSON null with a missing path or SQL NULL.
        q.t(`(${ref} -> `).v(ops.path).t(") = ").v(JSON.stringify(ops.equals));
      } else {
        q.t(`(${ref} #> `)
          .v(ops.path, "::text[]")
          .t(") = ")
          .v(JSON.stringify(ops.equals), "::jsonb");
      }
      return;
    }
    Object.entries(ops).forEach(([op, x], i) => {
      if (i) q.t(") AND (");
      operator(q, c, ref, op, x);
    });
  }
}

/** The whole `where` of a statement, on the table aliased `t0`. */
const filtered = (q: Sql, m: Model, w: unknown) =>
  where(q, m, prune(m, w ?? {}), "t0", 0);

/**
 * The `where` of a single-row operation, compound keys flattened into columns,
 * and the unique keys in it. Prisma requires a complete one; with an empty
 * filter these operations would reach every row. Other filters may sit beside
 * it, which is how the adapters fence with `version`.
 */
function uniqueWhere(m: Model, w: unknown) {
  const columns: Array<[string, unknown]> = [];
  const keys: Args[] = [];
  for (const [name, value] of Object.entries(w ?? {})) {
    const parts = m.keys.get(name);
    if (value === undefined) continue;
    if (!parts) {
      columns.push([name, value]);
      continue;
    }
    const key = parts.length > 1 ? value : { [name]: value };
    if (
      !isObject(key) ||
      Object.keys(key).sort().join() !== [...parts].sort().join() ||
      Object.values(key).some((part) => part == null || isObject(part))
    ) {
      fail(`${m.name}: "${name}" is not a complete unique key`);
    }
    keys.push(key as Args);
    columns.push(...Object.entries(key as Args));
  }
  const flat = Object.fromEntries(columns);
  if (keys.length === 0 || Object.keys(flat).length !== columns.length) {
    fail(`${m.name}: "where" needs one complete unique key`);
  }
  return { where: flat, keys };
}

const COMPARISONS: Record<string, string> = {
  equals: "=",
  not: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

const EQUALITY = ["equals", "not"];
const LISTED = [...EQUALITY, "in", "notIn"];
const ORDERED = [...LISTED, "lt", "lte", "gt", "gte"];
const OPERATORS: Record<string, string[]> = {
  [TEXT]: [...ORDERED, "startsWith", "endsWith"],
  [INT4]: ORDERED,
  [FLOAT8]: ORDERED,
  [TIMESTAMP]: ORDERED,
  [ENUM]: LISTED,
  [JSONB]: EQUALITY,
};

function operator(q: Sql, c: Column, ref: string, op: string, x: unknown) {
  if (!OPERATORS[kindOf(c)]?.includes(op)) {
    fail(`unsupported filter operator "${op}" on a ${c.codecId} column`);
  }
  if (op === "in" || op === "notIn") {
    if (!Array.isArray(x)) fail(`${op} needs an array`);
    for (const item of x as unknown[]) accept(c, item);
    if (c.codecId.startsWith("sqlite/")) {
      // One bind for the list, including lists beyond SQLite's bind limit.
      q.t(
        `${ref} ${op === "in" ? "IN" : "NOT IN"} (SELECT value FROM json_each(`,
      )
        .v(JSON.stringify((x as unknown[]).map((item) => param(int(c, item)))))
        .t("))");
    } else {
      q.t(`${ref} ${op === "in" ? "= ANY" : "<> ALL"}(`)
        .v(
          (x as unknown[]).map((item) => int(c, item)),
          `${castOf(c)}[]`,
        )
        .t(")");
    }
  } else if (op === "startsWith" || op === "endsWith") {
    accept(c, x);
    // A LIKE pattern, as on 6 and 7: `%`, `_` and backslash keep their meaning.
    q.t(`${ref} LIKE (`);
    if (op === "endsWith") q.t("'%' || ");
    q.v(x, castOf(c));
    if (op === "startsWith") q.t(" || '%'");
    q.t(")");
  } else if (x === null && kindOf(c) !== JSONB) {
    accept(c, x, c.nullable && EQUALITY.includes(op));
    q.t(`${ref} IS ${op === "not" ? "NOT " : ""}NULL`);
  } else {
    q.t(`${ref} ${COMPARISONS[op]} `);
    bind(q, c, x);
  }
}

/** `ORDER BY`; a `take` with no order sorts by primary key, as on 6 and 7. */
function orderBy(q: Sql, m: Model, order: unknown, implicit: boolean) {
  const terms = [order ?? []].flat().flatMap((o) => {
    if (!isObject(o)) fail("an orderBy entry must be an object");
    const entries = Object.entries(o as Args);
    if (entries.length > 1) fail("each orderBy entry takes one column");
    return entries;
  });
  if (terms.length === 0 && implicit) {
    for (const name of m.primaryKey) terms.push([name, "asc"]);
  }
  if (terms.length === 0) return;
  q.t(
    ` ORDER BY ${terms
      .map(([name, direction]) => {
        column(m, name);
        if (direction !== "asc" && direction !== "desc") {
          fail(`orderBy ${name}: only "asc" and "desc" are supported`);
        }
        return `t0.${quote(name)} ${direction.toUpperCase()}`;
      })
      .join(", ")}`,
  );
}

/** The columns and the relations a `select` / `include` asks for. */
function pick(m: Model, select?: Args, include?: Args) {
  if (select && include) fail("select and include cannot be combined");
  if (select !== undefined && !isObject(select))
    fail("select must be an object");
  if (include !== undefined && !isObject(include)) {
    fail("include must be an object");
  }
  const cols: string[] = [];
  const relations: Array<[string, Args]> = [];
  const relate = (name: string, on: unknown) => {
    if (!isObject(on) || Object.keys(on).join() !== "select") {
      fail(`${m.name}.${name}: a relation takes only { select }`);
    }
    pick(m.relations[name]!.target, (on as Args).select);
    relations.push([name, on as Args]);
  };
  const all = Object.fromEntries(Object.keys(m.cols).map((n) => [n, true]));
  for (const [name, on] of Object.entries(select ?? all)) {
    if (on === undefined || on === false) continue;
    if (m.relations[name]) relate(name, on);
    else if (on !== true) fail(`select "${name}" must be true or false`);
    else if (m.cols[name]) cols.push(name);
    else fail(`${m.name} has no field "${name}"`);
  }
  if (cols.length + relations.length === 0) {
    fail(`${m.name}: select needs a field`);
  }
  for (const [name, on] of Object.entries(include ?? {})) {
    if (!m.relations[name]) fail(`${m.name} has no relation "${name}"`);
    if (on !== undefined && on !== false) relate(name, on);
  }
  return { cols, relations };
}

const FIND = ["where", "select", "include", "orderBy", "take"];

async function read(x: Executor, m: Model, args: Args, one = false) {
  const { cols, relations } = pick(m, args.select, args.include);
  const need = [
    ...new Set([
      ...cols,
      ...relations.map(([name]) => m.relations[name]!.on.localFields[0]!),
    ]),
  ];
  const q = new Sql().t(
    `SELECT ${need.map((n) => `t0.${quote(n)}`).join(", ")} FROM ${quote(m.table)} t0 WHERE `,
  );
  filtered(q, m, args.where);
  orderBy(q, m, args.orderBy, !one && args.take !== undefined);
  const take = one ? 1 : args.take;
  if (take !== undefined) {
    if (!Number.isFinite(take) || take < 0) fail("take must be 0 or more");
    q.t(` LIMIT ${Math.trunc(take)}`);
  }
  const rows = await rowsOf(x, q, specOf(m, need));
  for (const [name, on] of relations) await attach(x, m, rows, name, on);
  for (const row of rows) {
    for (const n of need) if (!cols.includes(n)) delete row[n];
  }
  return rows;
}

/** Loads a relation with one more query and hangs it on each parent row. */
async function attach(
  x: Executor,
  m: Model,
  rows: Row[],
  name: string,
  on: Args,
) {
  const relation = m.relations[name]!;
  const local = relation.on.localFields[0]!;
  const target = relation.on.targetFields[0]!;
  const keys = rows.map((r) => r[local]).filter((key) => key !== null);
  const children = await read(x, relation.target, {
    where: { [target]: { in: [...new Set(keys)] } },
    select: { ...on.select, [target]: true },
  });
  const byKey = new Map<unknown, Row[]>();
  for (const child of children) {
    byKey.set(child[target], [...(byKey.get(child[target]) ?? []), child]);
  }
  for (const row of rows) {
    const mine = byKey.get(row[local]) ?? [];
    row[name] = relation.cardinality === "1:N" ? mine : (mine[0] ?? null);
  }
  if (!on.select[target]) for (const child of children) delete child[target];
}

/**
 * `INSERT` statements for `data`, each within the database's bind limit
 * parameters (and of the arguments one call can spread): one statement unless
 * the rows need more. Every row is checked before any statement runs, and a
 * required column with no default has to be there, as on 6 and 7: left to the
 * database, `undefined` would be a NOT NULL violation, or no error at all
 * when an upsert never reaches its insert.
 */
function insert(m: Model, data: Row[]): Sql[] {
  const required = Object.keys(m.cols).filter(
    (n) => !m.cols[n]!.nullable && m.cols[n]!.default === undefined,
  );
  const rows = data.map((d) => {
    if (!isObject(d)) fail(`${m.name}: a row to create must be an object`);
    const row = { ...d };
    for (const [field, id] of Object.entries(m.onCreate)) {
      if (row[field] === undefined) row[field] = generate(id);
    }
    for (const n of required) {
      if (row[n] === undefined) fail(`${m.name}.${n} is required`);
    }
    return row;
  });
  const names = [
    ...new Set(
      rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined)),
    ),
  ];
  for (const n of names) column(m, n);
  const head = `INSERT INTO ${quote(m.table)} AS t0 (${names.map(quote).join(", ")}) VALUES `;
  const statements: Sql[] = [];
  let q = new Sql();
  for (const row of rows) {
    const one = new Sql().t("(");
    names.forEach((n, j) => {
      if (j) one.t(", ");
      if (row[n] === undefined && m.sqlite) {
        const c = m.cols[n]!;
        const d = c.default as
          | { kind?: string; value?: unknown; expression?: string }
          | undefined;
        if (d?.kind === "literal") {
          const numeric = [INT4, FLOAT8].includes(kindOf(c));
          one.v(numeric ? Number(d.value) : d.value);
        } else if (d?.kind === "function" && d.expression === "now()") {
          one.v(new Date());
        } else if (c.nullable) one.t("NULL");
        else fail(`${m.name}.${n}: unsupported SQLite default`);
      } else if (row[n] === undefined) one.t("DEFAULT");
      else bind(one, m.cols[n]!, row[n]);
    });
    one.t(")");
    if (
      statements.length === 0 ||
      q.values.length + one.values.length > (m.sqlite ? 32_766 : MAX_PARAMS)
    ) {
      statements.push((q = new Sql().t(head)));
    } else q.t(", ");
    q.add(one);
  }
  return statements;
}

/** The columns `data` changes: undefined leaves a column alone. */
function changes(data: unknown): Array<[string, unknown]> {
  if (!isObject(data)) fail("data must be an object");
  return Object.entries(data as Args).filter(([, v]) => v !== undefined);
}

/** `a = v, b = b + n`: plain values, `{ set }`, `{ increment }` and `{ decrement }`, plus `updatedAt`. */
function assignments(q: Sql, m: Model, data: Args) {
  const entries = changes(data);
  for (const [field, id] of Object.entries(m.onUpdate)) {
    if (data[field] === undefined) entries.push([field, generate(id)]);
  }
  entries.forEach(([name, value], i) => {
    const c = column(m, name);
    q.t(`${i ? ", " : ""}${quote(name)} = `);
    if (kindOf(c) === JSONB || !isObject(value)) return bind(q, c, value);
    const [[op, operand] = []] = Object.entries(value);
    const numeric = kindOf(c) === INT4 || kindOf(c) === FLOAT8;
    if (
      Object.keys(value).length !== 1 ||
      operand === undefined ||
      !(op === "set" || (numeric && /^(in|de)crement$/.test(op!)))
    ) {
      fail(`${m.name}.${name}: unsupported update`);
    }
    if (op !== "set") {
      accept(c, operand);
      q.t(`t0.${quote(name)} ${op === "increment" ? "+" : "-"} `);
    }
    bind(q, c, operand);
  });
}

function returning(q: Sql, m: Model, select?: Args): Record<string, string> {
  const { cols, relations } = pick(m, select);
  if (relations.length > 0) fail("a write cannot select a relation");
  q.t(` RETURNING ${cols.map(quote).join(", ")}`);
  return specOf(m, cols);
}

async function aggregate(x: Executor, m: Model, a: Args, by: string[] = []) {
  const parts: Array<{
    group?: string;
    field: string;
    sql: string;
    codec: string;
    alias: string;
  }> = by.map((f) => ({
    field: f,
    sql: `t0.${quote(f)}`,
    codec: codecOf(column(m, f)),
    alias: f,
  }));
  const add = (group: string, field: string, sql: string, codec: string) =>
    parts.push({ group, field, sql, codec, alias: `a${parts.length}` });
  if (a._count !== undefined) {
    if (
      !isObject(a._count) ||
      Object.keys(a._count).join() !== "_all" ||
      a._count._all !== true
    ) {
      fail("_count supports only { _all: true }");
    }
    add("_count", "_all", "count(*)", m.sqlite ? SQLITE_TYPES.bigint! : INT8);
  }
  for (const group of ["_min", "_max"]) {
    const fields = Object.entries(a[group] ?? {});
    if (a[group] !== undefined && fields.length === 0) {
      fail(`${group} needs a column`);
    }
    for (const [field, on] of fields) {
      const c = column(m, field);
      if (on !== true || kindOf(c) === JSONB) {
        fail(`${group} "${field}" is not supported`);
      }
      add(group, field, `${group.slice(1)}(t0.${quote(field)})`, codecOf(c));
    }
  }
  if (parts.length === 0) fail("an aggregate needs something to compute");
  const q = new Sql().t(
    `SELECT ${parts.map((p) => `${p.sql} AS ${quote(p.alias)}`).join(", ")} FROM ${quote(m.table)} t0 WHERE `,
  );
  filtered(q, m, a.where);
  if (by.length > 0)
    q.t(` GROUP BY ${by.map((f) => `t0.${quote(f)}`).join(", ")}`);
  const spec = Object.fromEntries(parts.map((p) => [p.alias, p.codec]));
  const rows = await rowsOf(x, q, spec);
  return rows.map((row) => {
    const out: Row = {};
    for (const p of parts) {
      if (!p.group) out[p.field] = row[p.alias];
      else {
        out[p.group] ??= {};
        out[p.group][p.field] =
          p.group === "_count" ? Number(row[p.alias]) : row[p.alias];
      }
    }
    return out;
  });
}

/**
 * Prisma 8 checks the database against the contract with the first statement a
 * client runs, on that statement's connection. A transaction that starts with
 * SET TRANSACTION ISOLATION LEVEL must not be that statement: the check's
 * queries would come first, and Postgres refuses the SET after a query (25001).
 * So the first one waits for a statement outside any transaction.
 */
const verified = new WeakMap<object, Promise<unknown>>();
function verify(db: Prisma8Db): Promise<unknown> {
  let done = verified.get(db);
  if (!done) {
    done = affected(db, new Sql().t("SELECT 1"));
    verified.set(db, done);
    done.catch(() => verified.delete(db));
  }
  return done;
}

/** Prisma's default `timeout` for `$transaction(fn)`. */
const DEFAULT_TIMEOUT = 5000;

/**
 * `timeout` as Prisma has it: a callback not settled by then rejects with
 * P2028, so the transaction rolls back and frees its connection, and every
 * further statement on its `tx` fails with P2028 too. On Postgres, 6 and 7 keep
 * the caller waiting for the callback, so one that fails after the deadline
 * gives its own error there and P2028 here; their SQLite adapters reject at the
 * deadline too.
 *
 * A statement running at the deadline holds its connection until it ends, and
 * the caller settles then: measured the same on 6, 7 and 8.
 */
function deadline(timeout: number | undefined) {
  if (timeout === undefined) {
    let closed = false;
    return {
      get closed() {
        return closed;
      },
      close() {
        closed = true;
      },
      check() {
        if (closed)
          throw Object.assign(new Error("Transaction already closed"), {
            code: "P2028",
          });
      },
      race: <T>(work: Promise<T>) => work,
    };
  }
  if (typeof timeout !== "number") fail("timeout must be a number");
  const end = Date.now() + timeout;
  // Set when the timer fires, so nothing slips through on clock rounding once
  // the rollback has begun.
  let closed = false;
  const expired = () => {
    closed = true;
    return Object.assign(
      new Error(`Transaction already closed: the ${timeout}ms timeout passed.`),
      { code: "P2028" },
    );
  };
  return {
    /** Set by a rollback only: a commit leaves it false past the deadline. */
    get closed() {
      return closed;
    },
    close() {
      closed = true;
    },
    check() {
      if (closed || Date.now() >= end) throw expired();
    },
    async race<T>(work: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // `work` losing is handled by the race: no unhandled rejection.
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(expired()),
              Math.min(maxTimerMs, Math.max(0, end - Date.now())),
            );
          }),
        ]);
      } catch (error) {
        closed = true;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

type Schedule = <T>(work: () => Promise<T>) => Promise<T>;
interface WriteQueue {
  tail: Promise<void>;
  /** Another client over the same driver owns the queue: use that one. */
  to?: WriteQueue;
  /** Turns queued and not yet settled (`enqueue`). */
  waiting?: number;
}
function followQueue<Q extends WriteQueue | undefined>(queue: Q): Q {
  let q = queue;
  while (q?.to) q = q.to as Q;
  return q;
}
const writeQueues = new WeakMap<object, WriteQueue>();
type WriteContext = Promise<
  AsyncLocalStorage<{
    queue?: WriteQueue;
    /** An adapter read (`rowsOf`), counted there. */
    read?: true;
    open?: ReturnType<typeof deadline>;
    /** Set by the queue's runner for the call whose turn it is (`inTurn`). */
    turn?: { active: boolean };
  }>
>;
// Two copies of this module (two engine packages in one process) wrapping the
// same client must see each other's queue turns: the context and each root
// driver's queue and read gate are process-wide.
const CONTEXT = Symbol.for("@bratsos/workflow-engine/prisma8-write-context");
const ROOT = Symbol.for("@bratsos/workflow-engine/prisma8-root");
// Load the Node context only for SQLite writes; other entry points and the
// Postgres path need no async_hooks at runtime.
const context = (): WriteContext =>
  ((globalThis as { [CONTEXT]?: WriteContext })[CONTEXT] ??= import(
    "node:async_hooks"
  ).then(({ AsyncLocalStorage }) => new AsyncLocalStorage()));

/** The queue and read gate of a root driver: every client over it shares them. */
type SharedRoot = { queue: WriteQueue; gate: ReadGate };
const sharedRoot = (driver: object | undefined): SharedRoot | undefined =>
  driver && (driver as { [ROOT]?: SharedRoot })[ROOT];

/**
 * Root connections of this process on one database file. node:sqlite waits
 * for a lock synchronously, on the event loop: a root's `BEGIN IMMEDIATE` or
 * COMMIT waiting for another root of the same process blocks the thread that
 * root needs to release it, for the whole busy timeout. So every root on a
 * file writes through one queue, and a write closes the reads of all of them.
 */
interface SharedFile {
  queue: WriteQueue;
  gates: Set<ReadGate>;
}
const FILES = Symbol.for("@bratsos/workflow-engine/prisma8-files");
const files = ((globalThis as { [FILES]?: Map<string, SharedFile> })[FILES] ??=
  new Map());

/** Joins the root to its file's queue and read gates; a memory or temporary database has no file. */
async function joinFile(
  query: RootDriver["query"],
  queue: WriteQueue,
  gate: ReadGate,
): Promise<void> {
  let file = "";
  try {
    for await (const row of query({ sql: "PRAGMA database_list", params: [] }))
      if ((row as { name?: string }).name === "main")
        file = String((row as { file?: unknown }).file ?? "");
  } catch {
    return; // a closed client: its own statement reports it
  }
  if (!file || gate.left) return;
  let shared = files.get(file);
  if (!shared) {
    shared = { queue, gates: new Set() };
    files.set(file, shared);
  }
  const target = followQueue(shared.queue);
  if (target !== followQueue(queue)) queue.to = target;
  shared.gates.add(gate);
  gate.file = shared.gates;
  const joined = shared;
  // A root opened later starts a new entry once the last root left and the
  // queue drained; until then it joins this one, behind the writes queued.
  const drop = () => {
    if (joined.gates.size || files.get(file) !== joined) return;
    const target = followQueue(joined.queue);
    if (target.waiting) void target.tail.then(drop);
    else files.delete(file);
  };
  gate.leave = () => {
    joined.gates.delete(gate);
    drop();
  };
}

function queueOf(db: object): WriteQueue {
  let queue = writeQueues.get(db);
  if (!queue) {
    queue = { tail: Promise.resolve() };
    writeQueues.set(db, queue);
  }
  return queue;
}

let warnedUnowned = false;

/**
 * At a client's first use, not at `fromPrisma8`: looking the driver up
 * (`db.runtime()`) starts the client's connection, which its own first query
 * would do too, so constructing the adapter changes nothing on the client.
 * A second client over the same driver shares the first one's queue and gate.
 */
function adopt(db: object): void {
  const gate = readGates.get(db);
  if (!gate || gate.adopted) return;
  let driver: RootDriver | undefined;
  try {
    driver = driverOf(db);
  } catch {
    return; // a closed client: its own statement reports it
  }
  gate.adopted = true;
  if (!driver) {
    if (!warnedUnowned) {
      warnedUnowned = true;
      logger.warn(
        "fromPrisma8: this Prisma 8 build exposes no root driver (db.runtime().driver), so statements sent through db.orm, db.sql, db.query or db.execute on the wrapped client are not coordinated with the engine's: on a rollback-journal file an engine commit can fail with `Transaction commit failed` while one of those reads is returning rows, a write sent there is not queued with the engine's, and raw BEGIN/SAVEPOINT through db.execute is not refused (engine writes after one join that transaction).",
      );
    }
    return;
  }
  const shared = sharedRoot(driver);
  if (shared) {
    writeQueues.get(db)!.to = shared.queue;
    gate.to = shared.gate;
    return;
  }
  ownRootConnection(driver, writeQueues.get(db)!, gate);
}

async function enqueue<T>(
  input: WriteQueue,
  work: () => Promise<T>,
): Promise<T> {
  const queue = followQueue(input);
  const store = await context();
  const owner = store.getStore();
  const open = owner?.queue === queue ? owner.open : undefined;
  // A turn queued behind another first yields a macrotask: node:sqlite runs
  // each statement synchronously, so turns chained on microtasks alone would
  // hold the event loop (timers, I/O) until the whole queue drained.
  const behind = (queue.waiting ?? 0) > 0;
  queue.waiting = (queue.waiting ?? 0) + 1;
  const pending = queue.tail.then(async () => {
    if (behind) await new Promise<void>((resolve) => setImmediate(resolve));
    // A root write awaited by its own transaction cannot acquire this queue.
    // Its transaction times out and rolls back; the stale write must not run.
    // Any other write only waited here, whatever became of the transaction
    // ahead of it.
    if (open?.closed) throw rolledBackWrite();
    const turn = { active: true };
    try {
      return await store.run({ queue, open, turn }, work);
    } finally {
      turn.active = false;
    }
  });
  pending.then(
    () => queue.waiting!--,
    () => queue.waiting!--,
  );
  queue.tail = pending.then(
    () => {},
    () => {},
  );
  return pending;
}

// Opening a transaction on the root is refused; ending one never is (`ROLLBACK
// TO` and `RELEASE` included), whatever opened it.
const OPENS_TRANSACTION = /^(BEGIN|SAVEPOINT)$/;
const ENDS_TRANSACTION = /^(COMMIT|END|ROLLBACK|RELEASE)$/;

interface DriverRequest {
  sql: string;
  params: unknown[];
}
interface RootDriver {
  query(request: DriverRequest): AsyncIterable<unknown>;
  execute(request: DriverRequest): Promise<unknown>;
  close?(...args: unknown[]): unknown;
}

function driverOf(db: object): RootDriver | undefined {
  const driver = (
    db as { runtime?: () => { driver?: Partial<RootDriver> } }
  ).runtime?.()?.driver;
  return typeof driver?.query === "function" &&
    typeof driver.execute === "function"
    ? (driver as RootDriver)
    : undefined;
}

/**
 * Every statement on the root connection, whatever API sends it (this
 * adapter, `db.orm`, `db.sql`, `db.query`, a prepared statement), reaches the
 * runtime's driver. The adapter takes that call over, so a read is counted and
 * waits while a write waits for the reads, and a statement that may write runs
 * in the write queue, as the adapter's own do. `runtime().driver` is not typed
 * by Prisma 8 (rc.21): without it the adapter sees only its own reads, as the
 * docs state (and `adopt` warns).
 */
function ownRootConnection(
  driver: RootDriver,
  queue: WriteQueue,
  gate: ReadGate,
): void {
  Object.defineProperty(driver, ROOT, { value: { queue, gate } });
  // `db.close()` closes the driver: the root leaves its file's registry.
  const close = driver.close;
  if (typeof close === "function")
    driver.close = function (...args) {
      gate.left = true;
      gate.leave?.();
      // Closing the connection ends its transaction: writers waiting on it go.
      const foreign = gate.foreign;
      gate.foreign = undefined;
      foreign?.end();
      return close.apply(this, args);
    };
  const query = driver.query.bind(driver);
  const execute = driver.execute.bind(driver);
  const exec = (sql: string) => execute({ sql, params: [] });
  // The driver keeps its connection private: read the state from it. A
  // deferred BEGIN takes no lock, and fails only inside a transaction.
  const inside = async () => {
    try {
      await exec("BEGIN");
    } catch (error) {
      if (/within a transaction/.test(String((error as Error)?.message)))
        return true;
      return false; // e.g. a closed client: its own next statement says so
    }
    await exec("COMMIT");
    return false;
  };
  gate.recheck = async () => {
    if (!gate.foreign || (await inside())) return;
    const { end } = gate.foreign;
    gate.foreign = undefined;
    end();
  };
  // In a queue turn, so no adapter write of this root is half-done meanwhile;
  // inline when already in one, which a queued probe would wait behind.
  const probe = async () => {
    const one = async (sql: string) => {
      for await (const row of query({ sql, params: [] }))
        return row as Record<string, unknown>;
      return undefined;
    };
    const mode = await one("PRAGMA journal_mode");
    if (String(mode?.journal_mode).toLowerCase() !== "wal") return false;
    const timeout = Number((await one("PRAGMA busy_timeout"))?.timeout);
    await one("PRAGMA busy_timeout = 0");
    try {
      await exec("BEGIN IMMEDIATE");
      await exec("ROLLBACK");
      return true;
    } catch {
      return false;
    } finally {
      await one(
        `PRAGMA busy_timeout = ${Number.isFinite(timeout) ? timeout : READ_WAIT_MS}`,
      ).catch(() => {});
    }
  };
  gate.writable = async () =>
    (await own()) === true ? probe() : enqueue(queue, probe);
  gate.ready = inside().then(async (yes) => {
    await joinFile(query, queue, gate);
    if (!yes) return;
    let end!: () => void;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    gate.foreign = { ended, end };
  });
  const own = async () => {
    const store = (await context()).getStore();
    if (store?.read) return "adapter read";
    return Boolean(store?.turn?.active && store.queue === followQueue(queue));
  };
  const classify = (sql: string) => {
    const statement = statementOf(new Sql().t(sql));
    if (OPENS_TRANSACTION.test(statement.first ?? "") && !gate.foreign)
      fail(
        `${statement.first} on the root client: other callers' writes would join it. Use $transaction`,
      );
    return statement;
  };
  // A write sent around the adapter, as `rootWrite` runs one: in a lock it
  // takes cleanly.
  const write = async (request: DriverRequest) => {
    const rows: unknown[] = [];
    const all = async () => {
      for await (const row of query(request)) rows.push(row);
      return rows;
    };
    const statement = classify(request.sql);
    try {
      if (statement.first === "PRAGMA") return await all();
      await exec("BEGIN IMMEDIATE");
      try {
        await all();
        await exec("COMMIT");
        return rows;
      } catch (error) {
        await exec("ROLLBACK").catch(() => {});
        throw error;
      }
    } finally {
      if (mayChangeJournalMode(statement))
        await exec(DROP_CACHE).catch(() => {});
    }
  };
  driver.query = (request) => ({
    [Symbol.asyncIterator]() {
      let rows: AsyncIterator<unknown> | Iterator<unknown> | undefined;
      let counted = false;
      const end = () => {
        if (!counted) return;
        counted = false;
        gate.reading--;
        gate.progress++;
        gate.ended?.();
      };
      return {
        async next() {
          if (!rows) {
            await gate.ready;
            const mine = await own();
            if (mine === "adapter read")
              rows = query(request)[Symbol.asyncIterator]();
            else if (!mine && gate.foreign) {
              // Inside the consumer's own transaction, as without this layer:
              // no engine write runs on the root meanwhile (`untilOwnRoot`).
              const it = query(request)[Symbol.asyncIterator]();
              rows = {
                next: () =>
                  it.next().then(
                    async (step) => (
                      step.done && (await gate.recheck?.()), step
                    ),
                    async (error) => {
                      await gate.recheck?.();
                      throw error;
                    },
                  ),
                return: (value?: unknown) =>
                  it.return?.(value) ??
                  Promise.resolve({ done: true as const, value }),
              };
            } else if (!mine && !classify(request.sql).read) {
              rows = (
                await enqueue(queue, () =>
                  othersClosed(gate, () => write(request)),
                )
              )[Symbol.iterator]();
            } else {
              if (!mine) while (gate.closed) await gate.closed;
              gate.reading++;
              gate.progress++;
              counted = true;
              rows = query(request)[Symbol.asyncIterator]();
            }
          }
          if (counted) gate.progress++;
          try {
            const step = await rows.next();
            if (step.done) end();
            return step;
          } catch (error) {
            end();
            throw error;
          }
        },
        async return(value?: unknown) {
          end();
          await rows?.return?.(value);
          return { done: true as const, value };
        },
      };
    },
  });
  driver.execute = async (request) => {
    await gate.ready;
    if ((await own()) === true) return execute(request);
    classify(request.sql);
    if (gate.foreign) return execute(request).finally(() => gate.recheck?.());
    return enqueue(queue, () =>
      othersClosed(gate, () => execute(request)).catch((error: unknown) =>
        afterStaleSnapshot(gate, error, () => execute(request)),
      ),
    );
  };
}

const READS = new Set([
  "findMany",
  "findFirst",
  "findUnique",
  "count",
  "aggregate",
  "groupBy",
]);

// ============================================================================
// Lazy operations and delegates
// ============================================================================

/**
 * A delegate call that runs when awaited, like Prisma's, or on a transaction's
 * connection when passed to `$transaction([...])`.
 */
class Op {
  private promise?: Promise<any>;

  constructor(
    readonly exec: (x: Executor) => Promise<any>,
    private readonly home: Executor,
    private readonly schedule?: Schedule,
  ) {}

  private run() {
    return (this.promise ??= this.schedule
      ? this.schedule(() => this.exec(this.home))
      : (async () => this.exec(this.home))());
  }
  then(...args: Parameters<Promise<any>["then"]>) {
    return this.run().then(...args);
  }
  catch(...args: Parameters<Promise<any>["catch"]>) {
    return this.run().catch(...args);
  }
  finally(...args: Parameters<Promise<any>["finally"]>) {
    return this.run().finally(...args);
  }
}

function delegate(x: Executor, m: Model, schedule?: Schedule) {
  const op =
    (
      name: string,
      allowed: string[],
      run: (e: Executor, a: Args) => Promise<unknown>,
    ) =>
    (args: Args = {}) =>
      new Op(
        (e) => {
          check(name, args, allowed);
          return run(e, args);
        },
        x,
        READS.has(name) ? undefined : schedule,
      );
  const mustChange = async (e: Executor, q: Sql, select?: Args) => {
    const [row] = await rowsOf(e, q, returning(q, m, select));
    if (!row) throw notFound();
    return row;
  };
  // UPDATE and DELETE are aliased `t0`, like a read, so `where` is shared.
  const head = (verb: string, tail = "") =>
    new Sql().t(`${verb} ${quote(m.table)} AS t0${tail}`);
  const filter = (q: Sql, w: unknown) => {
    q.t(" WHERE ");
    filtered(q, m, w);
    return q;
  };
  // Compiled apart from running, so `upsert` rejects bad arguments before any
  // SQL. With nothing to change it only reads: as on 6 and 7, `updatedAt` stays.
  const updateOne = (w: Args, data: Args, select?: Args) => {
    if (changes(data).length === 0) {
      return (e: Executor) => read(e, m, { where: w, select }, true);
    }
    const q = head("UPDATE", " SET ");
    assignments(q, m, data);
    const columns = returning(filter(q, w), m, select);
    return (e: Executor) => rowsOf(e, q, columns);
  };
  return {
    findMany: op("findMany", FIND, (e, a) => read(e, m, a)),
    findFirst: op("findFirst", FIND, async (e, a) => {
      if (a.take !== undefined && a.take !== 1) {
        fail("findFirst does not support a take other than 1");
      }
      return (await read(e, m, a, true))[0] ?? null;
    }),
    findUnique: op(
      "findUnique",
      ["where", "select", "include"],
      async (e, a) =>
        (await read(e, m, { ...a, ...uniqueWhere(m, a.where) }, true))[0] ??
        null,
    ),
    create: op("create", ["data"], async (e, a) => {
      const [q] = insert(m, [a.data]) as [Sql];
      const [row] = await rowsOf(e, q, returning(q, m));
      return row;
    }),
    createMany: op("createMany", ["data", "skipDuplicates"], async (e, a) => {
      if (!Array.isArray(a.data)) fail("createMany takes an array of rows");
      if (a.data.length === 0) return { count: 0 };
      const statements = insert(m, a.data);
      if (a.skipDuplicates) {
        for (const q of statements) q.t(" ON CONFLICT DO NOTHING");
      }
      const run = async (x: Executor) => {
        let count = 0;
        for (const q of statements) count += await affected(x, q);
        return { count };
      };
      // Atomic, as one statement is on 6 and 7: on a root client the chunks
      // share a transaction, inside a `tx` they use it.
      return statements.length > 1 &&
        typeof (e as Partial<Prisma8Db>).transaction === "function"
        ? transactionOf(e as Prisma8Db, run)
        : run(e);
    }),
    update: op("update", ["where", "data", "select"], async (e, a) => {
      const run = updateOne(uniqueWhere(m, a.where).where, a.data, a.select);
      const [row] = await run(e);
      if (!row) throw notFound();
      return row;
    }),
    updateMany: op("updateMany", ["where", "data"], async (e, a) => {
      // 6 counts no rows here and 7 the rows matched, so neither can be matched.
      if (changes(a.data).length === 0) fail("updateMany needs data");
      const q = head("UPDATE", " SET ");
      assignments(q, m, a.data);
      return { count: await affected(e, filter(q, a.where)) };
    }),
    upsert: op(
      "upsert",
      ["where", "create", "update", "select"],
      async (e, a) => {
        const { where: flat, keys } = uniqueWhere(m, a.where);
        const key = keys[0]!;
        if (
          keys.length > 1 ||
          Object.keys(flat).length !== Object.keys(key).length
        ) {
          fail(`${m.name}: upsert takes one unique key and no other filter`);
        }
        const names = Object.keys(key);
        const [insertion] = insert(m, [a.create]) as [Sql];
        if (
          changes(a.update).length > 0 &&
          names.every((n) => a.create[n] === key[n])
        ) {
          // Atomic, which concurrent upserts of one key depend on.
          insertion.t(
            ` ON CONFLICT (${names.map(quote).join(", ")}) DO UPDATE SET `,
          );
          assignments(insertion, m, a.update);
          return mustChange(e, insertion, a.select);
        }
        // As on 6 and 7: `where` picks the row, `create` is the row to add if
        // there is none, and losing a race to add it is a unique violation.
        const run = updateOne(flat, a.update, a.select);
        const columns = returning(insertion, m, a.select);
        const [row] = await run(e);
        return row ?? (await rowsOf(e, insertion, columns))[0];
      },
    ),
    delete: op("delete", ["where", "select"], (e, a) =>
      mustChange(
        e,
        filter(head("DELETE FROM"), uniqueWhere(m, a.where).where),
        a.select,
      ),
    ),
    deleteMany: op("deleteMany", ["where"], async (e, a) => ({
      count: await affected(e, filter(head("DELETE FROM"), a.where)),
    })),
    count: op("count", ["where"], async (e, a) => {
      const q = new Sql().t(
        `SELECT count(*) AS n FROM ${quote(m.table)} t0 WHERE `,
      );
      filtered(q, m, a.where);
      const [row] = await rowsOf(e, q, {
        n: m.sqlite ? SQLITE_TYPES.bigint! : INT8,
      });
      return Number(row!.n);
    }),
    aggregate: op(
      "aggregate",
      ["where", "_count", "_min", "_max"],
      async (e, a) => (await aggregate(e, m, a))[0],
    ),
    groupBy: op(
      "groupBy",
      ["by", "where", "_count", "_min", "_max"],
      async (e, a) => {
        if (!Array.isArray(a.by) || a.by.length === 0) {
          fail("groupBy needs a list of columns");
        }
        return aggregate(e, m, a, a.by);
      },
    ),
  };
}

// ============================================================================
// The client
// ============================================================================

function describe(contract: Contract): Record<string, Model> {
  const sqlite = contract.target === "sqlite";
  const namespace = sqlite ? "__unbound__" : "public";
  const { table: tables, native_enum: enums } =
    contract.storage.namespaces[namespace]!.entries;
  const models: Record<string, Model> = {};
  for (const [name, model] of Object.entries(
    contract.domain.namespaces[namespace]!.models,
  )) {
    const table = tables[model.storage.table]!;
    const keys = new Map([
      [table.primaryKey.columns.join("_"), table.primaryKey.columns],
    ]);
    for (const index of table.indexes) {
      if (index.unique) keys.set(index.columns.join("_"), index.columns);
    }
    for (const unique of table.uniques ?? []) {
      keys.set(unique.columns.join("_"), unique.columns);
    }
    models[name] = {
      sqlite,
      name,
      table: model.storage.table,
      cols: Object.fromEntries(
        Object.entries(table.columns).map(([n, c]) => [
          n,
          { ...c, members: enums?.[c.typeParams?.typeName ?? ""]?.members },
        ]),
      ),
      primaryKey: table.primaryKey.columns,
      keys,
      relations: {},
      onCreate: {},
      onUpdate: {},
    };
  }
  const byTable = Object.fromEntries(
    Object.values(models).map((m) => [m.table, m]),
  );
  for (const [name, model] of Object.entries(
    contract.domain.namespaces[namespace]!.models,
  )) {
    for (const [field, relation] of Object.entries(model.relations)) {
      models[name]!.relations[field] = {
        ...relation,
        target: models[relation.to.model]!,
      };
    }
  }
  for (const d of contract.execution?.mutations?.defaults ?? []) {
    const m = byTable[d.ref.entry];
    if (d.onCreate && m) m.onCreate[d.ref.field] = d.onCreate.id;
    if (d.onUpdate && m) m.onUpdate[d.ref.field] = d.onUpdate.id;
  }
  return models;
}

/** Throws, naming the fix, when the contract cannot carry the engine's raw SQL. */
function validate(models: Record<string, Model>) {
  const byTable = Object.fromEntries(
    Object.values(models).map((m) => [m.table, m]),
  );
  for (const table of REQUIRED_TABLES) {
    if (!byTable[table]) {
      fail(
        `the contract has no model for the engine table "${table}". Copy the engine's models from @bratsos/workflow-engine/prisma/contract.prisma into your contract.`,
      );
    }
  }
  for (const table of [...REQUIRED_TABLES, ...OPTIONAL_TABLES]) {
    const timestamp = byTable[table]?.sqlite
      ? SQLITE_TYPES.timestamp
      : TIMESTAMP;
    for (const [name, c] of Object.entries(byTable[table]?.cols ?? {})) {
      if (/time|date/i.test(c.codecId) && c.codecId !== timestamp) {
        fail(
          byTable[table]!.sqlite
            ? `${table}.${name} uses ${c.codecId}. Declare timestamps as DateTime in the SQLite contract.`
            : `${table}.${name} uses ${c.codecId}. Declare timestamps as TimestampString(3), as in contract.prisma: the engine's raw SQL needs naive UTC timestamp columns.`,
        );
      }
    }
  }
  for (const table of ["workflow_runs", "workflow_stages", "job_queue"]) {
    const model = byTable[table]!;
    if (model.sqlite) {
      if (model.cols.status?.codecId !== SQLITE_TYPES.text) {
        fail(`${table}.status must be String in the SQLite contract.`);
      }
    } else if (model.cols.status?.codecId !== ENUM) {
      fail(
        `${table}.status must be a native Postgres enum named "Status" (native_enum Status and pg.enum(Status), as in contract.prisma): the engine's raw SQL casts to ::"Status".`,
      );
    }
  }
}

/** The models of a contract, checked once per contract object. */
const described = new WeakMap<object, Record<string, Model>>();
function modelsOf(contract: object): Record<string, Model> {
  let models = described.get(contract);
  if (!models) {
    models = describe(contract as Contract);
    validate(models);
    described.set(contract, models);
  }
  return models;
}

export function fromPrisma8(db: Prisma8Db): Prisma8Client;
export function fromPrisma8(
  tx: Prisma8Tx,
  options: { contract: unknown },
): Prisma8Client;
export function fromPrisma8(
  db: Prisma8Db | Prisma8Tx,
  options?: { contract: unknown },
): Prisma8Client {
  const contract = options?.contract ?? (db as Partial<Prisma8Db>)?.contract;
  if (typeof contract !== "object" || contract === null) {
    fail(
      "expected a Prisma 8 client from postgres({ contract, url }) or sqlite({ contract, path }), or a transaction's tx with { contract: db.contract }",
    );
  }
  const c = contract as Partial<Contract>;
  if (c.target !== "postgres" && c.target !== "sqlite") {
    fail(
      `unsupported contract target "${c.target}"; expected postgres or sqlite`,
    );
  }
  const sqlite = c.target === "sqlite";
  const namespace = sqlite ? "__unbound__" : "public";
  if (
    !c.storage?.namespaces?.[namespace] ||
    !c.domain?.namespaces?.[namespace]
  ) {
    fail(
      `the engine's models must be in the contract's \`${namespace}\` namespace: its raw SQL does not qualify table names. Move them out of any other namespace in your contract.`,
    );
  }
  const models = modelsOf(contract as object);
  const byTable = Object.fromEntries(
    Object.values(models).map((m) => [m.table, m]),
  );
  const root = typeof (db as Partial<Prisma8Db>).transaction === "function";
  const queue = sqlite && root ? queueOf(db) : undefined;
  if (queue && !readGates.has(db))
    readGates.set(db, { reading: 0, adapter: 0, progress: 0 });
  const delegates = new WeakMap<Executor, Record<string, unknown>>();

  const client = (
    x: Executor,
    inTransaction: boolean,
    columns?: RawColumns,
  ): Prisma8Client => {
    const schedule: Schedule | undefined =
      queue && !inTransaction
        ? (work) => (
            adopt(db), untilOwnRoot(db).then(() => enqueue(queue, work))
          )
        : undefined;
    if (!delegates.has(x)) {
      delegates.set(
        x,
        Object.fromEntries(
          Object.values(models).map((m) => [
            m.name[0]!.toLowerCase() + m.name.slice(1),
            delegate(x, m, schedule),
          ]),
        ),
      );
    }

    const spec = (): Record<string, string> => {
      if (columns === undefined) {
        fail(
          'a raw read must declare its result columns: run it on client.$withColumns({ name: "text" }), or client.$withColumns("table_name") for every column of a table',
        );
      }
      if (typeof columns === "string") {
        const m = byTable[columns] ?? fail(`unknown table "${columns}"`);
        return specOf(m, Object.keys(m.cols));
      }
      return Object.fromEntries(
        Object.entries(columns!).map(([n, t]) => [
          n,
          (sqlite ? SQLITE_TYPES : RAW_TYPES)[t] ??
            fail(`unknown raw column type "${t}"`),
        ]),
      );
    };
    const read = async (q: Sql, e = x) => {
      const rows = await rowsOf(e, q, spec());
      if (sqlite && typeof columns === "object") {
        for (const row of rows)
          for (const [name, type] of Object.entries(columns)) {
            if (type === "bool" && row[name] !== null)
              row[name] = Boolean(row[name]);
          }
      }
      return rows;
    };
    const control = (q: Sql) => {
      if (
        queue &&
        !inTransaction &&
        OPENS_TRANSACTION.test(statementOf(q).first ?? "") &&
        !gateOf(db)?.foreign
      )
        fail(
          `${statementOf(q).first} on the root client: other callers' writes would join it. Use $transaction`,
        );
      return q;
    };
    // Ending a transaction must not wait for it to end (`untilOwnRoot`).
    const ending = (work: () => Promise<any>) => (
      adopt(db), enqueue(queue!, work).finally(() => gateOf(db)?.recheck?.())
    );
    const rawRead = (q: Sql) =>
      control(q) && sqlite
        ? new Op(
            (e) => read(q, e),
            x,
            statementOf(q).read
              ? undefined
              : schedule && ENDS_TRANSACTION.test(statementOf(q).first ?? "")
                ? ending
                : schedule,
          )
        : read(q);
    const rawWrite = (q: Sql) =>
      control(q) && sqlite
        ? new Op(
            (e) => affected(e, q),
            x,
            schedule && ENDS_TRANSACTION.test(statementOf(q).first ?? "")
              ? ending
              : schedule,
          )
        : affected(x, q);

    const transaction = async (arg: any, options: Args = {}) => {
      check("$transaction", options, ["isolationLevel", "timeout"]);
      const callback = typeof arg === "function";
      const level = options.isolationLevel
        ? (ISOLATION[options.isolationLevel] ??
          fail(`unknown isolation level "${options.isolationLevel}"`))
        : undefined;
      if (sqlite && level && options.isolationLevel !== "Serializable") {
        fail(
          "SQLite transactions support only the Serializable isolation level",
        );
      }
      if (level && !sqlite) await verify(db as Prisma8Db);
      const run = async () => {
        let open: ReturnType<typeof deadline> | undefined;
        try {
          return await transactionOf(db as Prisma8Db, async (raw: Executor) => {
            const lease = deadline(
              options.timeout ?? (callback ? DEFAULT_TIMEOUT : undefined),
            );
            open = lease;
            const tx: Executor = {
              raw: raw.raw,
              query: (plan) => (lease.check(), raw.query(plan)),
              execute: (plan) => (lease.check(), raw.execute(plan)),
            };
            const work = async () => {
              if (level && !sqlite) {
                await affected(
                  raw,
                  new Sql().t(`SET TRANSACTION ISOLATION LEVEL ${level}`),
                );
              }
              if (callback) {
                const result = await arg(client(tx, true));
                lease.check();
                return result;
              }
              const results: unknown[] = [];
              for (const op of arg) {
                if (!(op instanceof Op))
                  fail(
                    sqlite
                      ? "$transaction([...]) takes lazy client calls only"
                      : "$transaction([...]) takes delegate calls only",
                  );
                results.push(await op.exec(tx));
              }
              return results;
            };
            if (!queue) return lease.race(work());
            return (await context()).run(
              { queue: followQueue(queue), open: lease },
              () => lease.race(work()),
            );
          });
        } catch (error) {
          open?.close();
          throw error;
        }
      };
      return schedule ? schedule(run) : run();
    };

    return {
      get $databaseType() {
        return sqlite ? "sqlite" : "postgresql";
      },
      // A storage check that reads inside the consumer's transaction is not remembered.
      get [UNCOMMITTED_READS]() {
        return !inTransaction && Boolean(gateOf(db)?.foreign);
      },
      ...delegates.get(x),
      $inTransaction: inTransaction,
      ...(inTransaction || !root ? {} : { $transaction: transaction }),
      $queryRaw: (strings: TemplateStringsArray, ...values: any[]) =>
        rawRead(template(strings, values, sqlite)),
      $queryRawUnsafe: (text: string, ...values: any[]) =>
        rawRead(positional(text, values, sqlite)),
      $executeRaw: (strings: TemplateStringsArray, ...values: any[]) =>
        rawWrite(template(strings, values, sqlite)),
      $executeRawUnsafe: (text: string, ...values: any[]) =>
        rawWrite(positional(text, values, sqlite)),
      $withColumns: (c: RawColumns) => client(x, inTransaction, c),
    } as unknown as Prisma8Client;
  };

  return client(db, !root);
}
