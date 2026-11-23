import { readOutboxSql } from "./outbox-claim.js";
import type { EnginePrismaClient } from "./prisma-client-type.js";
import { utcTimestampParam } from "./utc-timestamps.js";

type Dialect = "sqlite" | "postgresql";

/** Bind positional SQL through the client's own SQLite date codec. */
export async function writeRetentionSql(
  prisma: EnginePrismaClient,
  databaseType: Dialect,
  sql: string,
  args: readonly unknown[],
): Promise<number> {
  if (
    prisma.$executeRawUnsafe &&
    (databaseType === "postgresql" || prisma.$databaseType === "sqlite")
  ) {
    return Number(await prisma.$executeRawUnsafe(sql, ...args));
  }
  const parts = sql.split(/\$(\d+)/);
  const strings = [parts[0]!];
  const values: unknown[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    values.push(args[Number(parts[i]) - 1]);
    strings.push(parts[i + 1]!);
  }
  if (prisma.$executeRaw) {
    return Number(
      await prisma.$executeRaw(
        Object.assign(strings, { raw: strings }),
        ...values,
      ),
    );
  }
  if (prisma.$executeRawUnsafe) {
    return Number(await prisma.$executeRawUnsafe(strings.join("?"), ...values));
  }
  throw new Error("Erasure and retention require a Prisma raw write method");
}

/** The command type of a run writer's registration in `idempotency_keys`. */
export const RUN_WRITER = "run.write";

type PruneClause =
  | "aiCalls"
  | "aiCallText"
  | "outbox"
  | "idempotencyKeys"
  | "runWriters";

/** The indexes of one table that a prune statement may name. */
interface TableIndexes {
  /** SQLite: the primary-key index. A rowid alias has none. */
  primaryKey?: string;
  /** SQLite: a whole-table index led by this column. */
  led: Map<string, string>;
  /** The partial index over run writer registrations by age. */
  writers?: string;
}

const NO_INDEXES: TableIndexes = { led: new Map() };

/**
 * Reads the indexes a prune statement may name from the table itself, once
 * per adapter. A statement names an index only when the table has a usable
 * one, so on a table laid out differently (a model without the age index, no
 * retention script run) it is the plain statement that works without it.
 */
export class RetentionIndexes {
  private readonly tables = new Map<string, Promise<TableIndexes>>();

  constructor(
    private readonly prisma: EnginePrismaClient,
    private readonly databaseType: Dialect,
  ) {}

  of(table: string): Promise<TableIndexes> {
    let found = this.tables.get(table);
    if (!found) {
      found = this.read(table).catch(() => {
        // Not remembered: the next prune asks again.
        this.tables.delete(table);
        return NO_INDEXES;
      });
      this.tables.set(table, found);
    }
    return found;
  }

  private async read(table: string): Promise<TableIndexes> {
    const found: TableIndexes = { led: new Map() };
    if (this.databaseType === "postgresql") {
      // Only the run writer index is looked for, on the table that has it.
      if (table !== "idempotency_keys") return found;
      const definitions = await readOutboxSql<{ def: string }>(
        this.prisma,
        "postgresql",
        { def: "text" },
        `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
          WHERE i.indrelid = to_regclass('"${table}"') AND i.indpred IS NOT NULL`,
        [],
      );
      if (definitions.some(({ def }) => WRITER_INDEX.test(String(def)))) {
        found.writers = "writers";
      }
      return found;
    }
    // Each index with its leading column, as SQLite itself describes them.
    const rows = await readOutboxSql<{
      name: string;
      origin: string;
      partial: number | bigint;
      col: string;
      sql: string | null;
    }>(
      this.prisma,
      "sqlite",
      {
        name: "text",
        origin: "text",
        partial: "int",
        col: "text",
        sql: "text",
      },
      `SELECT i.name AS name, i.origin AS origin, i.partial AS partial, c.name AS col, m.sql AS sql
        FROM pragma_index_list('${table}') i
        JOIN pragma_index_info(i.name) c ON c.seqno = 0
        LEFT JOIN sqlite_master m ON m.type = 'index' AND m.name = i.name
        ORDER BY i.name`,
      [],
    );
    for (const row of rows) {
      if (row.origin === "pk" && row.col === "id") found.primaryKey = row.name;
      else if (Number(row.partial) === 0 && !found.led.has(row.col)) {
        found.led.set(row.col, row.name);
      } else if (
        Number(row.partial) === 1 &&
        row.col === "createdAt" &&
        WRITER_INDEX.test(String(row.sql))
      ) {
        found.writers = row.name;
      }
    }
    return found;
  }
}

/** A partial index of the run writer registrations, ordered by age. */
const WRITER_INDEX =
  /createdAt[\s\S]*WHERE\s+\(*"?commandType"?\)*(::text)?\s*=\s*'run\.write'/i;

