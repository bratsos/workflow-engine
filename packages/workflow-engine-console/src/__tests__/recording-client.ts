import type { ConsolePrismaClient } from "../prisma-read-port";

/** A statement the read port issued, with the rows the database returned. */
export interface RecordedStatement {
  sql: string;
  params: unknown[];
  rows: unknown;
}

/**
 * Wraps a client so each raw read is recorded, whichever way the port reaches
 * it: directly, inside `$transaction`, or through Prisma 8's `$withColumns`.
 * `afterStatement` runs between a statement and the next, to write a row there.
 */
export function recordingClient(
  client: ConsolePrismaClient,
  calls: RecordedStatement[],
  afterStatement?: (call: RecordedStatement) => Promise<void>,
): ConsolePrismaClient {
  const wrap = (c: ConsolePrismaClient): ConsolePrismaClient => ({
    $queryRawUnsafe: (async (sql: string, ...params: unknown[]) => {
      const rows = await c.$queryRawUnsafe(sql, ...params);
      const call = { sql, params, rows };
      calls.push(call);
      await afterStatement?.(call);
      return rows;
    }) as ConsolePrismaClient["$queryRawUnsafe"],
    ...(c.$transaction
      ? { $transaction: (fn) => c.$transaction!((tx) => fn(wrap(tx))) }
      : {}),
    ...(c.$withColumns
      ? { $withColumns: (columns) => wrap(c.$withColumns!(columns)) }
      : {}),
    ...(c.$databaseType ? { $databaseType: c.$databaseType } : {}),
  });
  return wrap(client);
}
