/**
 * @bratsos/workflow-engine-console
 *
 * An optional, embeddable operational console for the workflow engine: a
 * framework-agnostic `(Request) => Promise<Response>` handler plus a
 * prebuilt UI, mounted inside the consumer's own application.
 *
 * It opens no database connection. Reads go through a `ConsoleReadPort`
 * the consumer builds over the client — or the transaction — they already
 * have, so the console runs inside their session, under their row-level
 * security, with authentication already decided upstream. Writes go
 * through kernel commands, never SQL.
 *
 * Nothing in the engine depends on this package, and nothing here is
 * required to run a workflow.
 */
export {
  CONSOLE_ACTIONS,
  type ConsoleAction,
  type ConsoleActionEvent,
  type ConsoleAuthorizeContext,
  type ConsoleKernel,
  isWriteAction,
  WRITE_ACTIONS,
} from "./actions";
export {
  ConsoleBadRequestError,
  ConsoleQueryTimeoutError,
  isStatementTimeout,
} from "./errors";
export {
  createWorkflowConsole,
  type WorkflowConsoleHandler,
  type WorkflowConsoleOptions,
} from "./handler";
export {
  type ConsolePrismaClient,
  createPrismaConsoleReadPort,
  PrismaConsoleReadPort,
  type PrismaConsoleReadPortOptions,
} from "./prisma-read-port";
export {
  ALL_CAPABILITIES,
  type AnnotationSummary,
  CONSOLE_STATUSES,
  type ConsoleCapabilities,
  type ConsoleReadPort,
  type ConsoleStatus,
  type CostBucket,
  type CostQuery,
  clampLimit,
  DEFAULT_RUN_LIMIT,
  type DeadLetter,
  decodeCursor,
  encodeCursor,
  isConsoleStatus,
  type LogEntry,
  MAX_LIMIT,
  type QueueHealth,
  type RunCursor,
  type RunDetail,
  type RunDetailOptions,
  type RunEvent,
  type RunListFilters,
  type RunListPage,
  type RunListQuery,
  type RunSummary,
  type StageSummary,
  type StepSummary,
  type SuspendedStage,
  type WorkerInstance,
} from "./read-port";
