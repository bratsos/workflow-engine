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
 * Thrown by `createPrismaWorkflowPersistence` on PostgreSQL for a root client
 * that exposes neither raw read. Outbox delivery claims with one statement
 * that locks each run and returns the rows it claimed; model delegates cannot
 * hold a run's claim exclusive against a concurrent replay and claim.
 */
export class OutboxClaimUnsupportedError extends Error {
  readonly code = "OUTBOX_CLAIM_UNSUPPORTED";

  constructor() {
    super(
      "This Prisma client exposes neither $queryRaw (tagged template) nor $queryRawUnsafe. Outbox delivery claims events with one SQL statement that returns the rows it claimed, and the engine has no claim that keeps a run's events in order without it. Pass the Prisma client itself, or a wrapper that forwards one of the two.",
    );
    this.name = "OutboxClaimUnsupportedError";
  }
}

/**
 * Thrown by the Prisma claim on a database without the outbox delivery
 * schema step: the `deliveryClaim` column or one of its three indexes is
 * missing. The flush claims nothing, so every event stays in the outbox.
 */
export class OutboxSchemaMissingError extends Error {
  readonly code = "OUTBOX_SCHEMA_MISSING";

  constructor(cause: unknown) {
    super(
      'outbox_events lacks the nullable "deliveryClaim" column or one of the indexes outbox_events_delivery_run_idx, outbox_events_live_run_sequence_idx and outbox_events_delivery_cursor_idx. Stop the flushers, apply the 1.0.0-alpha.21 outbox schema migration ("Outbox at-least-once delivery and schema upgrade" in the 0.13 to 1.0 migration guide) and restart. No event was claimed; every event stays in the outbox.',
      { cause },
    );
    this.name = "OutboxSchemaMissingError";
  }
}

const MISSING_SCHEMA =
  /no such (?:index|column): [\w."]*(?:outbox_events_\w+_idx|deliveryClaim)|column [\w."]*deliveryClaim"? does not exist/;

/** The claim's error, or `OutboxSchemaMissingError` when the schema step is missing. */
export function outboxSchemaError(error: unknown): unknown {
  const meta = (error as { meta?: unknown })?.meta;
  return MISSING_SCHEMA.test(
    `${(error as Error)?.message ?? error} ${JSON.stringify(meta) ?? ""}`,
  )
    ? new OutboxSchemaMissingError(error)
    : error;
}

export interface OutboxClaimPage {
  limit: number;
  claim: string;
  deadline: string;
  excluded: readonly string[];
}

// A rank is the acquisition counter, zero-padded to the width of the largest
// BIGINT. It saturates at that maximum, so it never needs another digit:
// string order is numeric order and every offset below is fixed. A new rank
// is never below a stored one, so the latest acquisition stays the highest
// claim. Equal ranks (saturated or seeded) order by the rest of the claim,
// the lease expiry, then by run ID.
const RANK_DIGITS = 19;
const RANK_MAX = "9223372036854775807"; // 2^63 - 1
export const firstOutboxRotation = `r${"0".repeat(RANK_DIGITS)}`;
/** `r`, the rank and `|`: what a released claim keeps. */
const RANK_PREFIX = RANK_DIGITS + 2;

export function outboxClaimOwner(stored: string): string {
  return stored.startsWith("r") ? stored.slice(RANK_PREFIX) : stored;
}

export function outboxClaimExpiry(stored: string): string {
  return outboxClaimOwner(stored).slice(0, 24);
}

export function releasedOutboxClaim(stored: string | null): string | null {
  return stored?.startsWith("r") ? stored.slice(0, RANK_PREFIX) : null;
}

const live = '"publishedAt" IS NULL AND "dlqAt" IS NULL';
const headOrder = '"publishedAt", "dlqAt", "workflowRunId", sequence';

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
  return `(COALESCE(substr(${latest}, ${
    RANK_PREFIX + 1
  }, 24), '') <= substr($2, 1, 24)
    AND ${legacy} IS NULL)`;
}

/**
 * The run that took the most recent rank, read inside the claim statement so
 * that every acquisition starts from the rotation position current when it
 * runs, and the rank it continues from.
 */
function cursorCte(sqlite: boolean) {
  const index = sqlite ? "INDEXED BY outbox_events_delivery_cursor_idx" : "";
  const rank = `CAST(substr("deliveryClaim", 2, ${RANK_DIGITS}) AS ${
    sqlite ? "INTEGER" : "BIGINT"
  })`;
  return `cursor AS MATERIALIZED (
    SELECT "workflowRunId" AS run_id, ${rank} AS rank
    FROM "outbox_events" ${index} WHERE "deliveryClaim" >= '${firstOutboxRotation}'
    ORDER BY "deliveryClaim" DESC, "workflowRunId" DESC LIMIT 1
  )`;
}