export async function pruneRows(
  prisma: EnginePrismaClient,
  databaseType: Dialect,
  clause: PruneClause,
  date: Date,
  limit: number,
  indexes: RetentionIndexes,
): Promise<number> {
  const pg = databaseType === "postgresql";
  const table =
    clause === "outbox"
      ? "outbox_events"
      : clause === "idempotencyKeys" || clause === "runWriters"
        ? "idempotency_keys"
        : "ai_calls";
  const found = await indexes.of(table);
  // Without its partial index, run writer registrations are not pruned.
  if (clause === "runWriters" && !found.writers) return 0;
  const cutoff = pg ? utcTimestampParam(1) : "$1";
  const candidates = (
    table: string,
    column: string,
    filter: string,
    index?: string,
    // SQLite only: the index its select must walk, whatever statistics say.
    // `undefined` leaves the choice to the planner.
    hint: string | undefined = index,
  ) => {
    const from = `"${table}"${hint && !pg ? ` INDEXED BY "${hint}"` : ""}`;
    // On PostgreSQL the eligible expression index is the ordered path for
    // these queries. The general age index cannot serve their order.
    const age =
      pg && index ? `("${column}" + interval '0 seconds')` : `"${column}"`;
    return `SELECT "id" FROM ${from} WHERE ${age} <= ${cutoff} ${filter}
            ORDER BY ${age} LIMIT $2`;
  };
  // PostgreSQL can plan IN (SELECT ... LIMIT ...) as a hash join that
  // reads the whole target table. A scalar array gives it one bounded key
  // lookup, while retaining the outer predicates for concurrent row changes.
  const selected = (query: string) =>
    pg ? `"id" = ANY(ARRAY(${query}))` : `"id" IN (${query})`;
  // SQLite takes the statement's writer lock before selecting candidates.
  // Keep its outer mutation on the primary key, even with skewed statistics:
  // after an ANALYZE of a near-empty table the planner scans the table for
  // `"id" IN (...)`, and for `rowid IN (...)` as well, so it is told the
  // index, when the table has one.
  const target = (name: string) =>
    `"${name}"${!pg && found.primaryKey ? ` INDEXED BY "${found.primaryKey}"` : ""}`;
  // PostgreSQL rechecks rows changed concurrently through a sub-select, which
  // no index or partial index predicate can match: statistics taken before a
  // backlog became eligible cannot route the mutation through that backlog.
  const recheck = (filter: string) => (pg ? ` AND (SELECT ${filter})` : "");
  let sql: string;
  switch (clause) {
    case "aiCalls":
      sql = `DELETE FROM ${target("ai_calls")} WHERE ${selected(candidates("ai_calls", "createdAt", "", undefined, found.led.get("createdAt")))}`;
      break;
    case "aiCallText": {
      const metadata = pg
        ? `CASE WHEN jsonb_typeof("metadata") = 'object' THEN "metadata" - 'instructions' ELSE "metadata" END`
        : `CASE WHEN json_type("metadata") = 'object' THEN json_remove("metadata", '$.instructions') ELSE "metadata" END`;
      sql = `UPDATE ${target("ai_calls")} SET "prompt" = '', "response" = '',
        "metadata" = ${metadata}, "textExpiresAt" = NULL
        WHERE ${selected(candidates("ai_calls", "textExpiresAt", "", undefined, found.led.get("textExpiresAt")))}${recheck(`"textExpiresAt" <= ${cutoff}`)}`;
      break;
    }
    case "outbox": {
      const indexed = `"pruneTerminal" = ${pg ? "TRUE" : "1"} AND "dlqAt" IS NULL AND "publishedAt" IS NOT NULL`;
      const batch = candidates(
        "outbox_events",
        "publishedAt",
        `AND ${indexed}`,
        "outbox_events_prune_idx",
      );
      // Take run locks after the bounded index walk. A concurrent reopening
      // can shrink this batch, and cannot make it examine more candidates.
      const eligible = pg
        ? `SELECT e."id" FROM "outbox_events" e
           JOIN "workflow_runs" r ON r."id" = e."workflowRunId"
           WHERE e.${selected(batch)}
             AND r."status" IN ('COMPLETED', 'FAILED', 'CANCELLED')
           FOR NO KEY UPDATE OF r SKIP LOCKED`
        : batch;
      sql = `DELETE FROM ${target("outbox_events")} WHERE ${selected(eligible)}
        ${recheck(`${indexed} AND "publishedAt" <= ${cutoff}`)}`;
      break;
    }
    case "idempotencyKeys": {
      const completed = pg
        ? `("result"->>'__workflowEngineState') IS DISTINCT FROM 'in_progress'`
        : `json_extract("result", '$.__workflowEngineState') IS NOT 'in_progress'`;
      sql = `DELETE FROM ${target("idempotency_keys")} WHERE
        ${selected(candidates("idempotency_keys", "createdAt", `AND ${completed}`, "idempotency_keys_prune_idx"))}
        ${recheck(`"createdAt" <= ${cutoff} AND ${completed}`)}`;
      break;
    }
    case "runWriters": {
      // `date` is the lease cutoff: a registration last refreshed before it
      // no longer counts as a writer, and its process is not coming back.
      const writer = `AND "commandType" = '${RUN_WRITER}'`;
      sql = `DELETE FROM ${target("idempotency_keys")} WHERE
        ${selected(candidates("idempotency_keys", "createdAt", writer, "writers", found.writers))}
        ${recheck(`"createdAt" <= ${cutoff} ${writer}`)}`;
      break;
    }
  }
  return writeRetentionSql(prisma, databaseType, sql, [
    pg ? date.toISOString() : date,
    limit,
  ]);
}

/**
 * Increment the prefix's final ASCII delimiter to get its exclusive upper
 * bound under binary comparison.
 */
export function prefixRange(prefix: string): [string, string] {
  return [
    prefix,
    prefix.slice(0, -1) +
      String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1),
  ];
}
