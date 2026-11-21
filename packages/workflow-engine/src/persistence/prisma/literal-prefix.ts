import {
  type EnginePrismaClient,
  type RawColumns,
  rawFor,
} from "./prisma-client-type.js";

type PrefixClient = Pick<
  EnginePrismaClient,
  "$queryRaw" | "$queryRawUnsafe" | "$withColumns"
>;

/**
 * A bound LIKE pattern with one explicit escape character on both databases.
 * SQLite's `LIKE` is ASCII case-insensitive and does not use the btree index:
 * `list("Case/")` also returns `case/2`, and an annotation `keyPrefix` matches
 * the same way. Keep keys lowercase (the engine's convention) there.
 */
export function literalPrefixQuery<T>(
  prisma: PrefixClient,
  table: string,
  column: string,
  prefix: string,
  options: {
    columns?: RawColumns;
    databaseType?: "postgresql" | "sqlite";
    select?: string;
    suffix?: string;
    values?: unknown[];
    jsonColumns?: readonly string[];
  } = {},
): Promise<T[]> | undefined {
  if (!prisma.$queryRaw && !prisma.$queryRawUnsafe) return undefined;
  const pattern = `${prefix.replace(/[!%_]/g, "!$&")}%`;
  const sql = `SELECT ${options.select ?? "*"} FROM "${table}" WHERE "${column}" LIKE $1 ESCAPE '!'${options.suffix ?? ""}`;
  const client = rawFor(prisma as EnginePrismaClient, options.columns ?? table);
  const values = [pattern, ...(options.values ?? [])];
  let query: Promise<T[]>;
  if (client.$queryRaw) {
    // Let Prisma choose the driver's placeholders for tagged reads.
    const parts = sql.split(/\$\d+/);
    query = client.$queryRaw<T[]>(
      Object.assign(parts, { raw: parts }),
      ...values,
    );
  } else {
    // Native Prisma 6/7 SQLite binds positional values with `?`. Prisma 8's
    // facade and PostgreSQL use `$n`; the former is identified by its target,
    // while native adapters get the configured database type from the caller.
    const unsafeSql =
      (options.databaseType ?? client.$databaseType) === "sqlite" &&
      client.$databaseType !== "sqlite"
        ? sql.replace(/\$\d+/g, "?")
        : sql;
    query = client.$queryRawUnsafe!<T[]>(unsafeSql, ...values);
  }
  return query.then((rows) => {
    for (const row of rows)
      for (const column of options.jsonColumns ?? []) {
        const record = row as Record<string, unknown>;
        if (typeof record[column] === "string")
          record[column] = JSON.parse(record[column]);
      }
    return rows;
  });
}

/** Safe candidate prefix for structural clients that expose delegates only. */
export function prefixCandidates(prefix: string): string {
  return prefix.split(/[%_\\]/, 1)[0]!;
}
