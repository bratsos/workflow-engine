import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type KernelDatabase,
  kernelDatabase,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";

const prefixCases = [
  {
    prefix: "scope/%_\\'quote/λ雪/",
    match: "scope/%_\\'quote/λ雪/hit",
    confusable: "scope/otherZ\\'quote/λ雪/miss",
  },
  {
    prefix: "scope/literal\\",
    match: "scope/literal\\hit",
    confusable: "scope/literalXhit",
  },
];

describe.skipIf(!realDatabase)(
  `literal prefix matching on real ${sqlite ? "SQLite" : "Postgres"}`,
  () => {
    let db: KernelDatabase;

    beforeAll(async () => {
      db = await kernelDatabase();
    }, 120_000);

    beforeEach(async () => {
      await db.reset();
    });

    afterAll(async () => {
      await db?.close();
    });

    it("treats LIKE metacharacters as literal data across public prefix readers", async () => {
      const { id: workflowRunId } = await db.seed();
      const entries = prefixCases.flatMap(({ match, confusable }) => [
        { key: match, matches: true },
        { key: confusable, matches: false },
      ]);

      for (const { key } of entries) {
        await db.blobStore.put(key, { key });
      }
      await db.persistence.appendAnnotations(
        entries.map(({ key }) => ({
          workflowRunId,
          scope: "run" as const,
          key,
          value: { key },
        })),
      );

      const requestIds = entries.map((_entry, index) =>
        `fix2-prefix-${index}-${crypto.randomUUID()}`,
      );
      entries.forEach(({ key, matches }, index) => {
        db.aiLogger.logCall({
          topic: key,
          callType: "text",
          modelKey: "prefix-regression",
          modelId: "prefix-regression",
          prompt: "",
          response: "",
          inputTokens: matches ? 2 : 7,
          outputTokens: matches ? 3 : 11,
          cost: matches ? 0.25 : 0.75,
          requestId: requestIds[index],
        });
      });

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const count = await db.client.aICall.count({
          where: { requestId: { in: requestIds } },
        });
        if (count === entries.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        await db.client.aICall.count({
          where: { requestId: { in: requestIds } },
        }),
      ).toBe(entries.length);

      const actual = [];
      for (const { prefix } of prefixCases) {
        actual.push({
          blobs: await db.blobStore.list(prefix),
          annotations: (
            await db.persistence.listAnnotations(workflowRunId, {
              keyPrefix: prefix,
            })
          ).map(({ key }) => key),
          calls: (await db.aiLogger.listCalls!(prefix)).map(
            ({ topic }) => topic,
          ),
          stats: await db.aiLogger.getStats(prefix),
        });
      }

      expect(actual).toEqual(
        prefixCases.map(({ match }) => ({
          blobs: [match],
          annotations: [match],
          calls: [match],
          stats: {
            totalCalls: 1,
            totalInputTokens: 2,
            totalOutputTokens: 3,
            totalCost: 0.25,
            perModel: {
              "prefix-regression": {
                calls: 1,
                inputTokens: 2,
                outputTokens: 3,
                cost: 0.25,
              },
            },
          },
        })),
      );
    });
  },
);
