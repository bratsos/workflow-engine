import {
  type EnginePrismaClient,
  type RawColumns,
  rawFor,
} from "./prisma-client-type";

/** Execute the same positional statement through either raw-read capability. */
export function readOutboxSql<T>(
  prisma: EnginePrismaClient,
  databaseType: "sqlite" | "postgresql",
  columns: RawColumns,
  sql: string,
  args: readonly unknown[],
): Promise<T[]> {
  const client = rawFor(prisma, columns);
  if (
    prisma.$queryRawUnsafe &&
    (databaseType === "postgresql" || prisma.$databaseType === "sqlite")
  ) {
    return client.$queryRawUnsafe!<T[]>(sql, ...args);
  }
  // A repeated $n binds the same value at each occurrence when a native
  // SQLite query or a tagged template needs one value per placeholder.
  const parts = sql.split(/\$(\d+)/);
  const strings: string[] = [parts[0]!];
  const values: unknown[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    values.push(args[Number(parts[i]) - 1]);
    strings.push(parts[i + 1]!);
  }
  if (prisma.$queryRawUnsafe)
    return client.$queryRawUnsafe!<T[]>(strings.join("?"), ...values);
  return client.$queryRaw!<T[]>(
    Object.assign(strings, { raw: strings }),
    ...values,
  );
}

/**
 * Walk a range of run IDs in index order. Each iteration seeks past the
 * previous run, even when that run has a large tail of unpublished events.
 */
export interface OutboxClaimPage {
  limit: number;
  claim: string;
  deadline: string;
  excluded: readonly string[];
  after?: string;
  through?: string;
  signal?: Pick<AbortSignal, "aborted">;
  firstRank: string;
}

// The prefix sorts acquisition order independently of the lease duration.
export const firstOutboxRotation = "r0000000000000000";

export function nextOutboxRotation(previous: string | undefined): string {
  const rank = previous ? BigInt(previous.slice(1, 17)) : 0n;
  return `r${(rank + 1n).toString().padStart(16, "0")}`;
}

export function outboxClaimExpiry(stored: string): string {
  return stored.startsWith("r") ? stored.slice(18, 42) : stored.slice(0, 24);
}

export function releasedOutboxClaim(stored: string | null): string | null {
  return stored?.startsWith("r") ? stored.slice(0, 18) : null;
}

// Keep the ranked cursor probe independent of the head walk. The statement
// snapshot supplies the rank even if another adapter advanced the cursor
// between the caller's cursor read and the acquisition.
function outboxRank(sqlite: boolean, offset: string) {
  const index = sqlite ? "INDEXED BY outbox_events_delivery_cursor_idx" : "";
  const previous = `(SELECT CAST(substr("deliveryClaim", 2, 16) AS BIGINT)
    FROM "outbox_events" ${index} WHERE "deliveryClaim" >= '${firstOutboxRotation}'
    ORDER BY "deliveryClaim" DESC, "workflowRunId" DESC LIMIT 1)`;
  const rank = `COALESCE(${previous}, 0) + ${offset}`;
  return sqlite
    ? `printf('r%016d|', ${rank}) || $3`
    : `'r' || lpad((${rank})::text, 16, '0') || '|' || $3`;
}

const live = '"publishedAt" IS NULL AND "dlqAt" IS NULL';
const headOrder = '"publishedAt", "dlqAt", "workflowRunId", sequence';

function pageBindings(page: OutboxClaimPage) {
  const args: (string | number)[] = [page.limit, page.deadline, page.claim];
  const bind = (value: string) => `$${args.push(value)}`;
  const start =
    page.after === undefined ? "" : `AND "workflowRunId" > ${bind(page.after)}`;
  const end =
    page.through === undefined
      ? ""
      : `AND "workflowRunId" <= ${bind(page.through)}`;
  const excluded = page.excluded.map(bind).join(", ");
  return {
    args,
    head: (next: string, index = "", columns = 'id, "workflowRunId"') =>
      `SELECT ${columns} FROM "outbox_events" ${index}
       WHERE ${live} ${next} ${end}
       ORDER BY ${headOrder} LIMIT 1`,
    start,
    eligible: (run: string) =>
      excluded ? `${run} NOT IN (${excluded}) AND` : "",
  };
}

function noActiveClaim(run: string, index = "") {
  const probe = (range: string, order: string) => `(
    SELECT "deliveryClaim" FROM "outbox_events" ${index}
    WHERE ${live} AND "workflowRunId" = ${run} AND ${range}
    ORDER BY "publishedAt" ${order}, "dlqAt" ${order}, "workflowRunId" ${order},
      "deliveryClaim" ${order} LIMIT 1
  )`;
  // New claims sort by acquisition rank. Only the latest could still be
  // live, even after replay restored an older predecessor.
  const latest = probe(`"deliveryClaim" >= '${firstOutboxRotation}'`, "DESC");
  const legacy = probe(`"deliveryClaim" > $2 AND "deliveryClaim" < 'r'`, "ASC");
  return `(COALESCE(substr(${latest}, 19, 24), '') <= substr($2, 1, 24)
    AND ${legacy} IS NULL)`;
}

