/**
 * PrismaWorkflowPersistence - Prisma implementation of WorkflowPersistence
 *
 * This is the default persistence implementation used by the workflow engine.
 * It wraps Prisma client operations to match the WorkflowPersistence interface.
 */

import type {
  AnnotationFilters,
  CreateAnnotationInput,
  CreateDefinitionInput,
  CreateLogInput,
  CreateOutboxEventInput,
  CreateRunInput,
  CreateStageInput,
  DefinitionVersionCount,
  DefinitionVersionCountFilter,
  OutboxRecord,
  SaveArtifactInput,
  ServedDefinition,
  Status,
  UpdateRunInput,
  UpdateStageInput,
  UpsertStageInput,
  WorkflowAnnotationRecord,
  WorkflowArtifactRecord,
  WorkflowDefinitionRecord,
  WorkflowPersistence,
  WorkflowRunRecord,
  WorkflowStageRecord,
} from "../interface";
import { StaleVersionError } from "../interface";
import { createEnumHelper, type PrismaEnumHelper } from "./enum-compat";
import type { EnginePrismaClient } from "./prisma-client-type";
import { utcTimestampParam } from "./utc-timestamps";

// Structural client type -- see prisma-client-type.ts. Kept as a local
// alias so the rest of this file (and its many `PrismaClient`-typed
// locals/params) doesn't need to change name.
type PrismaClient = EnginePrismaClient;

export type DatabaseType = "postgresql" | "sqlite";

export interface PrismaWorkflowPersistenceOptions {
  /**
   * Database type. Defaults to "postgresql".
   * Set to "sqlite" when using SQLite (uses optimistic locking instead of FOR UPDATE SKIP LOCKED).
   */
  databaseType?: DatabaseType;
  /**
   * Skip interactive transactions. Defaults to false.
   * Set to true in single-process environments where transactions are not needed.
   */
  skipInteractiveTransactions?: boolean;
  /**
   * Name of the Prisma enum behind `status` columns. Defaults to `"Status"`.
   * The Postgres claim path casts with `::"<name>"` (since 0.11); a schema
   * that names the enum differently (`WorkflowStatus`) fails with
   * `42704 type "Status" does not exist` without this.
   */
  statusEnumName?: string;
  /**
   * Time source for the timestamps the raw claim statement writes. Defaults
   * to `() => new Date()`. Bound as a parameter rather than `NOW()` so the
   * value is UTC like every Prisma write, and honours an injected clock.
   */
  now?: () => Date;
  /**
   * Whether the schema behind this client carries definition versioning
   * (`workflow_runs.definitionVersion`, `workflow_runs.redriveCount` and
   * the `workflow_definitions` table).
   *
   * Left unset, it is detected in two stages. The generated client is
   * checked synchronously (versioning is off unless the client exposes a
   * `workflowDefinition` model), and the *database* is checked once,
   * lazily, the first time a versioning-sensitive path runs — see
   * {@link PrismaWorkflowPersistence.ensureDefinitionVersioningDetected}.
   * The client check alone is not enough: `prisma generate` after editing
   * the schema but before `migrate deploy` (every consumer passes through
   * that state, and so does any rolling deploy that ships code first)
   * leaves a client that advertises the models against a database that
   * has neither, and every claim then dies with a raw `42703`.
   *
   * Set it explicitly to skip both checks: `false` on a client whose
   * schema carries the models but whose database is deliberately left
   * unmigrated, `true` on a client whose model surface the structural
   * detection cannot see (a hand-written wrapper, a proxy).
   */
  definitionVersioning?: boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when the generated client exposes the `workflow_definitions` model. */
function detectDefinitionVersioning(prisma: PrismaClient): boolean {
  const model = prisma.workflowDefinition;
  return (
    typeof model?.findUnique === "function" &&
    typeof model?.create === "function"
  );
}

/**
 * Capability state, shared by reference between a persistence and every
 * transactional clone of it, so the database probe below runs once per
 * client and a downgrade one of them discovers is visible to all of them.
 */
interface DefinitionVersioningState {
  /** Current best knowledge: whether versioning columns may be touched. */
  enabled: boolean;
  /** True when the caller configured the answer, so nothing may probe. */
  pinned: boolean;
  /** The in-flight or settled probe, memoised. */
  probe: Promise<boolean> | null;
}

/**
 * Asks the *database* whether the definition-versioning schema is present.
 *
 * Deliberately a catalogue read and nothing else. A probe that touched the
 * real tables (`SELECT "definitionVersion" FROM "workflow_runs" LIMIT 0`)
 * would raise `42703` on an unmigrated database, and an error inside a
 * consumer's interactive transaction aborts *their* transaction — the one
 * thing this adapter must never do. `to_regclass` and `pragma_table_info`
 * return "absent" rather than raising, so this is safe to run anywhere,
 * including inside someone else's transaction.
 *
 * Returns `null` when the answer cannot be established (no raw-query
 * escape hatch, an unrecognised database, or an unexpected failure), in
 * which case the caller keeps the structural answer it already had.
 */
async function probeDefinitionVersioningSchema(
  prisma: PrismaClient,
  databaseType: DatabaseType,
): Promise<boolean | null> {
  // Called through `prisma.` rather than a destructured local: Prisma's
  // runtime reads internal state off `this` inside its own method bodies.
  if (typeof prisma.$queryRawUnsafe !== "function") return null;
  const sql =
    databaseType === "postgresql"
      ? `SELECT
           (to_regclass('"workflow_definitions"') IS NOT NULL) AS has_table,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_attribute
             WHERE attrelid = to_regclass('"workflow_runs"')
               AND attname = 'definitionVersion'
               AND NOT attisdropped
           ) AS has_column`
      : databaseType === "sqlite"
        ? `SELECT
             (SELECT COUNT(*) FROM sqlite_master
               WHERE type = 'table' AND name = 'workflow_definitions') AS has_table,
             (SELECT COUNT(*) FROM pragma_table_info('workflow_runs')
               WHERE name = 'definitionVersion') AS has_column`
        : null;
  if (sql === null) return null;
  try {
    const rows =
      await prisma.$queryRawUnsafe<
        Array<{ has_table: unknown; has_column: unknown }>
      >(sql);
    const row = rows[0];
    if (!row) return null;
    return truthy(row.has_table) && truthy(row.has_column);
  } catch {
    // A catalogue read should not fail; if it does, the safe answer is
    // "no new information" rather than turning a working process off.
    return null;
  }
}

/** Postgres returns booleans, SQLite returns 0/1 (as number or bigint). */
function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "number") return value !== 0;
  return false;
}

const IDEMPOTENCY_IN_PROGRESS_MARKER = {
  __workflowEngineState: "in_progress",
};

/**
 * Bounds retry loops for optimistic-lock claim/dequeue paths so heavy
 * contention degrades to "try again later" instead of unbounded recursion.
 */
