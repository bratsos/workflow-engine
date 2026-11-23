import { literalPrefixQuery, prefixCandidates } from "./literal-prefix.js";
import { prefixRange, pruneRows, writeRetentionSql } from "./retention-sql.js";
import { withTransactionWriteGuard } from "./transaction-writes.js";
/**
 * PrismaAICallLogger - Prisma implementation of AICallLogger
 *
 * Handles AI call logging to the database. Uses fire-and-forget pattern
 * for non-blocking logging during AI operations.
 */

import { AICallWriteTracker } from "../../ai/write-tracker.js";
import type { Persistence } from "../../kernel/ports";
import { createLogger, isTraceTextEnabled } from "../../utils/logger";
import type {
  AICallFlushOptions,
  AICallLogger,
  AICallRecord,
  AIHelperStats,
  CreateAICallInput,
} from "../interface";
import type { DatabaseType } from "./persistence";
import {
  type EnginePrismaClient,
  validateDatabaseType,
} from "./prisma-client-type";
import { isUniqueViolation } from "./sql-errors";
import {
  armSqliteAdapter,
  guardSqliteAdapter,
  shareSqliteGuard,
  sqliteCheckFor,
} from "./sqlite-date-guard";
import { hasBaseReads, sqliteTransactionReads } from "./transaction-reads";

const logger = createLogger("AICallLogger");

// Structural client type -- see prisma-client-type.ts.
type PrismaClient = EnginePrismaClient;

type MetadataRecord = Record<string, unknown>;

function getMetadataRecord(metadata: unknown): MetadataRecord {
  if (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata)
  ) {
    return metadata as MetadataRecord;
  }
  return {};
}

function getMetadataString(metadata: unknown, key: string): string | undefined {
  const value = getMetadataRecord(metadata)[key];
  return typeof value === "string" ? value : undefined;
}

