/**
 * Structural Prisma Client Type
 *
 * A minimal, Prisma-version-agnostic structural (duck-typed) shape for the
 * client the engine's Prisma adapters depend on: `PrismaWorkflowPersistence`,
 * `PrismaJobQueue`, `PrismaAICallLogger`, and `createEnumHelper`.
 *
 * This is deliberately NOT `import type { PrismaClient } from "@prisma/client"`:
 * consumers generate their own client (their own output path, possibly a
 * different Prisma major version), and this package must not force a
 * dependency on a specific generated client. Instead, this structural type captures only the delegates and
 * methods the adapters actually call, so that:
 *
 *   - any Prisma 6 or 7 client generated from a schema with the required
 *     models (see `prisma/schema.prisma`) structurally satisfies it, and a
 *     Prisma 8 client does once wrapped by `fromPrisma8` (it has no model
 *     delegates of its own), regardless of Prisma version, and
 *   - passing something that ISN'T a Prisma client at all (a typo'd mock,
 *     `{}`, an unrelated object) is rejected at the constructor call site
 *     by the type checker, instead of silently compiling under `any`.
 *
 * `args`/return values on `PrismaDelegate` are intentionally `any` -- this
 * type exists to catch "wrong object entirely", not to reproduce Prisma's
 * generated per-model arg/result types (which vary by schema and version).
 */

/**
 * Generic per-model delegate shape. Every Prisma model delegate exposes
 * this surface; the engine's adapters only call a subset per model (see
 * the per-field comments on `EnginePrismaClient`), but one shared shape
 * for all of them is simpler than -- and just as accurate as -- bespoke
 * per-model shapes, since a real Prisma delegate always has all of these.
 */
export interface PrismaDelegate {
  create(args: any): Promise<any>;
  createMany(args: any): Promise<any>;
  findUnique(args: any): Promise<any>;
  findFirst(args: any): Promise<any>;
  findMany(args: any): Promise<any>;
  update(args: any): Promise<any>;
  updateMany(args: any): Promise<any>;
  upsert(args: any): Promise<any>;
  delete(args: any): Promise<any>;
  deleteMany(args: any): Promise<any>;
  count(args?: any): Promise<any>;
  aggregate(args: any): Promise<any>;
  /**
   * Optional: only `countRunsByDefinitionVersion` uses it, and it guards
   * with a `typeof` check so a hand-rolled test double without `groupBy`
   * still satisfies this type.
   */
  groupBy?(args: any): Promise<any>;
}

/**
 * Structural shape of the Prisma client the engine's adapters accept.
 * Named delegates match the models in `prisma/schema.prisma`
 * (`WorkflowRun` -> `workflowRun`, etc. -- Prisma lowercases the first
 * letter of the model name for the client property).
 */
export interface EnginePrismaClient {
  /** WorkflowRun delegate (persistence.ts: run CRUD + claim). */
  workflowRun: PrismaDelegate;
  /** WorkflowStage delegate (persistence.ts: stage CRUD + queries). */
  workflowStage: PrismaDelegate;
  /** WorkflowLog delegate (persistence.ts: createLog). */
  workflowLog: PrismaDelegate;
  /** WorkflowArtifact delegate (persistence.ts: artifact family, deprecated). */
  workflowArtifact: PrismaDelegate;
  /** WorkflowAnnotation delegate (persistence.ts: appendAnnotations/listAnnotations). */
  workflowAnnotation: PrismaDelegate;
  /** OutboxEvent delegate (persistence.ts: outbox + DLQ operations). */
  outboxEvent: PrismaDelegate;
  /** IdempotencyKey delegate (persistence.ts: idempotency operations). */
  idempotencyKey: PrismaDelegate;
  /** JobQueue delegate (job-queue.ts). */
  jobQueue: PrismaDelegate;
  /** AICall delegate (ai-logger.ts). */
  aICall: PrismaDelegate;
  /** WorkflowStep delegate (step-ledger.ts). */
  workflowStep: PrismaDelegate;
  /**
   * WorkflowDefinition delegate (persistence.ts: definition snapshots).
   * Optional on purpose: a consumer who has not yet added the
   * `workflow_definitions` model still satisfies this type, and the
   * adapter detects its absence and runs without definition versioning
   * rather than failing to start.
   */
  workflowDefinition?: PrismaDelegate;

