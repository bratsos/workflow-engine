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
 * `afterStatement` runs between a statement and the next, to write a row there;
 * `afterExecute` after each `$executeRawUnsafe` (a cursor's `DECLARE`, `CLOSE`).
 */
export function recordingClient(
  client: ConsolePrismaClient,
  calls: RecordedStatement[],
  afterStatement?: (call: RecordedStatement) => Promise<void>,
  afterExecute?: (sql: string) => Promise<void>,
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
      ? {
          $transaction: (fn, options) =>
            c.$transaction!((tx) => fn(wrap(tx)), options),
        }
      : {}),
    // A cursor's `DECLARE` is recorded (its query is the read); settings
    // statements (`SET LOCAL`) and `CLOSE` pass through unrecorded.
    ...(c.$executeRawUnsafe
      ? {
          $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
            const count = await c.$executeRawUnsafe!(sql, ...params);
            if (sql.startsWith("DECLARE "))
              calls.push({ sql, params, rows: count });
            await afterExecute?.(sql);
            return count;
          },
        }
      : {}),
    ...(c.$withColumns
      ? { $withColumns: (columns) => wrap(c.$withColumns!(columns)) }
      : {}),
    ...(c.$databaseType ? { $databaseType: c.$databaseType } : {}),
  });
  return wrap(client);
}
