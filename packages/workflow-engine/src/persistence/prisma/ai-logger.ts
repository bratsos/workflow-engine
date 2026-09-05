/**
 * PrismaAICallLogger - Prisma implementation of AICallLogger
 *
 * Handles AI call logging to the database. Uses fire-and-forget pattern
 * for non-blocking logging during AI operations.
 */

import { createLogger } from "../../utils/logger";
import type {
  AICallLogger,
  AIHelperStats,
  CreateAICallInput,
} from "../interface";
import type { EnginePrismaClient } from "./prisma-client-type";

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

export class PrismaAICallLogger implements AICallLogger {
  constructor(private readonly prisma: PrismaClient) {}

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
    await this.prisma.aICall.createMany({
      data: results.map((call) => {
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
          batchId,
          ...(requestId !== undefined ? { requestId } : {}),
          metadata: getBatchMetadata(call.metadata, batchId, requestId),
        };
      }),
      skipDuplicates: true,
    });
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
              path: ["batchId"],
              equals: batchId,
            },
          },
        ],
      },
    });
    return count > 0;
  }
}

// Factory function to create PrismaAICallLogger with prisma client
export function createPrismaAICallLogger(prisma: PrismaClient): AICallLogger {
  return new PrismaAICallLogger(prisma);
}