/**
 * Where the head walk goes next, as guarded single-row index seeks tried in
 * order: the next run after the cursor (the first run without a cursor),
 * then from the first run through the cursor's run (the wrap, then the
 * wrapped walk). The guards read the walk row only.
 */
function steps(head: (where: string) => string) {
  const cursorRun = "(SELECT run_id FROM cursor)";
  return [
    ["walk.wrapped = 0 AND walk.run_id IS NULL", head("")],
    [
      "walk.wrapped = 0 AND walk.run_id IS NOT NULL",
      head('"workflowRunId" > walk.run_id'),
    ],
    [
      `walk.wrapped = 0 AND ${cursorRun} IS NOT NULL`,
      head(`"workflowRunId" <= ${cursorRun}`),
    ],
    [
      "walk.wrapped = 1",
      head(`"workflowRunId" > walk.run_id AND "workflowRunId" <= ${cursorRun}`),
    ],
  ] as const;
}

const wrapped = (run: string) =>
  `CASE WHEN walk.wrapped = 1 OR ${run} <= (SELECT run_id FROM cursor) THEN 1 ELSE 0 END`;

function bindings(page: OutboxClaimPage) {
  const args: (string | number)[] = [page.limit, page.deadline, page.claim];
  const excluded = page.excluded
    .map((value) => `$${args.push(value)}`)
    .join(", ");
  return {
    args,
    eligible: (run: string) =>
      excluded ? `${run} NOT IN (${excluded}) AND` : "",
  };
}

/**
 * Rank of a claimed row: the cursor's rank plus the run's position in the
 * walk, counting the runs it skipped. Statements that start from the same
 * cursor rank a run by its rotation distance from it, so the highest rank,
 * the next cursor, is the furthest run any of them claimed.
 */
function rankSql(sqlite: boolean, ordinal: string) {
  const cursor = "COALESCE((SELECT rank FROM cursor), 0)";
  // Clamped without overflow: the walk position counts skipped heads too.
  const rank = `CASE WHEN ${ordinal} > ${RANK_MAX} - ${cursor} THEN ${RANK_MAX} ELSE ${cursor} + ${ordinal} END`;
  return sqlite
    ? `'r' || printf('%0${RANK_DIGITS}d', ${rank}) || '|' || $3`
    : `'r' || lpad((${rank})::text, ${RANK_DIGITS}, '0') || '|' || $3`;
}

/**
 * Each claimed run takes its head and its next live events in sequence
 * order, `limit / heads` events in all, so a page is shared equally by the
 * runs it reached. One seek per event.
 */
const share = `share AS MATERIALIZED (
    SELECT CAST($1 AS integer) / NULLIF(COUNT(*), 0) AS take FROM heads
  )`;

/**
 * One statement claims a page. A walk over run heads in run-ID order from the
 * rotation cursor, wrapping once, claims one head per available run until
 * the page is full or the rotation is done. Then each claimed run adds its
 * next live events up to its share. SQLite runs one writer at a time, so the
 * walk and the write see the same rows.
 *
 * Walk columns: `claimed` is 1 for a claimed head, `served` counts the heads
 * claimed before the row, `visit` is the row's position in the walk.
 */
export function sqliteOutboxClaim(page: OutboxClaimPage) {
  const { args, eligible } = bindings(page);
  const primary = "INDEXED BY sqlite_autoindex_outbox_events_1";
  const head = (where: string) =>
    `(SELECT id FROM "outbox_events" INDEXED BY outbox_events_live_run_sequence_idx
      WHERE ${live} ${
        where ? `AND ${where}` : ""
      } ORDER BY ${headOrder} LIMIT 1)`;
  const available = `(${eligible('e."workflowRunId"')} ${noActiveClaim(
    'e."workflowRunId"',
    "INDEXED BY outbox_events_delivery_run_idx",
  )})`;
  const next = steps(head)
    .map(([guard, seek]) => `CASE WHEN ${guard} THEN ${seek} END`)
    .join(",\n        ");
  return {
    sql: `WITH RECURSIVE ${cursorCte(true)},
    walk(id, run_id, seq, wrapped, claimed, served, visit) AS (
      SELECT NULL, (SELECT run_id FROM cursor), NULL, 0, 0, 0, 0
      UNION ALL
      SELECT e.id, e."workflowRunId", e.sequence, ${wrapped(
        'e."workflowRunId"',
      )},
        ${available}, walk.served + walk.claimed, walk.visit + 1
      FROM walk CROSS JOIN "outbox_events" e ${primary}
      WHERE walk.served + walk.claimed < $1 AND e.id = COALESCE(
        ${next}
      )
    ), heads AS MATERIALIZED (
      SELECT id, run_id, seq, visit AS ordinal FROM walk WHERE claimed = 1
    ), ${share},
    fill(id, run_id, seq, ordinal, n) AS (
      SELECT id, run_id, seq, ordinal, 1 FROM heads
      UNION ALL
      SELECT e.id, e."workflowRunId", e.sequence, fill.ordinal, fill.n + 1
      FROM fill CROSS JOIN "outbox_events" e ${primary}
      WHERE fill.n < (SELECT take FROM share)
        AND e.id = ${head(
          '"workflowRunId" = fill.run_id AND sequence > fill.seq',
        )}
    ), chosen AS MATERIALIZED (SELECT id, ordinal FROM fill)
    UPDATE "outbox_events" ${primary} SET "deliveryClaim" =
      (${rankSql(true, "chosen.ordinal")})
    FROM chosen WHERE chosen.id = "outbox_events".id
      AND "outbox_events".id IN (SELECT id FROM chosen)
    RETURNING *`,
    args,
  };
}

