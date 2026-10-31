/**
 * PrismaAICallLogger - Prisma implementation of AICallLogger
 *
 * Handles AI call logging to the database. Uses fire-and-forget pattern
 * for non-blocking logging during AI operations.
 */

import type { Persistence } from "../../kernel/ports";
import { createLogger } from "../../utils/logger";
import type {
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

  constructor(
    private readonly prisma: PrismaClient,
    options: PrismaAICallLoggerOptions = {},
  ) {
    this.databaseType = options.databaseType ?? "postgresql";
    validateDatabaseType(prisma, this.databaseType);
  }

  /**
   * Log a single AI call (fire and forget)
   * Does not await - logs asynchronously to avoid blocking AI operations
   */
  logCall(call: CreateAICallInput): void {
    this.prisma.aICall
      .create({
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
          metadata: call.metadata as unknown,
          ...(call.batchId !== undefined ? { batchId: call.batchId } : {}),
          ...(call.requestId !== undefined
            ? { requestId: call.requestId }
            : {}),
        },
      })
      .catch((error: unknown) =>
        logger.error("Failed to persist AI call:", error),
      );
  }

  /**
   * Log batch results (for recording batch API results)
   */
  async logBatchResults(
    batchId: string,
    results: CreateAICallInput[],
  ): Promise<void> {
    const data = results.map((call) => {
      const requestId =
        call.requestId ?? getMetadataString(call.metadata, "requestId");

      if (requestId === undefined) {
        logger.warn(
          "Batch result has no requestId; duplicate protection cannot be enforced for this row.",
          { batchId },
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
    const calls = await this.prisma.aICall.findMany({
      where: {
        topic: { startsWith: topicPrefix },
      },
      select: {
        modelKey: true,
        inputTokens: true,
        outputTokens: true,
        cost: true,
      },
    });

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
    const rows = (await this.prisma.aICall.findMany({
      where: { topic: { startsWith: topicPrefix } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })) as AICallRow[];
    return rows.map(toRecord);
  }
}

// Factory function to create PrismaAICallLogger with prisma client
export function createPrismaAICallLogger(
  prisma: PrismaClient,
  options: PrismaAICallLoggerOptions = {},
): PrismaAICallLogger {
  return new PrismaAICallLogger(prisma, options);
}
