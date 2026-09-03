/**
 * Prisma-backed `BlobStore`.
 *
 * Stage outputs (and every `ctx.step` replay's `ctx.input`) are resolved
 * from the blob store, so every process that executes or polls a run must
 * read the same store. This adapter keeps blobs in a `WorkflowBlob` table
 * (`workflow_blobs`), keyed by the artifact key, so a Prisma-backed
 * deployment needs no object storage to be replay-safe across processes.
 *
 * The table is optional: the client type here requires only the
 * `workflowBlob` delegate, so consumers who bring their own `BlobStore`
 * (S3, R2, ...) do not have to add the model.
 */

import type { BlobStore } from "../../kernel/ports.js";
import type { PrismaDelegate } from "./prisma-client-type.js";

/** The one delegate the Prisma blob store needs. */
export interface BlobPrismaClient {
  workflowBlob: PrismaDelegate;
}

export class PrismaBlobStore implements BlobStore {
  constructor(private readonly prisma: BlobPrismaClient) {}

  async put(key: string, data: unknown): Promise<void> {
    await this.prisma.workflowBlob.upsert({
      where: { key },
      create: { key, data: data as unknown },
      update: { data: data as unknown },
    });
  }

  async get(key: string): Promise<unknown> {
    const row = await this.prisma.workflowBlob.findUnique({
      where: { key },
      select: { data: true },
    });
    if (!row) {
      throw new Error(`Blob not found: ${key}`);
    }
    return row.data;
  }

  async has(key: string): Promise<boolean> {
    const row = await this.prisma.workflowBlob.findUnique({
      where: { key },
      select: { key: true },
    });
    return row !== null;
  }

  async delete(key: string): Promise<void> {
    await this.prisma.workflowBlob.deleteMany({ where: { key } });
  }

  async list(prefix: string): Promise<string[]> {
    const rows = (await this.prisma.workflowBlob.findMany({
      where: { key: { startsWith: prefix } },
      select: { key: true },
      orderBy: { key: "asc" },
    })) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }
}

export function createPrismaBlobStore(prisma: BlobPrismaClient): BlobStore {
  return new PrismaBlobStore(prisma);
}
