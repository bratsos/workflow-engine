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
}

const live = '"publishedAt" IS NULL AND "dlqAt" IS NULL';
const headOrder = '"publishedAt", "dlqAt", "workflowRunId", sequence';

function pageBindings(page: OutboxClaimPage, sqlite = false) {
  const args: (string | number)[] = [page.limit, page.deadline];
  if (sqlite) args.push(page.claim);
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
  // Normally the head carries the lease. After replay, its already claimed
  // successor may still carry it. Seek to the live lease in either case.
  return `(
    SELECT "deliveryClaim" FROM "outbox_events" ${index}
    WHERE ${live} AND "workflowRunId" = ${run} AND "deliveryClaim" > $2
    ORDER BY "publishedAt", "dlqAt", "workflowRunId", "deliveryClaim" LIMIT 1
  ) IS NULL`;
}

export function sqliteOutboxClaim(page: OutboxClaimPage) {
  const { args, head, start, eligible } = pageBindings(page, true);
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
    )
    UPDATE "outbox_events" ${primary} SET "deliveryClaim" = $3
    WHERE id IN (SELECT id FROM walk WHERE available)
    RETURNING *`,
    args,
  };
}

export function postgresOutboxCandidates(page: OutboxClaimPage) {
  const { args, head, start, eligible } = pageBindings(page);
  // Serialize competing claims for the same run, even if a replay changed
  // which row one of them saw as its head. The first retained row is a lock
  // target only. It need not be live, and appending does not lock it.
  const locks = `LEFT JOIN LATERAL (
    SELECT e.id FROM "outbox_events" e
    WHERE e.id = (
      SELECT id FROM "outbox_events" WHERE "workflowRunId" = head."workflowRunId"
      ORDER BY sequence LIMIT 1
    ) AND ${eligible('head."workflowRunId"')} ${noActiveClaim('head."workflowRunId"')}
    FOR UPDATE OF e SKIP LOCKED
  ) anchor ON true
  LEFT JOIN LATERAL (
    SELECT e.id FROM "outbox_events" e
    WHERE anchor.id IS NOT NULL AND e.id = head.id
    FOR UPDATE OF e SKIP LOCKED
  ) locked ON true`;
  return {
    sql: `WITH RECURSIVE walk(run_id, id, served) AS (
      SELECT head."workflowRunId", locked.id, (locked.id IS NOT NULL)::int
      FROM (${head(start)}) head ${locks}
      UNION ALL
      SELECT head."workflowRunId", locked.id, walk.served + (locked.id IS NOT NULL)::int
      FROM walk CROSS JOIN LATERAL (
        ${head('AND "workflowRunId" > walk.run_id')}
      ) head ${locks}
      WHERE walk.served < $1
    )
    SELECT id, run_id AS "workflowRunId" FROM walk
    WHERE id IS NOT NULL ORDER BY served`,
    args,
  };
}

export function postgresOutboxWrite(
  page: OutboxClaimPage,
  candidates: readonly { id: string; workflowRunId: string }[],
) {
  // READ COMMITTED gives this statement a fresh snapshot after the locks.
  // A competitor can acquire and release the anchor between our initial
  // snapshot and lock acquisition. Check both the head and the lease again.
  return {
    sql: `UPDATE "outbox_events" SET "deliveryClaim" = $1
    WHERE id = ANY(ARRAY(
      SELECT candidate.id FROM unnest($3::text[], $4::text[]) candidate(id, "workflowRunId")
      WHERE candidate.id = (
        SELECT id FROM "outbox_events" WHERE ${live}
          AND "workflowRunId" = candidate."workflowRunId"
        ORDER BY ${headOrder} LIMIT 1
      ) AND ${noActiveClaim('candidate."workflowRunId"')}
    )) RETURNING *`,
    args: [
      page.claim,
      page.deadline,
      candidates.map(({ id }) => id),
      candidates.map(({ workflowRunId }) => workflowRunId),
    ],
  };
}