function getBatchMetadata(
  metadata: unknown,
  batchId: string,
  requestId: string | undefined,
): MetadataRecord {
  return {
    ...getMetadataRecord(metadata),
    batchId,
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

/**
 * The cost-accounting columns every write carries. All nullable in the
 * schema; an input that omits one writes NULL, never a guessed figure.
 */
function costColumns(call: CreateAICallInput): {
  estimatedCost: number | null;
  reportedCost: number | null;
  costSource: string | null;
  servedBy: string | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
} {
  return {
    estimatedCost: call.estimatedCost ?? null,
    reportedCost: call.reportedCost ?? null,
    costSource: call.costSource ?? null,
    servedBy: call.servedBy ?? null,
    cachedInputTokens: call.cachedInputTokens ?? null,
    reasoningTokens: call.reasoningTokens ?? null,
  };
}

function attributionColumns(call: CreateAICallInput) {
  return {
    ...(call.workflowRunId !== undefined
      ? { workflowRunId: call.workflowRunId }
      : {}),
    ...(call.tenantId !== undefined ? { tenantId: call.tenantId } : {}),
    ...(call.labels !== undefined ? { labels: call.labels } : {}),
    ...(call.textExpiresAt !== undefined
      ? { textExpiresAt: call.textExpiresAt }
      : {}),
  };
}

interface AICallRow {
  id: string;
  createdAt: Date;
  topic: string;
  callType: string;
  modelKey: string;
  modelId: string;
  prompt: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  estimatedCost: number | null;
  reportedCost: number | null;
  costSource: string | null;
  servedBy: string | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  batchId: string | null;
  requestId: string | null;
  metadata: unknown;
}

function toRecord(row: AICallRow): AICallRecord {
  return {
    id: row.id,
    createdAt: row.createdAt,
    topic: row.topic,
    callType: row.callType,
    modelKey: row.modelKey,
    modelId: row.modelId,
    prompt: row.prompt,
    response: row.response,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cost: row.cost,
    ...(row.batchId !== null ? { batchId: row.batchId } : {}),
    ...(row.requestId !== null ? { requestId: row.requestId } : {}),
    ...(row.estimatedCost !== null ? { estimatedCost: row.estimatedCost } : {}),
    ...(row.reportedCost !== null ? { reportedCost: row.reportedCost } : {}),
    ...(row.costSource !== null ? { costSource: row.costSource } : {}),
    ...(row.servedBy !== null ? { servedBy: row.servedBy } : {}),
    ...(row.cachedInputTokens !== null
      ? { cachedInputTokens: row.cachedInputTokens }
      : {}),
    ...(row.reasoningTokens !== null
      ? { reasoningTokens: row.reasoningTokens }
      : {}),
    metadata: row.metadata ?? null,
  };
}

export interface PrismaAICallLoggerOptions {
  /** Database type. Defaults to "postgresql". */
  databaseType?: DatabaseType;
}

export class PrismaAICallLogger implements AICallLogger {
  private readonly databaseType: DatabaseType;
  private readonly writes = new AICallWriteTracker();

  constructor(
    private readonly prisma: PrismaClient,
    options: PrismaAICallLoggerOptions = {},
  ) {
    this.prisma = withTransactionWriteGuard(
      prisma,
      options.databaseType ?? "postgresql",
    );
    this.databaseType = options.databaseType ?? "postgresql";
    validateDatabaseType(prisma, this.databaseType);
    if (this.databaseType === "sqlite") armSqliteAdapter(this, prisma);
  }

  #trackWrite(
    write: () => Promise<void>,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const done = this.writes.begin();
    const result = Promise.resolve().then(write);
    void result.then(done, (error: unknown) => {
      this.writes.fail();
      done();
      const message = "Failed to persist AI call";
      const includeError = isTraceTextEnabled();
      logger.warn(
        message,
        includeError ? { ...fields, error } : fields,
        () => includeError ? [message, error] : [message],
      );
    });
    return result;
  }

  /**
   * Returns the insert promise, with a rejection handler for fire-and-forget
   * callers, so callers coordinating run erasure can wait for it.
   */
  logCall(call: CreateAICallInput): Promise<void> {
    return this.#trackWrite(async () => {
      await sqliteCheckFor(this);
      await this.prisma.aICall.create({
        data: {
          topic: call.topic,
          callType: call.callType,
          modelKey: call.modelKey,
          modelId: call.modelId,
          prompt: call.prompt,
          response: call.response,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          cost: call.cost,
          ...costColumns(call),
          ...attributionColumns(call),
          metadata: call.metadata,
          ...(call.batchId !== undefined ? { batchId: call.batchId } : {}),
          ...(call.requestId !== undefined
            ? { requestId: call.requestId }
            : {}),
        },
      });
    }, {
      workflowRunId: call.workflowRunId,
      topic: call.topic,
      batchId: call.batchId,
      requestId: call.requestId,
      model: call.modelKey,
    });
  }

  flush(options?: AICallFlushOptions) {
    return this.writes.flush(options);
  }

  /**
   * Log batch results (for recording batch API results)
   */
  logBatchResults(
    batchId: string,
    results: CreateAICallInput[],
  ): Promise<void> {
    return this.#trackWrite(async () => {
      await sqliteCheckFor(this);
      await this.#insertBatchResults(batchId, results);
    }, { batchId });
  }

  async #insertBatchResults(
    batchId: string,
    results: CreateAICallInput[],
  ): Promise<void> {
    const data = results.map((call) => {
      const requestId =
        call.requestId ?? getMetadataString(call.metadata, "requestId");

      if (requestId === undefined) {
        logger.warn(
          "Batch result has no requestId; duplicate protection cannot be enforced for this row.",
          { batchId, topic: call.topic, workflowRunId: call.workflowRunId },
          () => [
            "Batch result has no requestId; duplicate protection cannot be enforced for this row.",
            { batchId },
          ],
        );
      }

      return {
        topic: call.topic,
        callType: call.callType,
        modelKey: call.modelKey,
        modelId: call.modelId,
        prompt: call.prompt,
        response: call.response,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cost: call.cost,
        ...costColumns(call),
        ...attributionColumns(call),
        batchId,
        ...(requestId !== undefined ? { requestId } : {}),
        metadata: getBatchMetadata(call.metadata, batchId, requestId),
      };
    });

    if (this.databaseType === "postgresql") {
      await this.prisma.aICall.createMany({ data, skipDuplicates: true });
      return;
    }

    // SQLite does not support skipDuplicates, but a unique violation leaves
    // the transaction usable, as in the annotation and step adapters.
    for (const row of data) {
      try {
        await this.prisma.aICall.create({ data: row });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }

  /**
   * Get aggregated stats for a topic prefix
   */
  async getStats(topicPrefix: string): Promise<AIHelperStats> {
    const literal = literalPrefixQuery<{
      modelKey: string;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    }>(this.prisma, "ai_calls", "topic", topicPrefix, {
      databaseType: this.databaseType,
      columns: {
        modelKey: "text",
        inputTokens: "int",
        outputTokens: "int",
        cost: "float",
      },
      select: '"modelKey", "inputTokens", "outputTokens", "cost"',
    });
    const calls = literal
      ? await literal
      : (
          await this.prisma.aICall.findMany({
            where: {
              topic: { startsWith: prefixCandidates(topicPrefix) },
            },
            select: {
              modelKey: true,
              inputTokens: true,
              outputTokens: true,
              cost: true,
              topic: true,
            },
          })
        ).filter((call: { topic: string }) =>
          call.topic.startsWith(topicPrefix),
        );

    const perModel: AIHelperStats["perModel"] = {};

    for (const call of calls) {
      if (!perModel[call.modelKey]) {
        perModel[call.modelKey] = {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        };
      }
      perModel[call.modelKey].calls++;
      perModel[call.modelKey].inputTokens += call.inputTokens;
      perModel[call.modelKey].outputTokens += call.outputTokens;
      perModel[call.modelKey].cost += call.cost;
    }

    return {
      totalCalls: calls.length,
      totalInputTokens: calls.reduce(
        (sum: number, c: { inputTokens: number }) => sum + c.inputTokens,
        0,
      ),
      totalOutputTokens: calls.reduce(
        (sum: number, c: { outputTokens: number }) => sum + c.outputTokens,
        0,
      ),
      totalCost: calls.reduce(
        (sum: number, c: { cost: number }) => sum + c.cost,
        0,
      ),
      perModel,
    };
  }

  /**
   * Authoritative USD cost over [from, to). A null group collects rows
   * without the selected label.
   */
  async costByTenant({
    tenantId,
    from,
    to,
    groupBy,
  }: {
    tenantId: string;
    from: Date;
    to: Date;
    groupBy?: string;
  }): Promise<{
    totalCost: number;
    groups?: { label: string | null; cost: number }[];
  }> {
    const where = { tenantId, createdAt: { gte: from, lt: to } };
    const rows: { cost: number; labels?: unknown }[] =
      await this.prisma.aICall.findMany({
        where,
        select:
          groupBy === undefined ? { cost: true } : { cost: true, labels: true },
      });
    if (groupBy === undefined) {
      return { totalCost: rows.reduce((total, row) => total + row.cost, 0) };
    }

    const costs = new Map<string | null, number>();
    let totalCost = 0;
    for (const { cost, labels } of rows) {
      const label = getMetadataString(labels, groupBy) ?? null;
      totalCost += cost;
      costs.set(label, (costs.get(label) ?? 0) + cost);
    }
    return {
      totalCost,
      groups: Array.from(costs, ([label, cost]) => ({ label, cost })),
    };
  }

  transactionReads(
    persistence: Persistence,
  ): Partial<AICallLogger> | undefined {
    if (this.databaseType !== "sqlite") return undefined;
    return sqliteTransactionReads(persistence, this.prisma, (tx) => {
      if (!hasBaseReads(this, PrismaAICallLogger.prototype, ["getStats"]))
        return undefined;
      const reader = new PrismaAICallLogger(tx, {
        databaseType: this.databaseType,
      });
      shareSqliteGuard(reader, this);
      return { getStats: reader.getStats.bind(reader) };
    });
  }

  /**
   * Check if batch results are already recorded
   */
  async isRecorded(batchId: string): Promise<boolean> {
    const count = await this.prisma.aICall.count({
      where: {
        OR: [
          { batchId },
          {
            metadata: {
              path: this.databaseType === "sqlite" ? "$.batchId" : ["batchId"],
              equals: batchId,
            },
          },
        ],
      },
    });
    return count > 0;
  }

  /**
   * List the calls under a topic prefix, oldest first, with every cost
   * figure as recorded.
   */
  async listCalls(topicPrefix: string): Promise<AICallRecord[]> {
    const nativeSqlite =
      this.databaseType === "sqlite" && !this.prisma.$databaseType;
    const literal = literalPrefixQuery<AICallRow>(
      this.prisma,
      "ai_calls",
      "topic",
      topicPrefix,
      {
        databaseType: this.databaseType,
        suffix: ' ORDER BY "createdAt" ASC, "id" ASC',
        ...(nativeSqlite
          ? {
              select: [
                "id",
                "createdAt",
                "topic",
                "callType",
                "modelKey",
                "modelId",
                "prompt",
                "response",
                "inputTokens",
                "outputTokens",
                "cost",
                "estimatedCost",
                "reportedCost",
                "costSource",
                "servedBy",
                "cachedInputTokens",
                "reasoningTokens",
                "batchId",
                "requestId",
                "metadata",
              ]
                .map((column) =>
                  column === "metadata"
                    ? 'CAST("metadata" AS TEXT) AS "metadata"'
                    : `"${column}"`,
                )
                .join(", "),
              jsonColumns: ["metadata"],
            }
          : {}),
      },
    );
    const rows = literal
      ? await literal
      : (
          (await this.prisma.aICall.findMany({
            where: { topic: { startsWith: prefixCandidates(topicPrefix) } },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })) as AICallRow[]
        ).filter((row) => row.topic.startsWith(topicPrefix));
    return rows.map(toRecord);
  }

  async deleteForRuns(runIds: readonly string[]): Promise<number> {
    const pg = this.databaseType === "postgresql";
    const topic = pg ? '"topic" COLLATE "C"' : '"topic"';
    // Calls logged before run attribution, by their topic. SQLite is held to
    // the partial index: its statistics can prefer `workflowRunId`'s, which
    // reads every unattributed call.
    const legacy = pg
      ? `"ai_calls"`
      : `"ai_calls" INDEXED BY "ai_calls_legacy_topic_idx"`;
    let removed = 0;
    for (const id of new Set(runIds)) {
      const run = (sql: string, args: unknown[]) =>
        writeRetentionSql(this.prisma, this.databaseType, sql, args);
      removed += await run(
        `DELETE FROM "ai_calls" WHERE "workflowRunId" = $1`,
        [id],
      );
      removed += await run(
        `DELETE FROM ${legacy}
          WHERE "workflowRunId" IS NULL AND ${topic} >= $1 AND ${topic} < $2`,
        prefixRange(`workflow.${id}.`),
      );
    }
    return removed;
  }

  async pruneCalls(olderThan: Date, limit: number): Promise<number> {
    return pruneRows(
      this.prisma,
      this.databaseType,
      "aiCalls",
      olderThan,
      limit,
    );
  }

  async clearExpiredText(now: Date, limit: number): Promise<number> {
    return pruneRows(this.prisma, this.databaseType, "aiCallText", now, limit);
  }
}

// Writes run the SQLite date check inside the tracked promise.

guardSqliteAdapter(PrismaAICallLogger.prototype, [
  "logCall",
  "logBatchResults",
  "flush",
  "transactionReads",
]);

// Factory function to create PrismaAICallLogger with prisma client
export function createPrismaAICallLogger(
  prisma: PrismaClient,
  options: PrismaAICallLoggerOptions = {},
): PrismaAICallLogger {
  return new PrismaAICallLogger(prisma, options);
}