export function sqliteOutboxClaim(page: OutboxClaimPage) {
  const { args, head, start, eligible } = pageBindings(page);
  const primary = "INDEXED BY sqlite_autoindex_outbox_events_1";
  const run = 'e."workflowRunId"';
  const available = `(${eligible(run)} ${noActiveClaim(run, "INDEXED BY outbox_events_delivery_run_idx")})`;
  const probe = (next: string) =>
    head(next, "INDEXED BY outbox_events_live_run_sequence_idx", "id");
  return {
    sql: `WITH RECURSIVE walk(id, run_id, available, served) AS (
      SELECT e.id, e."workflowRunId", ${available}, ${available}
      FROM "outbox_events" e ${primary} WHERE e.id = (${probe(start)})
      UNION ALL
      SELECT e.id, e."workflowRunId", ${available}, walk.served + (${available})
      FROM walk CROSS JOIN "outbox_events" e ${primary}
      WHERE walk.served < $1 AND e.id = (
        ${probe('AND "workflowRunId" > walk.run_id')}
      )
    ), chosen AS MATERIALIZED (SELECT id, served FROM walk WHERE available)
    UPDATE "outbox_events" ${primary} SET "deliveryClaim" =
      (${outboxRank(true, '(SELECT served FROM chosen WHERE chosen.id = "outbox_events".id)')})
    WHERE id IN (SELECT id FROM chosen)
    RETURNING *`,
    args,
  };
}

export function postgresOutboxClaim(
  page: OutboxClaimPage,
  returnRows: boolean,
) {
  const { args, head, start, eligible } = pageBindings(page);
  // The first retained event serializes claims even when a replay changes
  // the head. Updating the anchor changes its tuple version (xmin). A
  // contender with an older statement snapshot cannot claim using that
  // version, even after the winning statement commits and unlocks it.
  const locks = `LEFT JOIN LATERAL (
    SELECT e.id FROM (
      SELECT id, xmin FROM "outbox_events" WHERE "workflowRunId" = head."workflowRunId"
      ORDER BY sequence LIMIT 1
    ) snapshot JOIN "outbox_events" e
      ON e.id = snapshot.id AND e.xmin = snapshot.xmin
    WHERE ${eligible('head."workflowRunId"')} ${noActiveClaim('head."workflowRunId"')}
    FOR UPDATE OF e SKIP LOCKED
  ) anchor ON true
  LEFT JOIN LATERAL (
    SELECT e.id FROM "outbox_events" e
    WHERE anchor.id IS NOT NULL AND e.id = head.id
    FOR UPDATE OF e SKIP LOCKED
  ) locked ON true`;
  return {
    sql: `WITH RECURSIVE walk(run_id, id, anchor, served) AS (
      SELECT head."workflowRunId", locked.id, anchor.id, (locked.id IS NOT NULL)::int
      FROM (${head(start)}) head ${locks}
      UNION ALL
      SELECT head."workflowRunId", locked.id, anchor.id, walk.served + (locked.id IS NOT NULL)::int
      FROM walk CROSS JOIN LATERAL (
        ${head('AND "workflowRunId" > walk.run_id')}
      ) head ${locks}
      WHERE walk.served < $1
    ), chosen AS MATERIALIZED (
      SELECT id, anchor, served FROM walk WHERE id IS NOT NULL
    )${returnRows ? ", updated AS (" : ""}
    UPDATE "outbox_events" e SET "deliveryClaim" =
      CASE WHEN e.id = ANY(ARRAY(SELECT id FROM chosen))
        THEN (${outboxRank(false, "(SELECT served FROM chosen WHERE chosen.id = e.id)")})
        ELSE e."deliveryClaim" END
    WHERE e.id = ANY(ARRAY(SELECT id FROM chosen UNION ALL SELECT anchor FROM chosen))
    ${
      returnRows
        ? `RETURNING e.*
    )
    SELECT updated.* FROM updated JOIN chosen USING (id) ORDER BY chosen.served`
        : ""
    }`,
    args,
  };
}

export async function executeOutboxSql(
  prisma: EnginePrismaClient,
  sql: string,
  args: readonly unknown[],
): Promise<void> {
  if (prisma.$executeRawUnsafe) {
    await prisma.$executeRawUnsafe(sql, ...args);
    return;
  }
  const parts = sql.split(/\$(\d+)/);
  const strings = [parts[0]!];
  const values: unknown[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    values.push(args[Number(parts[i]) - 1]);
    strings.push(parts[i + 1]!);
  }
  await prisma.$executeRaw!(
    Object.assign(strings, { raw: strings }),
    ...values,
  );
}
