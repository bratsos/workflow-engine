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
 * one SQL statement through the client's raw lane, using the column types in
 * `db.contract`. Every argument shape it accepts behaves as it does on Prisma 6
 * and 7 (see the "argument parity" cases of the Postgres conformance suite);
 * anything else throws before any SQL runs, so it is never ignored or coerced.
 *
 * - Delegates are lazy: a call runs when awaited, or inside `$transaction([...])`.
 * - Timestamps are `pg/timestamp-string@1` (UTC text without a zone): `Date`
 *   in becomes ISO text, text out becomes `Date`.
 * - Raw reads must declare their columns (see `rawFor`), since Prisma 8 drops
 *   the ones they do not.
 * - Postgres only.
 *
 * Imports nothing from Prisma, like the rest of the package.
 */

import type { BlobPrismaClient } from "./blob-store";
import type { EnginePrismaClient, RawColumns } from "./prisma-client-type";

type Row = Record<string, any>;
type Args = Record<string, any>;

interface Column {
  codecId: string;
  nullable: boolean;
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
  storage: {
    namespaces: {
      public: {
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
      public: {
        models: Record<
          string,
          { relations: Record<string, Relation>; storage: { table: string } }
        >;
      };
    };
  };
  execution: {
    mutations: {
      defaults: Array<{
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
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
  $withColumns(columns: RawColumns): Prisma8Client;
}

interface Model {
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
function param(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return arrayLiteral(value);
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
 */
class Sql {
  readonly parts = [""];
  readonly values: unknown[] = [];

  t(text: string): this {
    this.parts[this.parts.length - 1] += text;
    return this;
  }

  /** A parameter, followed by `suffix` (a cast such as `::text`). */
  v(value: unknown, suffix = ""): this {
    const bound = param(value);
    if (bound == null) return this.t(`NULL${suffix}`);
    this.values.push(bound);
    this.parts.push(suffix);
    return this;
  }
}

/** Text with `$1`..`$n` placeholders: a repeated `$n` binds its value at each occurrence. */
function positional(text: string, values: unknown[]): Sql {
  const pieces = text.split(/\$(\d+)/);
  const q = new Sql().t(pieces[0]!);
  for (let i = 1; i < pieces.length; i += 2) {
    const index = Number(pieces[i]);
    if (index < 1 || index > values.length) {
      fail(`parameter $${index} has no value`);
    }
    q.v(values[index - 1]).t(pieces[i + 1]!);
  }
  return q;
}

function template(strings: readonly string[], values: unknown[]): Sql {
  const q = new Sql();
  strings.forEach((text, i) => {
    q.t(text);
    if (i < values.length) q.v(values[i]);
  });
  return q;
}

const toPlan = (x: Executor, q: Sql) =>
  x.raw.sql(Object.assign(q.parts, { raw: q.parts }), ...q.values);

const affected = async (x: Executor, q: Sql): Promise<number> =>
  (await x.execute(toPlan(x, q).affectedCount().build())).affectedRows;

/** Rows for `spec` (column -> codec id); timestamps come back as `Date`. */
async function rowsOf(
  x: Executor,
  q: Sql,
  spec: Record<string, string>,
): Promise<Row[]> {
  const rows = await x.query(toPlan(x, q).returnsRow(spec).build()).toArray();
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
  if (c.codecId === ENUM) return `::"${c.typeParams?.typeName}"`;
  return `::${SQL_TYPES[c.codecId] ?? fail(`unsupported column codec ${c.codecId}`)}`;
}

const specOf = (m: Model, names: string[]) =>
  Object.fromEntries(names.map((n) => [n, codecOf(m.cols[n]!)]));

/** The values Prisma takes for each column type; a SQL cast would coerce others. */
const ACCEPTS: Record<string, (value: any, c: Column) => boolean> = {
  [TEXT]: (v) => typeof v === "string",
  [INT4]: (v) => Number.isInteger(v) && Math.abs(v) < 2 ** 31,
  [FLOAT8]: (v) => Number.isFinite(v),
  [TIMESTAMP]: (v) => v instanceof Date && !Number.isNaN(v.getTime()),
  [ENUM]: (v, c) => c.members?.includes(v) === true,
};

function accept(c: Column, value: unknown, nullable = false): void {
  if (value === null ? !nullable : !ACCEPTS[c.codecId]?.(value, c)) {
    fail(`invalid value for a ${c.codecId} column`);
  }
}

/** A value written to, or compared with, column `c`. */
function bind(q: Sql, c: Column, value: unknown): void {
  // A JS null is the JSON value null on a JSON column, as on 6 and 7.
  if (c.codecId === JSONB) q.v(JSON.stringify(value), castOf(c));
  else {
    accept(c, value, c.nullable);
    q.v(value, castOf(c));
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
    if (c.codecId === JSONB && !isObject(v)) {
      fail(`${m.name}.${key}: a JSON filter must be an object`);
    }
    const ops: Args = isObject(v) ? v : { equals: v };
    if ("path" in ops) {
      if (
        c.codecId !== JSONB ||
        Object.keys(ops).sort().join() !== "equals,path" ||
        !Array.isArray(ops.path) ||
        ops.path.some((part) => typeof part !== "string")
      ) {
        fail(`${m.name}.${key}: only { path, equals } is supported on JSON`);
      }
      q.t(`(${ref} #> `)
        .v(ops.path, "::text[]")
        .t(") = ")
        .v(JSON.stringify(ops.equals), "::jsonb");
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
  [TEXT]: [...ORDERED, "startsWith"],
  [INT4]: ORDERED,
  [FLOAT8]: ORDERED,
  [TIMESTAMP]: ORDERED,
  [ENUM]: LISTED,
  [JSONB]: EQUALITY,
};

function operator(q: Sql, c: Column, ref: string, op: string, x: unknown) {
  if (!OPERATORS[c.codecId]?.includes(op)) {
    fail(`unsupported filter operator "${op}" on a ${c.codecId} column`);
  }
  if (op === "in" || op === "notIn") {
    if (!Array.isArray(x)) fail(`${op} needs an array`);
    for (const item of x as unknown[]) accept(c, item);
    q.t(`${ref} ${op === "in" ? "= ANY" : "<> ALL"}(`)
      .v(x, `${castOf(c)}[]`)
      .t(")");
  } else if (op === "startsWith") {
    accept(c, x);
    // A LIKE pattern, as on 6 and 7: `%`, `_` and backslash keep their meaning.
    q.t(`${ref} LIKE (`).v(x, "::text").t(" || '%')");
  } else if (x === null && c.codecId !== JSONB) {
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
    if (!Number.isInteger(take) || take < 0) fail("take must be 0 or more");
    q.t(` LIMIT ${take}`);
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

function insert(m: Model, data: Row[]): Sql {
  const rows = data.map((d) => {
    if (!isObject(d)) fail(`${m.name}: a row to create must be an object`);
    const row = { ...d };
    for (const [field, id] of Object.entries(m.onCreate)) {
      if (row[field] === undefined) row[field] = generate(id);
    }
    return row;
  });
  const names = [
    ...new Set(
      rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined)),
    ),
  ];
  for (const n of names) column(m, n);
  const q = new Sql().t(
    `INSERT INTO ${quote(m.table)} AS t0 (${names.map(quote).join(", ")}) VALUES `,
  );
  rows.forEach((row, i) => {
    q.t(i ? ", (" : "(");
    names.forEach((n, j) => {
      if (j) q.t(", ");
      if (row[n] === undefined) q.t("DEFAULT");
      else bind(q, m.cols[n]!, row[n]);
    });
    q.t(")");
  });
  return q;
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
    if (c.codecId === JSONB || !isObject(value)) return bind(q, c, value);
    const [[op, operand] = []] = Object.entries(value);
    const numeric = c.codecId === INT4 || c.codecId === FLOAT8;
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
    add("_count", "_all", "count(*)", INT8);
  }
  for (const group of ["_min", "_max"]) {
    const fields = Object.entries(a[group] ?? {});
    if (a[group] !== undefined && fields.length === 0) {
      fail(`${group} needs a column`);
    }
    for (const [field, on] of fields) {
      const c = column(m, field);
      if (on !== true || c.codecId === JSONB) {
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

/** Prisma's default `timeout` for `$transaction(fn)`. */
const DEFAULT_TIMEOUT = 5000;

/**
 * `timeout` as Prisma has it: once it has passed, every further statement, and
 * the end of the callback, fails with P2028, so the transaction rolls back.
 *
 * shortcut: a statement running at the deadline, or a callback that never
 * returns, holds its connection until it ends (6 and 7 reject at the deadline;
 * neither commits), cancel it once Prisma 8 exposes a way to.
 */
function deadline(timeout: number | undefined): () => void {
  if (timeout === undefined) return () => {};
  if (typeof timeout !== "number") fail("timeout must be a number");
  const end = Date.now() + timeout;
  return () => {
    if (Date.now() < end) return;
    throw Object.assign(
      new Error(`Transaction already closed: the ${timeout}ms timeout passed.`),
      { code: "P2028" },
    );
  };
}

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
  ) {}

  private run() {
    return (this.promise ??= (async () => this.exec(this.home))());
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

function delegate(x: Executor, m: Model) {
  const op =
    (
      name: string,
      allowed: string[],
      run: (e: Executor, a: Args) => Promise<unknown>,
    ) =>
    (args: Args = {}) =>
      new Op((e) => {
        check(name, args, allowed);
        return run(e, args);
      }, x);
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
      const q = insert(m, [a.data]);
      const [row] = await rowsOf(e, q, returning(q, m));
      return row;
    }),
    createMany: op("createMany", ["data", "skipDuplicates"], async (e, a) => {
      if (!Array.isArray(a.data)) fail("createMany takes an array of rows");
      if (a.data.length === 0) return { count: 0 };
      const q = insert(m, a.data);
      if (a.skipDuplicates) q.t(" ON CONFLICT DO NOTHING");
      return { count: await affected(e, q) };
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
        const insertion = insert(m, [a.create]);
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
      const [row] = await rowsOf(e, q, { n: INT8 });
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
  const { table: tables, native_enum: enums } =
    contract.storage.namespaces.public.entries;
  const models: Record<string, Model> = {};
  for (const [name, model] of Object.entries(
    contract.domain.namespaces.public.models,
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
    contract.domain.namespaces.public.models,
  )) {
    for (const [field, relation] of Object.entries(model.relations)) {
      models[name]!.relations[field] = {
        ...relation,
        target: models[relation.to.model]!,
      };
    }
  }
  for (const d of contract.execution.mutations.defaults) {
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
    for (const [name, c] of Object.entries(byTable[table]?.cols ?? {})) {
      if (/time|date/i.test(c.codecId) && c.codecId !== TIMESTAMP) {
        fail(
          `${table}.${name} uses ${c.codecId}. Declare timestamps as TimestampString(3), as in contract.prisma: the engine's raw SQL needs naive UTC timestamp columns.`,
        );
      }
    }
  }
  for (const table of ["workflow_runs", "workflow_stages", "job_queue"]) {
    if (byTable[table]!.cols.status?.codecId !== ENUM) {
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
      "expected a Prisma 8 client from postgres({ contract, url }), or a transaction's tx with { contract: db.contract }",
    );
  }
  const models = modelsOf(contract as object);
  const byTable = Object.fromEntries(
    Object.values(models).map((m) => [m.table, m]),
  );
  const root = typeof (db as Partial<Prisma8Db>).transaction === "function";
  const delegates = new WeakMap<Executor, Record<string, unknown>>();

  const client = (
    x: Executor,
    inTransaction: boolean,
    columns?: RawColumns,
  ): Prisma8Client => {
    if (!delegates.has(x)) {
      delegates.set(
        x,
        Object.fromEntries(
          Object.values(models).map((m) => [
            m.name[0]!.toLowerCase() + m.name.slice(1),
            delegate(x, m),
          ]),
        ),
      );
    }

    const spec = (): Record<string, string> => {
      if (columns === undefined) {
        fail(
          "a raw read must declare its result columns: run it on rawFor(client, columns)",
        );
      }
      if (typeof columns === "string") {
        const m = byTable[columns] ?? fail(`unknown table "${columns}"`);
        return specOf(m, Object.keys(m.cols));
      }
      return Object.fromEntries(
        Object.entries(columns!).map(([n, t]) => [
          n,
          RAW_TYPES[t] ?? fail(`unknown raw column type "${t}"`),
        ]),
      );
    };
    const read = async (q: Sql) => rowsOf(x, q, spec());

    const transaction = async (arg: any, options: Args = {}) => {
      check("$transaction", options, ["isolationLevel", "timeout"]);
      const callback = typeof arg === "function";
      return (db as Prisma8Db).transaction(async (raw: Executor) => {
        const open = deadline(
          options.timeout ?? (callback ? DEFAULT_TIMEOUT : undefined),
        );
        const tx: Executor = {
          raw: raw.raw,
          query: (plan) => (open(), raw.query(plan)),
          execute: (plan) => (open(), raw.execute(plan)),
        };
        if (options.isolationLevel) {
          const level =
            ISOLATION[options.isolationLevel] ??
            fail(`unknown isolation level "${options.isolationLevel}"`);
          await affected(
            raw,
            new Sql().t(`SET TRANSACTION ISOLATION LEVEL ${level}`),
          );
        }
        if (callback) {
          const result = await arg(client(tx, true));
          open();
          return result;
        }
        const results: unknown[] = [];
        for (const op of arg) {
          if (!(op instanceof Op))
            fail("$transaction([...]) takes delegate calls only");
          results.push(await op.exec(tx));
        }
        return results;
      });
    };

    return {
      ...delegates.get(x),
      ...(inTransaction || !root ? {} : { $transaction: transaction }),
      $queryRaw: (strings: TemplateStringsArray, ...values: any[]) =>
        read(template(strings, values)),
      $queryRawUnsafe: (text: string, ...values: any[]) =>
        read(positional(text, values)),
      $executeRaw: (strings: TemplateStringsArray, ...values: any[]) =>
        affected(x, template(strings, values)),
      $executeRawUnsafe: (text: string, ...values: any[]) =>
        affected(x, positional(text, values)),
      $withColumns: (c: RawColumns) => client(x, inTransaction, c),
    } as unknown as Prisma8Client;
  };

  return client(db, !root);
}
