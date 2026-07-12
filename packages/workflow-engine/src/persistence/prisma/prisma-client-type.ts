/**
 * Structural Prisma Client Type
 *
 * A minimal, Prisma-version-agnostic structural (duck-typed) shape for the
 * client the engine's Prisma adapters depend on: `PrismaWorkflowPersistence`,
 * `PrismaJobQueue`, `PrismaAICallLogger`, and `createEnumHelper`.
 *
 * This is deliberately NOT `import type { PrismaClient } from "@prisma/client"`:
 * consumers generate their own client (their own output path, possibly a
 * different Prisma major version -- see `enum-compat.ts`'s 6.x/7.x note),
 * and this package must not force a dependency on a specific generated
 * client. Instead, this structural type captures only the delegates and
 * methods the adapters actually call, so that:
 *
 *   - any Prisma client generated from a schema with the required models
 *     (see `prisma/schema.prisma`) structurally satisfies it, regardless
 *     of Prisma version, and
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
   * Raw parameterized statement (tagged template). Optional -- already
   * guarded with a `typeof ... === "function"` check at its one call site
   * (the advisory-lock statement in `appendOutboxEventsForRun`).
   */
  $executeRaw?(strings: TemplateStringsArray, ...values: any[]): Promise<any>;
  /**
   * Prisma 7.x's typed-enum namespace (absent on 6.x clients, which use
   * plain strings). See `enum-compat.ts`.
   */
  $Enums?: Record<string, Record<string, unknown>>;
}