const MAX_CLAIM_ATTEMPTS = 10;

function isInProgressResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return (
    (result as Record<string, unknown>).__workflowEngineState === "in_progress"
  );
}

export class PrismaWorkflowPersistence implements WorkflowPersistence {
  private enums: PrismaEnumHelper;
  private databaseType: DatabaseType;
  private skipTransactions: boolean;
  private statusEnumName: string;
  private now: () => Date;
  /**
   * Shared with every transactional clone (see `withTransaction`), so the
   * database probe runs once per client rather than once per transaction.
   */
  private versioning: DefinitionVersioningState;

  /** The options as given, re-applied to every transactional clone. */
  private readonly options: PrismaWorkflowPersistenceOptions;

  constructor(
    private readonly prisma: PrismaClient,
    options: PrismaWorkflowPersistenceOptions = {},
  ) {
    this.options = options;
    this.statusEnumName = options.statusEnumName ?? "Status";
    if (!IDENTIFIER.test(this.statusEnumName)) {
      throw new Error(
        `statusEnumName must be a plain SQL identifier, got "${this.statusEnumName}"`,
      );
    }
    this.enums = createEnumHelper(prisma, {
      statusEnumName: this.statusEnumName,
    });
    this.databaseType = options.databaseType ?? "postgresql";
    this.skipTransactions = options.skipInteractiveTransactions ?? false;
    this.now = options.now ?? (() => new Date());
    this.versioning = {
      enabled:
        options.definitionVersioning ?? detectDefinitionVersioning(prisma),
      pinned: options.definitionVersioning !== undefined,
      probe: null,
    };
  }

  supportsDefinitionVersioning(): boolean {
    return this.versioning.enabled;
  }

  /**
   * Confirms the synchronous capability guess against the database, once
   * per client, and returns the answer every later
   * `supportsDefinitionVersioning()` will give.
   *
   * The guess is structural: it reads the *generated client*, so it is
   * true the moment `prisma generate` runs, which is before `migrate
   * deploy` on every first migration and on any rolling deploy that ships
   * code ahead of its migration. Left unconfirmed, `run.create` fails
   * `P2022`, `insertDefinitionIfAbsent` fails `P2021` and every claim dies
   * on a raw `42703` — the process cannot serve a single run.
   *
   * The confirmation only ever turns versioning *off*: a client with no
   * `workflowDefinition` delegate cannot use the tables however migrated
   * the database is. It is a catalogue read (see
   * `probeDefinitionVersioningSchema`), so it cannot abort a caller's
   * transaction, and it is skipped entirely when `definitionVersioning`
   * was configured explicitly.
   *
   * Called by the kernel from the paths that would otherwise touch the
   * columns — `run.create`'s snapshot recording, `run.claimPending` and
   * `run.listVersions` — so consumers do not have to call it themselves.
   */
  async ensureDefinitionVersioningDetected(): Promise<boolean> {
    const state = this.versioning;
    if (state.pinned || !state.enabled) return state.enabled;
    state.probe ??= probeDefinitionVersioningSchema(
      this.prisma,
      this.databaseType,
    ).then((result) => {
      if (result === false) state.enabled = false;
      return state.enabled;
    });
    return state.probe;
  }

  async withTransaction<T>(
    fn: (tx: WorkflowPersistence) => Promise<T>,
  ): Promise<T> {
    if (
      this.skipTransactions ||
      typeof this.prisma.$transaction !== "function"
    ) {
      return fn(this);
    }
    return this.prisma.$transaction(async (tx: PrismaClient) => {
      // The transactional clone must carry every option: a clone built
      // without `statusEnumName` cast with `::"Status"` inside the
      // transaction (`42704 type "Status" does not exist` on every
      // `run.claimPending` for a schema that names the enum differently).
      const txPersistence = new PrismaWorkflowPersistence(tx, this.options);
      // Share the capability state by reference: the clone must not
      // re-probe on every transaction, and a downgrade either side
      // discovers has to be visible to the other.
      txPersistence.versioning = this.versioning;
      return fn(txPersistence);
    });
  }

  // ============================================================================
  // WorkflowRun Operations
  // ============================================================================

  async createRun(data: CreateRunInput): Promise<WorkflowRunRecord> {
    const run = await this.prisma.workflowRun.create({
      data: {
        id: data.id,
        workflowId: data.workflowId,
        workflowName: data.workflowName,
        workflowType: data.workflowType,
        input: data.input as unknown,
        config: (data.config ?? {}) as unknown,
        priority: data.priority ?? 5,
        metadata: (data.metadata ?? null) as unknown,
        // Only written when the schema has the column: on an unmigrated
        // database Prisma would reject the unknown argument and every
        // run.create would fail.
        ...(this.versioning.enabled
          ? { definitionVersion: data.definitionVersion ?? null }
          : {}),
      },
    });
    return this.mapWorkflowRun(run);
  }