/**
 * The PostgreSQL walk locks each run before it claims there: the run's
 * first retained event (the anchor) with `FOR UPDATE SKIP LOCKED`, then the
 * head. Updating the anchor changes its tuple version (xmin). A contender
 * with an older statement snapshot cannot claim using that version, even
 * after the winning statement commits and unlocks it. A run's later events
 * are covered by its anchor lock and the active-claim check its head passed.
 * The write skips a row a peer published or dead-lettered since the snapshot.
 */
export function postgresOutboxClaim(page: OutboxClaimPage) {
  const { args, eligible } = bindings(page);
  const head = (where: string) =>
    `SELECT id, "workflowRunId", sequence FROM "outbox_events"
      WHERE ${live} ${
        where ? `AND ${where}` : ""
      } ORDER BY ${headOrder} LIMIT 1`;
  const run = 'step."workflowRunId"';
  const next = steps(head)
    .map(([guard, seek]) => `(SELECT n.* FROM (${seek}) n WHERE ${guard})`)
    .join("\n        UNION ALL ");
  return {
    sql: `WITH RECURSIVE ${cursorCte(false)},
    walk(id, anchor, run_id, seq, wrapped, claimed, served, visit) AS (
      SELECT NULL::text, NULL::text, (SELECT run_id FROM cursor), NULL::int, 0, 0, 0, 0
      UNION ALL
      SELECT step.id, anchor.id, ${run}, step.sequence, ${wrapped(run)},
        (locked.id IS NOT NULL)::int, walk.served + walk.claimed, walk.visit + 1
      FROM walk CROSS JOIN LATERAL (
        ${next}
        LIMIT 1
      ) step
      LEFT JOIN LATERAL (
        SELECT e.id FROM "outbox_events" e
        WHERE ${["id", "xmin"]
          .map(
            // Scalar subqueries keep the primary-key probe an index condition
            // whatever the statistics; a join can become a filter on a scan.
            (column) => `e.${column} = (SELECT ${column} FROM "outbox_events"
            WHERE "workflowRunId" = ${run} ORDER BY sequence LIMIT 1)`,
          )
          .join(" AND ")}
          AND ${eligible(run)} ${noActiveClaim(run)}
        FOR UPDATE OF e SKIP LOCKED
      ) anchor ON true
      LEFT JOIN LATERAL (
        SELECT e.id FROM "outbox_events" e
        WHERE anchor.id IS NOT NULL AND e.id = step.id
        FOR UPDATE OF e SKIP LOCKED
      ) locked ON true
      WHERE walk.served + walk.claimed < $1
    ), heads AS MATERIALIZED (
      SELECT id, anchor, run_id, seq, visit AS ordinal FROM walk WHERE claimed = 1
    ), ${share},
    fill(id, run_id, seq, ordinal, n) AS (
      SELECT id, run_id, seq, ordinal, 1 FROM heads
      UNION ALL
      SELECT n.id, n."workflowRunId", n.sequence, fill.ordinal, fill.n + 1
      FROM fill CROSS JOIN LATERAL (
        ${head('"workflowRunId" = fill.run_id AND sequence > fill.seq')}
      ) n
      WHERE fill.n < (SELECT take FROM share)
    ), chosen AS MATERIALIZED (SELECT id, ordinal FROM fill),
    updated AS (
      UPDATE "outbox_events" e SET "deliveryClaim" =
        CASE WHEN e.id = ANY(ARRAY(SELECT id FROM chosen))
            AND e."publishedAt" IS NULL AND e."dlqAt" IS NULL
          THEN (${rankSql(
            false,
            "(SELECT ordinal FROM chosen WHERE chosen.id = e.id)",
          )})
          ELSE e."deliveryClaim" END
      WHERE e.id = ANY(ARRAY(SELECT id FROM chosen UNION ALL SELECT anchor FROM heads))
      RETURNING e.*
    )
    SELECT updated.* FROM updated JOIN chosen USING (id)
    WHERE updated."publishedAt" IS NULL AND updated."dlqAt" IS NULL`,
    args,
  };
}
