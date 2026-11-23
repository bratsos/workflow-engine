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

type PruneClause = "aiCalls" | "aiCallText" | "outbox" | "idempotencyKeys";

export function pruneRows(
  prisma: EnginePrismaClient,
  databaseType: Dialect,
  clause: PruneClause,
  date: Date,
  limit: number,
): Promise<number> {
  const pg = databaseType === "postgresql";
  const cutoff = pg ? utcTimestampParam(1) : "$1";
  const candidates = (table: string, column: string, filter: string) =>
    `SELECT "id" FROM "${table}" WHERE "${column}" <= ${cutoff} ${filter}
     ORDER BY "${column}" LIMIT $2`;
  // PostgreSQL can plan IN (SELECT ... LIMIT ...) as a hash join that
  // reads the whole target table. A scalar array gives it one bounded key
  // lookup, while retaining the outer predicates for concurrent row changes.
  const selected = (query: string) =>
    pg ? `"id" = ANY(ARRAY(${query}))` : `"id" IN (${query})`;
  let sql: string;
  switch (clause) {
    case "aiCalls":
      sql = `DELETE FROM "ai_calls" WHERE ${selected(candidates("ai_calls", "createdAt", ""))}`;
      break;
    case "aiCallText": {
      const metadata = pg
        ? `CASE WHEN jsonb_typeof("metadata") = 'object' THEN "metadata" - 'instructions' ELSE "metadata" END`
        : `CASE WHEN json_type("metadata") = 'object' THEN json_remove("metadata", '$.instructions') ELSE "metadata" END`;
      sql = `UPDATE "ai_calls" SET "prompt" = '', "response" = '',
        "metadata" = ${metadata}, "textExpiresAt" = NULL
        WHERE ${selected(candidates("ai_calls", "textExpiresAt", ""))} AND "textExpiresAt" <= ${cutoff}`;
      break;
    }
    case "outbox": {
      const terminal = `r."status" IN ('COMPLETED', 'FAILED', 'CANCELLED')`;
      const published = `"dlqAt" IS NULL AND "publishedAt" <= ${cutoff}`;
      const eligible = pg
        ? `SELECT e."id" FROM "outbox_events" e
           JOIN "workflow_runs" r ON r."id" = e."workflowRunId"
           WHERE e.${published} AND ${terminal}
           ORDER BY e."publishedAt" LIMIT $2 FOR NO KEY UPDATE OF r SKIP LOCKED`
        : candidates(
            "outbox_events",
            "publishedAt",
            `AND "dlqAt" IS NULL AND EXISTS (
              SELECT 1 FROM "workflow_runs" r WHERE r."id" = "outbox_events"."workflowRunId" AND ${terminal}
            )`,
          );
      sql = `DELETE FROM "outbox_events" WHERE ${selected(eligible)} AND ${published}`;
      break;
    }
    case "idempotencyKeys": {
      const completed = pg
        ? `("result"->>'__workflowEngineState') IS DISTINCT FROM 'in_progress'`
        : `json_extract("result", '$.__workflowEngineState') IS NOT 'in_progress'`;
      sql = `DELETE FROM "idempotency_keys" WHERE
        ${selected(candidates("idempotency_keys", "createdAt", `AND ${completed}`))}
        AND "createdAt" <= ${cutoff} AND ${completed}`;
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
