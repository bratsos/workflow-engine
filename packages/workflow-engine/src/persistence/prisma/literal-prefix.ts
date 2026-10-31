import {
  type EnginePrismaClient,
  type RawColumns,
  rawFor,
} from "./prisma-client-type.js";

type PrefixClient = Pick<
  EnginePrismaClient,
  "$queryRaw" | "$queryRawUnsafe" | "$withColumns"
>;

/** A bound LIKE pattern with one explicit escape character on both databases. */
export function literalPrefixQuery<T>(
  prisma: PrefixClient,
  table: string,
  column: string,
  prefix: string,
  options: {
    columns?: RawColumns;
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
    // Prisma chooses the driver's placeholders: native SQLite 7 binds '?',
    // while PostgreSQL and the Prisma 8 positional facade use '$n'.
    const parts = sql.split(/\$\d+/);
    query = client.$queryRaw<T[]>(
      Object.assign(parts, { raw: parts }),
      ...values,
    );
  } else {
    query = client.$queryRawUnsafe!<T[]>(sql, ...values);
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