  async updateRun(id: string, data: UpdateRunInput): Promise<void> {
    const updateData = this.buildRunUpdateData(data);

    if (data.expectedVersion === undefined) {
      await this.prisma.workflowRun.update({
        where: { id },
        data: { ...updateData, version: { increment: 1 } },
      });
      return;
    }

    const result = await this.prisma.workflowRun.updateMany({
      where: { id, version: data.expectedVersion },
      data: {
        ...updateData,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      const current = await this.prisma.workflowRun.findUnique({
        where: { id },
        select: { version: true },
      });
      throw new StaleVersionError(
        "WorkflowRun",
        id,
        data.expectedVersion,
        current?.version ?? -1,
      );
    }
  }

  async getRun(id: string): Promise<WorkflowRunRecord | null> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id } });
    return run ? this.mapWorkflowRun(run) : null;
  }

  async getRunStatus(id: string): Promise<Status | null> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id },
      select: { status: true },
    });
    return run?.status ?? null;
  }

  async getRunsByStatus(status: Status): Promise<WorkflowRunRecord[]> {
    const runs = await this.prisma.workflowRun.findMany({
      where: { status: this.enums.status(status) },
      orderBy: { createdAt: "asc" },
    });
    return runs.map((run: any) => this.mapWorkflowRun(run));
  }

  async getStuckRuns(stuckSince: Date): Promise<WorkflowRunRecord[]> {
    // Find RUNNING runs where both the run and ALL its stages
    // have not been updated since the threshold.
    const runs = await this.prisma.workflowRun.findMany({
      where: {
        status: this.enums.status("RUNNING"),
        updatedAt: { lte: stuckSince },
        // No stage updated after the threshold
        stages: {
          none: {
            updatedAt: { gt: stuckSince },
          },
        },
      },
      orderBy: { updatedAt: "asc" },
    });
    return runs.map((run: any) => this.mapWorkflowRun(run));
  }

  async claimPendingRun(id: string): Promise<boolean> {
    // Atomic update: only succeeds if status is still PENDING
    // This prevents race conditions when multiple workers try to claim the same run
    const result = await this.prisma.workflowRun.updateMany({
      where: {
        id,
        status: this.enums.status("PENDING"),
      },
      data: {
        status: this.enums.status("RUNNING"),
        startedAt: new Date(),
        version: { increment: 1 },
      },
    });

    // updateMany returns { count: N } - if count is 0, another worker already claimed it
    return result.count > 0;
  }

  async claimNextPendingRun(options?: {
    now?: Date;
    serves?: readonly ServedDefinition[];
  }): Promise<WorkflowRunRecord | null> {
    // A schema without the column cannot be filtered on it; such a
    // database has no pinned runs either, so ignoring `serves` is exact.
    const serves = this.versioning.enabled ? options?.serves : undefined;
    if (this.databaseType === "sqlite") {
      return this.claimNextPendingRunOptimistic(0, serves);
    }
    // The tagged-template path cannot bind a variadic row-value IN list,
    // so a version-filtered claim on a client without $queryRawUnsafe
    // falls back to the optimistic loop rather than dropping the filter.
    if (serves !== undefined && !this.prisma.$queryRawUnsafe) {
      return this.claimNextPendingRunOptimistic(0, serves);
    }
    return this.claimNextPendingRunPostgres(options?.now ?? this.now(), serves);
  }

  /**
   * Prisma `where` clause restricting a claim to the definitions a host
   * serves: a run pinned to a version in `serves`, or an unpinned run —
   * one created before the consumer migrated — of a workflow this host
   * *has*.
   *
   * The workflow-id restriction on the unpinned arm is the point. Left off,
   * the pre-migration population is claimable by every host in the fleet
   * including one whose registry has never heard of the workflow, and
   * `run.claimPending` then adopts it and marks it FAILED with
   * `WORKFLOW_NOT_FOUND` — destroying, at claim time, exactly the runs
   * versioning exists to protect. Deciding it here rather than after
   * adopting the row means the host never takes work it cannot do.
   *
   * `serves` empty means the registry enumerated no workflows: this host
   * serves nothing, and the honest predicate is "no row".
   */
  private servesFilter(
    serves: readonly ServedDefinition[],
  ): Record<string, unknown> {
    // `id IN ()` rather than `OR: []`: unambiguously "no row" on every
    // Prisma version, where an empty `OR` has changed meaning between them.
    if (serves.length === 0) return { id: { in: [] as string[] } };
    const workflowIds = [...new Set(serves.map((s) => s.workflowId))];
    return {
      OR: [
        { definitionVersion: null, workflowId: { in: workflowIds } },
        ...serves.map((s) => ({
          workflowId: s.workflowId,
          definitionVersion: s.version,
        })),
      ],
    };
  }

  /**
   * PostgreSQL implementation using FOR UPDATE SKIP LOCKED for zero-contention claiming.
   * This atomically:
   * 1. Finds the highest priority PENDING run (FIFO within same priority)
   * 2. Locks it exclusively (other workers skip locked rows)
   * 3. Updates it to RUNNING
   * 4. Returns the claimed run
   */
  private async claimNextPendingRunPostgres(
    now: Date,
    serves?: readonly ServedDefinition[],
  ): Promise<WorkflowRunRecord | null> {
    // NOTE: deliberately calling `this.prisma.$queryRawUnsafe` /
    // `$queryRaw` directly below rather than destructuring into a local
    // first -- Prisma's runtime reads internal state off `this` inside its
    // own method bodies, so an unbound reference throws at call time.
    //
    // The enum type name is an identifier, which a tagged template cannot
    // bind, so the statement is built as text with positional parameters
    // for every value. Timestamps are bound JS Dates from the injected
    // clock and converted with `AT TIME ZONE 'UTC'` -- never `NOW()`, and
    // never a bare parameter, both of which write session-local time into
    // the naive TIMESTAMP columns Prisma fills with UTC (see
    // utc-timestamps.ts).
    const pending = this.enums.status("PENDING");
    const running = this.enums.status("RUNNING");
    let results: any[];
    if (this.prisma.$queryRawUnsafe) {
      const enumType = `"${this.statusEnumName}"`;
      // $1 = PENDING, $2 = RUNNING, $3 = now; the served (workflowId,
      // version) pairs, if any, are bound from $4 onwards as row values.
      const extraParams: unknown[] = [];
      let servesClause = "";
      if (serves !== undefined) {
        if (serves.length === 0) {
          // The registry enumerated nothing: this host serves no workflow,
          // so it claims no run. Claiming the unpinned population here
          // (the pre-1.0 predicate) hands it runs it will immediately fail
          // with WORKFLOW_NOT_FOUND.
          servesClause = `AND false`;
        } else {
          const rows = serves.map((s) => {
            const base = 4 + extraParams.length;
            extraParams.push(s.workflowId, s.version);
            return `($${base}, $${base + 1})`;
          });
          const ids = [...new Set(serves.map((s) => s.workflowId))].map(
            (workflowId) => {
              extraParams.push(workflowId);
              return `$${3 + extraParams.length}`;
            },
          );
          // Two arms, and the second one's workflow-id restriction is the
          // point: an unpinned run (created before the consumer migrated)
          // is claimable by any host that *has* the workflow, but not by a
          // host whose registry has never heard of it — which would adopt
          // it and mark it FAILED with WORKFLOW_NOT_FOUND.
          servesClause = `AND (("workflowId", "definitionVersion") IN (${rows.join(", ")})
            OR ("definitionVersion" IS NULL AND "workflowId" IN (${ids.join(", ")})))`;
        }
      }
      results = await this.prisma.$queryRawUnsafe<any[]>(
        `WITH claimed AS (
          SELECT id
          FROM "workflow_runs"
          WHERE status = $1::${enumType}
          ${servesClause}
          ORDER BY priority DESC, "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "workflow_runs"
        SET status = $2::${enumType},
            "startedAt" = ${utcTimestampParam(3)},
            "updatedAt" = ${utcTimestampParam(3)},
            version = version + 1
        FROM claimed
        WHERE "workflow_runs".id = claimed.id
        RETURNING "workflow_runs".*`,
        pending,
        running,
        now,
        ...extraParams,
      );
    } else if (this.prisma.$queryRaw) {
      if (this.statusEnumName !== "Status") {
        throw new Error(
          "statusEnumName requires a Prisma client with $queryRawUnsafe (the Postgres claimNextPendingRun path)",
        );
      }
      results = await this.prisma.$queryRaw<any[]>`
        WITH claimed AS (
          SELECT id
          FROM "workflow_runs"
          WHERE status = ${pending}::"Status"
          ORDER BY priority DESC, "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "workflow_runs"
        SET status = ${running}::"Status",
            "startedAt" = ${now}::timestamptz AT TIME ZONE 'UTC',
            "updatedAt" = ${now}::timestamptz AT TIME ZONE 'UTC',
            version = version + 1
        FROM claimed
        WHERE "workflow_runs".id = claimed.id
        RETURNING "workflow_runs".*
      `;
    } else {
      throw new Error(
        "Prisma client does not support $queryRawUnsafe or $queryRaw (required for the Postgres claimNextPendingRun path)",
      );
    }

    if (results.length === 0) {
      return null;
    }

    return this.mapWorkflowRun(results[0]);
  }

  /**
   * SQLite implementation using optimistic locking.
   * SQLite doesn't support FOR UPDATE SKIP LOCKED, so we use a two-step approach:
   * 1. Find a PENDING run
   * 2. Atomically update it (only succeeds if still PENDING)
   * 3. If another worker claimed it, retry
   */
  private async claimNextPendingRunOptimistic(
    attempt = 0,
    serves?: readonly ServedDefinition[],
  ): Promise<WorkflowRunRecord | null> {
    if (attempt >= MAX_CLAIM_ATTEMPTS) {
      return null;
    }

    // Step 1: Find the next PENDING run this host can serve
    const run = await this.prisma.workflowRun.findFirst({
      where: {
        status: this.enums.status("PENDING"),
        ...(serves !== undefined ? this.servesFilter(serves) : {}),
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    });

    if (!run) {
      return null;
    }

    // Step 2: Atomically claim it (only succeeds if still PENDING)
    const result = await this.prisma.workflowRun.updateMany({
      where: {
        id: run.id,
        status: this.enums.status("PENDING"), // Optimistic lock
      },
      data: {
        status: this.enums.status("RUNNING"),
        startedAt: new Date(),
        updatedAt: new Date(),
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      // Another worker claimed it, retry (bounded to avoid unbounded
      // recursion under heavy contention)
      return this.claimNextPendingRunOptimistic(attempt + 1, serves);
    }

    // Fetch the updated record
    const claimedRun = await this.prisma.workflowRun.findUnique({
      where: { id: run.id },
    });

    return claimedRun ? this.mapWorkflowRun(claimedRun) : null;
  }

  // ============================================================================
  // WorkflowDefinition Operations
  // ============================================================================

  async insertDefinitionIfAbsent(
    input: CreateDefinitionInput,
  ): Promise<WorkflowDefinitionRecord | null> {
    const model = this.prisma.workflowDefinition;
    if (!this.versioning.enabled || !model) return null;
    const existing = await model.findUnique({
      where: {
        workflowId_version: {
          workflowId: input.workflowId,
          version: input.version,
        },
      },
    });
    if (existing) return this.mapDefinition(existing);

    try {
      const created = await model.create({
        data: {
          workflowId: input.workflowId,
          version: input.version,
          snapshot: input.snapshot as unknown,
          structureHash: input.structureHash,
        },
      });
      return this.mapDefinition(created);
    } catch {
      // Lost the insert race with a concurrent run.create for the same
      // version -- the row is content-addressed, so the winner's row is
      // the answer either way.
      const raced = await model.findUnique({
        where: {
          workflowId_version: {
            workflowId: input.workflowId,
            version: input.version,
          },
        },
      });
      if (!raced)
        throw new Error(
          `Could not store definition snapshot for workflow "${input.workflowId}" version "${input.version}".`,
        );
      return this.mapDefinition(raced);
    }
  }

  async getDefinition(
    workflowId: string,
    version: string,
  ): Promise<WorkflowDefinitionRecord | null> {
    const model = this.prisma.workflowDefinition;
    if (!this.versioning.enabled || !model) return null;
    const row = await model.findUnique({
      where: { workflowId_version: { workflowId, version } },
    });
    return row ? this.mapDefinition(row) : null;
  }

  async countRunsByDefinitionVersion(
    filter?: DefinitionVersionCountFilter,
  ): Promise<DefinitionVersionCount[]> {
    if (!this.versioning.enabled) return [];
    const groupBy = this.prisma.workflowRun.groupBy;
    if (typeof groupBy !== "function") {
      throw new Error(
        "countRunsByDefinitionVersion requires a Prisma client whose workflowRun delegate supports groupBy.",
      );
    }
    const where: Record<string, unknown> = {};
    if (filter?.workflowId) where.workflowId = filter.workflowId;
    if (filter?.definitionVersion !== undefined) {
      where.definitionVersion = filter.definitionVersion;
    }
    if (filter?.status && filter.status.length > 0) {
      where.status = { in: filter.status.map((v) => this.enums.status(v)) };
    }

    const grouped = await groupBy.call(this.prisma.workflowRun, {
      by: ["workflowId", "definitionVersion", "status"],
      where,
      _count: { _all: true },
      _min: { createdAt: true },
    });

    return (grouped as any[]).map((row) => ({
      workflowId: row.workflowId,
      definitionVersion: row.definitionVersion ?? null,
      status: row.status as Status,
      count: row._count?._all ?? 0,
      oldestCreatedAt: row._min?.createdAt ?? null,
    }));
  }

  private mapDefinition(row: any): WorkflowDefinitionRecord {
    return {
      workflowId: row.workflowId,
      version: row.version,
      createdAt: row.createdAt,
      snapshot: row.snapshot,
      structureHash: row.structureHash,
    };
  }

  // ============================================================================
  // WorkflowStage Operations
  // ============================================================================

  async createStage(data: CreateStageInput): Promise<WorkflowStageRecord> {
    const stage = await this.prisma.workflowStage.create({
      data: {
        workflowRunId: data.workflowRunId,
        stageId: data.stageId,
        stageName: data.stageName,
        stageNumber: data.stageNumber,
        executionGroup: data.executionGroup,
        attempt: data.attempt ?? 0,
        status: data.status
          ? this.enums.status(data.status)
          : this.enums.status("PENDING"),
        startedAt: data.startedAt,
        config: data.config as unknown,
        inputData: data.inputData as unknown,
      },
    });
    return this.mapWorkflowStage(stage);
  }

  async upsertStage(data: UpsertStageInput): Promise<WorkflowStageRecord> {
    const stage = await this.prisma.workflowStage.upsert({
      where: {
        workflowRunId_stageId: {
          workflowRunId: data.workflowRunId,
          stageId: data.stageId,
        },
      },
      create: {
        workflowRunId: data.create.workflowRunId,
        stageId: data.create.stageId,
        stageName: data.create.stageName,
        stageNumber: data.create.stageNumber,
        executionGroup: data.create.executionGroup,
        attempt: data.create.attempt ?? 0,
        status: data.create.status
          ? this.enums.status(data.create.status)
          : this.enums.status("RUNNING"),
        startedAt: data.create.startedAt ?? new Date(),
        config: data.create.config as unknown,
        inputData: data.create.inputData as unknown,
      },
      update: {
        ...this.buildStageUpdateData(data.update),
        version: { increment: 1 },
      },
    });
    return this.mapWorkflowStage(stage);
  }

  async updateStage(id: string, data: UpdateStageInput): Promise<void> {
    const updateData = this.buildStageUpdateData(data);

    if (data.expectedVersion === undefined) {
      await this.prisma.workflowStage.update({
        where: { id },
        data: { ...updateData, version: { increment: 1 } },
      });
      return;
    }

    const result = await this.prisma.workflowStage.updateMany({
      where: { id, version: data.expectedVersion },
      data: {
        ...updateData,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      const current = await this.prisma.workflowStage.findUnique({
        where: { id },
        select: { version: true },
      });
      throw new StaleVersionError(
        "WorkflowStage",
        id,
        data.expectedVersion,
        current?.version ?? -1,
      );
    }
  }

  async updateStageByRunAndStageId(
    workflowRunId: string,
    stageId: string,
    data: UpdateStageInput,
  ): Promise<void> {
    const updateData = this.buildStageUpdateData(data);

    if (data.expectedVersion === undefined) {
      await this.prisma.workflowStage.update({
        where: {
          workflowRunId_stageId: { workflowRunId, stageId },
        },
        data: { ...updateData, version: { increment: 1 } },
      });
      return;
    }

    const result = await this.prisma.workflowStage.updateMany({
      where: {
        workflowRunId,
        stageId,
        version: data.expectedVersion,
      },
      data: {
        ...updateData,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      const current = await this.prisma.workflowStage.findFirst({
        where: { workflowRunId, stageId },
        select: { id: true, version: true },
      });
      throw new StaleVersionError(
        "WorkflowStage",
        current?.id ?? `${workflowRunId}/${stageId}`,
        data.expectedVersion,
        current?.version ?? -1,
      );
    }
  }

  private buildRunUpdateData(data: UpdateRunInput): Record<string, unknown> {
    return {
      status: data.status ? this.enums.status(data.status) : undefined,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      duration: data.duration,
      output: data.output as unknown,
      totalCost: data.totalCost,
      totalTokens: data.totalTokens,
      ...(this.versioning.enabled
        ? {
            definitionVersion: data.definitionVersion,
            redriveCount: data.redriveCount,
          }
        : {}),
    };
  }

  private buildStageUpdateData(
    data: UpdateStageInput,
  ): Record<string, unknown> {
    return {
      status: data.status ? this.enums.status(data.status) : undefined,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      duration: data.duration,
      outputData: data.outputData as unknown,
      config: data.config as unknown,
      suspendedState: data.suspendedState as unknown,
      resumeData: data.resumeData as unknown,
      nextPollAt: data.nextPollAt,
      pollInterval: data.pollInterval,
      maxWaitUntil: data.maxWaitUntil,
      metrics: data.metrics as unknown,
      embeddingInfo: data.embeddingInfo as unknown,
      errorMessage: data.errorMessage,
      attempt: data.attempt,
    };
  }

  async getStage(
    runId: string,
    stageId: string,
  ): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findUnique({
      where: {
        workflowRunId_stageId: { workflowRunId: runId, stageId },
      },
    });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async getStageById(id: string): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findUnique({ where: { id } });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async getStagesByRun(
    runId: string,
    options?: { status?: Status; orderBy?: "asc" | "desc" },
  ): Promise<WorkflowStageRecord[]> {
    const stages = await this.prisma.workflowStage.findMany({
      where: {
        workflowRunId: runId,
        ...(options?.status && { status: this.enums.status(options.status) }),
      },
      orderBy: [
        { executionGroup: options?.orderBy ?? "asc" },
        { stageNumber: options?.orderBy ?? "asc" },
      ],
    });
    return stages.map((s: Record<string, unknown>) => this.mapWorkflowStage(s));
  }

  async getSuspendedStages(
    beforeDate: Date,
    options?: { limit?: number; serves?: readonly ServedDefinition[] },
  ): Promise<WorkflowStageRecord[]> {
    // `serves` filters through the relation to `workflow_runs`, so it can
    // only be applied on a schema that has the column at all.
    const serves = this.versioning.enabled ? options?.serves : undefined;
    const stages = await this.prisma.workflowStage.findMany({
      where: {
        status: this.enums.status("SUSPENDED"),
        nextPollAt: { lte: beforeDate },
        ...(serves !== undefined
          ? { workflowRun: this.servesFilter(serves) }
          : {}),
      },
      include: {
        workflowRun: { select: { workflowType: true } },
      },
      // Oldest deadline first, so the cap below takes the stages that have
      // been waiting longest rather than whatever the heap hands back.
      orderBy: [{ nextPollAt: "asc" }],
      ...(options?.limit !== undefined ? { take: options.limit } : {}),
    });
    return stages.map((s: Record<string, unknown>) => this.mapWorkflowStage(s));
  }

  async getFirstSuspendedStageReadyToResume(
    runId: string,
  ): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findFirst({
      where: {
        workflowRunId: runId,
        status: this.enums.status("SUSPENDED"),
        nextPollAt: null, // Ready to resume (poll cleared by orchestrator)
      },
      // stageNumber tiebreak matches getStagesByRun/InMemoryWorkflowPersistence
      // so ties within an execution group resolve identically on both adapters.
      orderBy: [{ executionGroup: "asc" }, { stageNumber: "asc" }],
    });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async getFirstFailedStage(
    runId: string,
  ): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findFirst({
      where: {
        workflowRunId: runId,
        status: this.enums.status("FAILED"),
      },
      // Ascending -- "first" means earliest in pipeline order (lowest
      // executionGroup/stageNumber), matching InMemoryWorkflowPersistence's
      // getStagesByRun(..., { status: "FAILED" })[0] (default ascending).
      orderBy: [{ executionGroup: "asc" }, { stageNumber: "asc" }],
    });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async getLastCompletedStage(
    runId: string,
  ): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findFirst({
      where: {
        workflowRunId: runId,
        status: this.enums.status("COMPLETED"),
      },
      // stageNumber tiebreak matches getStagesByRun/InMemoryWorkflowPersistence
      // so ties within an execution group resolve identically on both adapters.
      orderBy: [{ executionGroup: "desc" }, { stageNumber: "desc" }],
    });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async getLastCompletedStageBefore(
    runId: string,
    executionGroup: number,
  ): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findFirst({
      where: {
        workflowRunId: runId,
        status: this.enums.status("COMPLETED"),
        executionGroup: { lt: executionGroup },
      },
      // stageNumber tiebreak matches getStagesByRun/InMemoryWorkflowPersistence
      // so ties within an execution group resolve identically on both adapters.
      orderBy: [{ executionGroup: "desc" }, { stageNumber: "desc" }],
    });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async deleteStage(id: string): Promise<void> {
    await this.prisma.workflowStage.delete({ where: { id } });
  }

  // ============================================================================
  // WorkflowLog Operations
  // ============================================================================

  async createLog(data: CreateLogInput): Promise<void> {
    await this.prisma.workflowLog.create({
      data: {
        workflowRunId: data.workflowRunId,
        workflowStageId: data.workflowStageId,
        level: this.enums.logLevel(data.level),
        message: data.message,
        metadata: data.metadata as unknown,
      },
    });
  }

  // ============================================================================
  // WorkflowArtifact Operations
  // ============================================================================

  async saveArtifact(data: SaveArtifactInput): Promise<void> {
    await this.prisma.workflowArtifact.upsert({
      where: {
        workflowRunId_key: {
          workflowRunId: data.workflowRunId,
          key: data.key,
        },
      },
      create: {
        workflowRunId: data.workflowRunId,
        workflowStageId: data.workflowStageId,
        key: data.key,
        type: this.enums.artifactType(data.type),
        data: data.data as unknown,
        size: data.size,
        metadata: data.metadata as unknown,
      },
      update: {
        data: data.data as unknown,
        size: data.size,
        metadata: data.metadata as unknown,
      },
    });
  }

  async loadArtifact(runId: string, key: string): Promise<unknown> {
    const artifact = await this.prisma.workflowArtifact.findUnique({
      where: {
        workflowRunId_key: { workflowRunId: runId, key },
      },
    });
    return artifact?.data;
  }

  async hasArtifact(runId: string, key: string): Promise<boolean> {
    const artifact = await this.prisma.workflowArtifact.findUnique({
      where: {
        workflowRunId_key: { workflowRunId: runId, key },
      },
      select: { id: true },
    });
    return artifact !== null;
  }

  async deleteArtifact(runId: string, key: string): Promise<void> {
    await this.prisma.workflowArtifact.delete({
      where: {
        workflowRunId_key: { workflowRunId: runId, key },
      },
    });
  }

  async listArtifacts(runId: string): Promise<WorkflowArtifactRecord[]> {
    const artifacts = await this.prisma.workflowArtifact.findMany({
      where: { workflowRunId: runId },
    });
    return artifacts.map((a: Record<string, unknown>) =>
      this.mapWorkflowArtifact(a),
    );
  }

  async getStageIdForArtifact(
    runId: string,
    stageId: string,
  ): Promise<string | null> {
    const stage = await this.prisma.workflowStage.findUnique({
      where: {
        workflowRunId_stageId: { workflowRunId: runId, stageId },
      },
      select: { id: true },
    });
    return stage?.id ?? null;
  }

  // ============================================================================
  // WorkflowAnnotation Operations
  // ============================================================================

  async appendAnnotations(inputs: CreateAnnotationInput[]): Promise<void> {
    if (inputs.length === 0) return;

    const rows = inputs.map((input) => ({
      workflowRunId: input.workflowRunId,
      workflowStageRecordId: input.workflowStageRecordId ?? null,
      attempt: input.attempt ?? 0,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      actorKind: input.actor?.kind ?? null,
      actorId: input.actor?.id ?? null,
      actorVersion: input.actor?.version ?? null,
      key: input.key,
      value: input.value as unknown,
      payload: (input.payload ?? null) as unknown,
      idempotencyKey: input.idempotencyKey ?? null,
    }));

    const hasIdempotencyKey = rows.some((r) => r.idempotencyKey !== null);

    // Fast path: no idempotency keys → no dedup needed (NULL values are
    // distinct under the unique constraint). Plain createMany works on
    // both Postgres and SQLite.
    if (!hasIdempotencyKey) {
      await this.prisma.workflowAnnotation.createMany({ data: rows });
      return;
    }

    // Slow path: at least one row has an idempotency key, so the unique
    // constraint on (workflowRunId, key, idempotencyKey) may trigger.
    if (this.databaseType === "postgresql") {
      // Postgres: `createMany({ skipDuplicates: true })` compiles to
      // INSERT ... ON CONFLICT DO NOTHING — single statement, safe
      // inside a transaction. (skipDuplicates is NOT supported on
      // SQLite in Prisma, so we can't use it cross-DB.)
      await this.prisma.workflowAnnotation.createMany({
        data: rows,
        skipDuplicates: true,
      });
      return;
    }

    // SQLite: per-row create + catch P2002. Unlike Postgres, SQLite
    // does not abort the surrounding transaction on a constraint
    // violation, so swallowing the JS error is safe here.
    for (const row of rows) {
      try {
        await this.prisma.workflowAnnotation.create({ data: row });
      } catch (error: any) {
        if (error?.code === "P2002") continue;
        throw error;
      }
    }
  }

  async listAnnotations(
    workflowRunId: string,
    filters: AnnotationFilters = {},
  ): Promise<WorkflowAnnotationRecord[]> {
    const where: Record<string, unknown> = { workflowRunId };

    if (filters.key !== undefined) {
      where.key = filters.key;
    } else if (filters.keyPrefix !== undefined) {
      // NOTE: Prisma's `startsWith` compiles to `LIKE 'prefix%'`. On
      // Postgres this uses the (workflowRunId, key) index. On SQLite the
      // default `LIKE` is case-insensitive and will not use the btree
      // index; high-volume SQLite consumers should keep keys lowercase
      // (engine convention) and accept the scan cost. Documented in the
      // RFC.
      where.key = { startsWith: filters.keyPrefix };
    }

    if (filters.scope !== undefined) where.scope = filters.scope;
    if (filters.scopeId !== undefined) where.scopeId = filters.scopeId;
    if (filters.actorId !== undefined) where.actorId = filters.actorId;
    if (filters.actorKind !== undefined) where.actorKind = filters.actorKind;
    if (filters.attempt !== undefined) where.attempt = filters.attempt;

    if (filters.since !== undefined || filters.until !== undefined) {
      const createdAt: Record<string, Date> = {};
      if (filters.since !== undefined) createdAt.gte = filters.since;
      if (filters.until !== undefined) createdAt.lte = filters.until;
      where.createdAt = createdAt;
    }

    const records = await this.prisma.workflowAnnotation.findMany({
      where,
      // Secondary order by `id` keeps timeline deterministic when many
      // rows are inserted in the same transaction (same `createdAt`).
      // CUIDs are roughly chronological, so this preserves insert order.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: filters.limit ?? 1000,
    });
    return records.map((r: any) => this.mapWorkflowAnnotation(r));
  }

  private mapWorkflowAnnotation(record: any): WorkflowAnnotationRecord {
    return {
      id: record.id,
      createdAt: record.createdAt,
      workflowRunId: record.workflowRunId,
      workflowStageRecordId: record.workflowStageRecordId ?? null,
      attempt: record.attempt ?? 0,
      scope: record.scope,
      scopeId: record.scopeId ?? null,
      actorKind: record.actorKind ?? null,
      actorId: record.actorId ?? null,
      actorVersion: record.actorVersion ?? null,
      key: record.key,
      value: record.value,
      payload: record.payload ?? null,
      idempotencyKey: record.idempotencyKey ?? null,
    };
  }

  // ============================================================================
  // Stage Output Convenience Methods
  // ============================================================================

  async saveStageOutput(
    runId: string,
    workflowType: string,
    stageId: string,
    output: unknown,
  ): Promise<string> {
    // Generate key with consistent pattern: workflow-v2/{type}/{runId}/{stageId}/output.json
    const key = `workflow-v2/${workflowType}/${runId}/${stageId}/output.json`;

    const json = JSON.stringify(output);
    const size = Buffer.byteLength(json, "utf8");

    // Get the workflowStage record ID for linking
    const workflowStageId = await this.getStageIdForArtifact(runId, stageId);

    await this.prisma.workflowArtifact.upsert({
      where: {
        workflowRunId_key: { workflowRunId: runId, key },
      },
      update: {
        data: output as unknown,
        size,
        workflowStageId,
      },
      create: {
        workflowRunId: runId,
        workflowStageId,
        key,
        type: this.enums.artifactType("STAGE_OUTPUT"),
        data: output as unknown,
        size,
      },
    });

    return key;
  }

  // ============================================================================
  // Outbox Operations
  // ============================================================================

  async appendOutboxEvents(events: CreateOutboxEventInput[]): Promise<void> {
    if (events.length === 0) return;

    // Group by workflowRunId to assign sequences per-run
    const byRun = new Map<string, CreateOutboxEventInput[]>();
    for (const event of events) {
      const list = byRun.get(event.workflowRunId) ?? [];
      list.push(event);
      byRun.set(event.workflowRunId, list);
    }

    for (const [workflowRunId, runEvents] of byRun) {
      await this.appendOutboxEventsForRun(workflowRunId, runEvents);
    }
  }

  /**
   * Assigns sequential `sequence` numbers for a single run's outbox events
   * and inserts them.
   *
   * `pg_advisory_xact_lock` only serializes concurrent callers when this
   * call is itself running inside a real database transaction (i.e. this
   * instance was produced by `withTransaction`) — outside a transaction,
   * Postgres releases the advisory lock the instant the statement's
   * implicit autocommit transaction ends, making it a no-op safeguard.
   * The `(workflowRunId, sequence)` unique constraint is the actual
   * correctness backstop in both cases: on a conflict we recompute the
   * max sequence and retry, bounded to avoid unbounded recursion under
   * pathological contention.
   */
  private async appendOutboxEventsForRun(
    workflowRunId: string,
    runEvents: CreateOutboxEventInput[],
    attempt = 0,
  ): Promise<void> {
    if (
      this.databaseType === "postgresql" &&
      typeof this.prisma.$executeRaw === "function"
    ) {
      // Best-effort serialization; only effective inside a transaction.
      await this.prisma.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${workflowRunId}))
      `;
    }

    const maxResult = await this.prisma.outboxEvent.aggregate({
      where: { workflowRunId },
      _max: { sequence: true },
    });
    let seq = maxResult._max.sequence ?? 0;

    const rows = runEvents.map((event) => ({
      workflowRunId: event.workflowRunId,
      sequence: ++seq,
      eventType: event.eventType,
      payload: event.payload as any,
      causationId: event.causationId,
      occurredAt: event.occurredAt,
    }));

    try {
      await this.prisma.outboxEvent.createMany({ data: rows });
    } catch (error: any) {
      if (error?.code === "P2002" && attempt < MAX_CLAIM_ATTEMPTS) {
        // Another writer assigned overlapping sequences between our read
        // and write (only reachable outside a transaction, or on DBs
        // without the advisory lock). Recompute and retry.
        return this.appendOutboxEventsForRun(
          workflowRunId,
          runEvents,
          attempt + 1,
        );
      }
      throw error;
    }
  }

  async getUnpublishedOutboxEvents(limit?: number): Promise<OutboxRecord[]> {
    const effectiveLimit = limit ?? 100;
    const records = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null, dlqAt: null },
      orderBy: [{ workflowRunId: "asc" }, { sequence: "asc" }],
      take: effectiveLimit,
    });
    return records.map((r: any) => this.mapOutboxEvent(r));
  }

  async claimUnpublishedOutboxEvents(limit?: number): Promise<OutboxRecord[]> {
    const effectiveLimit = limit ?? 100;
    const now = this.now();
    if (this.databaseType === "postgresql" && this.prisma.$queryRawUnsafe) {
      // One statement: lock the candidate rows (skipping rows another
      // flush holds), stamp them, return them. A concurrent flush — even
      // one inside a still-open transaction — cannot receive the same
      // rows. `RETURNING` order is unspecified, so the rows are re-sorted.
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `WITH claimed AS (
          SELECT id
          FROM "outbox_events"
          WHERE "publishedAt" IS NULL AND "dlqAt" IS NULL
          ORDER BY "workflowRunId" ASC, sequence ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "outbox_events"
        SET "publishedAt" = ${utcTimestampParam(2)}
        FROM claimed
        WHERE "outbox_events".id = claimed.id
        RETURNING "outbox_events".*`,
        effectiveLimit,
        now,
      );
      return rows
        .map((r: any) => this.mapOutboxEvent(r))
        .sort(
          (a, b) =>
            a.workflowRunId.localeCompare(b.workflowRunId) ||
            a.sequence - b.sequence,
        );
    }

    // SQLite (or a client without raw queries): compare-and-set per row on
    // `publishedAt IS NULL`; a row another flush claimed first is skipped.
    const candidates = await this.getUnpublishedOutboxEvents(effectiveLimit);
    const claimed: OutboxRecord[] = [];
    for (const candidate of candidates) {
      const result = await this.prisma.outboxEvent.updateMany({
        where: { id: candidate.id, publishedAt: null, dlqAt: null },
        data: { publishedAt: now },
      });
      if (result.count > 0) claimed.push({ ...candidate, publishedAt: now });
    }
    return claimed;
  }

  async releaseOutboxEvents(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt: null },
    });
  }

  async markOutboxEventsPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt: new Date() },
    });
  }

  // ============================================================================
  // Outbox DLQ Operations
  // ============================================================================

  async incrementOutboxRetryCount(id: string): Promise<number> {
    const record = await this.prisma.outboxEvent.update({
      where: { id },
      data: { retryCount: { increment: 1 } },
      select: { retryCount: true },
    });
    return record.retryCount;
  }

  async moveOutboxEventToDLQ(id: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { dlqAt: new Date() },
    });
  }

  async replayDLQEvents(maxEvents: number): Promise<number> {
    const dlqEvents = await this.prisma.outboxEvent.findMany({
      where: { dlqAt: { not: null } },
      take: maxEvents,
      select: { id: true },
    });

    if (dlqEvents.length === 0) return 0;

    const result = await this.prisma.outboxEvent.updateMany({
      where: { id: { in: dlqEvents.map((e: any) => e.id) } },
      data: { dlqAt: null, retryCount: 0 },
    });
    return result.count;
  }

  // ============================================================================
  // Idempotency Operations
  // ============================================================================

  async acquireIdempotencyKey(
    key: string,
    commandType: string,
    options?: { now?: Date; staleInProgressAfterMs?: number },
  ): Promise<
    | { status: "acquired" }
    | { status: "replay"; result: unknown }
    | { status: "in_progress" }
  > {
    const row = {
      key,
      commandType,
      result: IDEMPOTENCY_IN_PROGRESS_MARKER as any,
      // Explicit rather than relying on the schema's `@default(now())`
      // so a caller-supplied `options.now` (e.g. a FakeClock in tests,
      // or a kernel using an injected Clock) is authoritative for the
      // staleness math below, not the DB's wall-clock time.
      createdAt: options?.now ?? new Date(),
    };
    if (this.databaseType === "postgresql") {
      // ON CONFLICT DO NOTHING: a caught unique violation would abort a
      // consumer's enclosing transaction (25P02) on every replayed dispatch.
      const { count } = await this.prisma.idempotencyKey.createMany({
        data: [row],
        skipDuplicates: true,
      });
      if (count > 0) return { status: "acquired" };
    } else {
      try {
        await this.prisma.idempotencyKey.create({ data: row });
        return { status: "acquired" };
      } catch (error: any) {
        if (error?.code !== "P2002") {
          throw error;
        }
      }
    }

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key_commandType: { key, commandType } },
      select: { id: true, result: true, createdAt: true },
    });

    if (!existing) {
      // Raced with a concurrent release between our failed create and
      // this read -- treat as still in progress; the caller can retry.
      return { status: "in_progress" };
    }

    if (!isInProgressResult(existing.result)) {
      return { status: "replay", result: existing.result };
    }

    // The key is stuck `in_progress` (e.g. a previous dispatcher crashed
    // between committing its transaction and calling
    // `completeIdempotencyKey`). Reclaim it if it's older than the
    // configured threshold. The update is gated on `id` + the exact
    // `createdAt` + `result` we just read, so if another dispatcher wins
    // the race (reclaims or completes it first) this update matches zero
    // rows and we fall back to re-reading the row.
    const staleAfterMs = options?.staleInProgressAfterMs;
    if (staleAfterMs !== undefined) {
      const now = options?.now ?? new Date();
      const ageMs = now.getTime() - existing.createdAt.getTime();
      if (ageMs >= staleAfterMs) {
        const reclaimed = await this.prisma.idempotencyKey.updateMany({
          where: {
            id: existing.id,
            createdAt: existing.createdAt,
            result: { equals: IDEMPOTENCY_IN_PROGRESS_MARKER as any },
          },
          data: {
            createdAt: now,
            result: IDEMPOTENCY_IN_PROGRESS_MARKER as any,
          },
        });

        if (reclaimed.count > 0) {
          return { status: "acquired" };
        }

        const after = await this.prisma.idempotencyKey.findUnique({
          where: { key_commandType: { key, commandType } },
          select: { result: true },
        });

        if (!after || isInProgressResult(after.result)) {
          return { status: "in_progress" };
        }

        return { status: "replay", result: after.result };
      }
    }

    return { status: "in_progress" };
  }

  async completeIdempotencyKey(
    key: string,
    commandType: string,
    result: unknown,
  ): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key_commandType: { key, commandType } },
      data: { result: result as any },
    });
  }

  async releaseIdempotencyKey(key: string, commandType: string): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({
      where: { key, commandType },
    });
  }

  // ============================================================================
  // Type Mappers
  // ============================================================================

  private mapWorkflowRun(run: any): WorkflowRunRecord {
    return {
      id: run.id,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      workflowType: run.workflowType,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      duration: run.duration,
      input: run.input,
      output: run.output,
      config: run.config,
      totalCost: run.totalCost,
      totalTokens: run.totalTokens,
      priority: run.priority,
      metadata: run.metadata ?? null,
      version: run.version ?? 0,
      definitionVersion: run.definitionVersion ?? null,
      redriveCount: run.redriveCount ?? 0,
    };
  }

  private mapWorkflowStage(stage: any): WorkflowStageRecord {
    return {
      id: stage.id,
      createdAt: stage.createdAt,
      updatedAt: stage.updatedAt,
      workflowRunId: stage.workflowRunId,
      stageId: stage.stageId,
      stageName: stage.stageName,
      stageNumber: stage.stageNumber,
      executionGroup: stage.executionGroup,
      attempt: stage.attempt ?? 0,
      status: stage.status,
      startedAt: stage.startedAt,
      completedAt: stage.completedAt,
      duration: stage.duration,
      inputData: stage.inputData,
      outputData: stage.outputData,
      config: stage.config,
      suspendedState: stage.suspendedState,
      resumeData: stage.resumeData,
      nextPollAt: stage.nextPollAt,
      pollInterval: stage.pollInterval,
      maxWaitUntil: stage.maxWaitUntil,
      metrics: stage.metrics,
      embeddingInfo: stage.embeddingInfo,
      errorMessage: stage.errorMessage,
      version: stage.version ?? 0,
    };
  }

  private mapOutboxEvent(record: any): OutboxRecord {
    return {
      id: record.id,
      workflowRunId: record.workflowRunId,
      sequence: record.sequence,
      eventType: record.eventType,
      payload: record.payload,
      causationId: record.causationId,
      occurredAt: record.occurredAt,
      publishedAt: record.publishedAt,
      retryCount: record.retryCount,
      dlqAt: record.dlqAt,
    };
  }

  private mapWorkflowArtifact(artifact: any): WorkflowArtifactRecord {
    return {
      id: artifact.id,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      workflowRunId: artifact.workflowRunId,
      workflowStageId: artifact.workflowStageId,
      key: artifact.key,
      type: artifact.type,
      data: artifact.data,
      size: artifact.size,
      metadata: artifact.metadata,
    };
  }
}

/**
 * Factory function to create PrismaWorkflowPersistence
 */
export function createPrismaWorkflowPersistence(
  prisma: PrismaClient,
  options?: PrismaWorkflowPersistenceOptions,
): PrismaWorkflowPersistence {
  return new PrismaWorkflowPersistence(prisma, options);
}