  /**
   * Interactive ($transaction(fn)) and batch ($transaction([...])) forms.
   * Optional: `PrismaWorkflowPersistence.withTransaction` already falls
   * back to running the callback un-transacted when this isn't a function
   * (see `skipInteractiveTransactions` and the `skip-transactions.test.ts`
   * fixture, which passes a minimal client that only implements this one
   * member).
   */
  $transaction?(arg: any, options?: any): Promise<any>;
  /**
   * Raw parameterized SELECT (tagged template). Optional -- the two
   * Postgres-only call sites that need it (`claimNextPendingRunPostgres`,
   * `dequeuePostgres`) fail fast with a clear error if it's missing rather
   * than throwing a raw `TypeError` from an unconditional call.
   */
  $queryRaw?<T = unknown>(
    strings: TemplateStringsArray,
    ...values: any[]
  ): Promise<T>;
  /**
   * Raw SQL with positional parameters. Optional; preferred by
   * `claimNextPendingRunPostgres` because the status enum's type name is an
   * identifier a tagged template cannot bind (`statusEnumName`).
   */
  $queryRawUnsafe?<T = unknown>(query: string, ...values: any[]): Promise<T>;
  /**
   * Raw parameterized statement (tagged template). Optional -- already
   * guarded with a `typeof ... === "function"` check at its one call site
   * (the advisory-lock statement in `appendOutboxEventsForRun`).
   */
  $executeRaw?(strings: TemplateStringsArray, ...values: any[]): Promise<any>;
  /**
   * An enum namespace, if the client has one. Prisma 6 and 7 client
   * instances do not (their enums are module-level exports), nor does a
   * `fromPrisma8` client, so enum values are plain strings. See
   * `enum-compat.ts`.
   */
  $Enums?: Record<string, Record<string, unknown>>;
  /**
   * Prisma 8 only (`fromPrisma8` provides it): a client whose raw reads
   * return these columns. Prisma 8 silently drops result columns a raw read
   * does not declare, so every raw read goes through {@link rawFor}.
   */
  $withColumns?(columns: RawColumns): EnginePrismaClient;
}

/** A raw read's column type: `bigint` is what `count(*)` returns. */
export type RawColumnType =
  | "text"
  | "int"
  | "bigint"
  | "float"
  | "bool"
  | "json"
  | "timestamp";

/**
 * The columns a raw read returns: a table name for `RETURNING "t".*`, else a
 * column name -> type map (`{}` for a statement that returns no rows).
 */
export type RawColumns = string | Record<string, RawColumnType>;

/**
 * The client to run a raw read on. Prisma 6 and 7 return rows as they are, so
 * this is the client itself there; a `fromPrisma8` client returns a view whose
 * raw reads decode `columns`.
 */
export function rawFor<C extends EnginePrismaClient>(
  prisma: C,
  columns: RawColumns,
): C {
  return (prisma.$withColumns?.(columns) as C | undefined) ?? prisma;
}

/** Fails early on `databaseType: "sqlite"` over a `fromPrisma8` client: Prisma 8 is Postgres-only here. */
export function rejectSqliteOn8(
  prisma: EnginePrismaClient,
  databaseType: string,
): void {
  if (databaseType === "sqlite" && prisma.$withColumns) {
    throw new Error(
      'databaseType "sqlite" is not supported on Prisma 8: use Prisma 6 or 7 for SQLite, or a Postgres database.',
    );
  }
}
