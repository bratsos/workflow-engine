import { literalPrefixQuery, prefixCandidates } from "./literal-prefix.js";
import { withTransactionWriteGuard } from "./transaction-writes.js";
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

import type { BlobStore, Persistence } from "../../kernel/ports.js";
import type {
  EnginePrismaClient,
  PrismaDelegate,
} from "./prisma-client-type.js";
import { hasBaseReads, sqliteTransactionReads } from "./transaction-reads.js";

/** The one delegate the Prisma blob store needs. */
export interface BlobPrismaClient
  extends Pick<
    EnginePrismaClient,
    "$queryRaw" | "$queryRawUnsafe" | "$withColumns"
  > {
  workflowBlob: PrismaDelegate;
}

export class PrismaBlobStore implements BlobStore {
  constructor(private readonly prisma: BlobPrismaClient) {
    this.prisma = withTransactionWriteGuard(prisma);
  }

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
    const literal = literalPrefixQuery<{ key: string }>(
      this.prisma,
      "workflow_blobs",
      "key",
      prefix,
      {
        columns: { key: "text" },
        select: '"key"',
        suffix: ' ORDER BY "key" ASC',
      },
    );
    if (literal) return (await literal).map((row) => row.key);
    const rows = (await this.prisma.workflowBlob.findMany({
      where: { key: { startsWith: prefixCandidates(prefix) } },
      select: { key: true },
      orderBy: { key: "asc" },
    })) as Array<{ key: string }>;
    return rows.map((r) => r.key).filter((key) => key.startsWith(prefix));
  }

  transactionReads(persistence: Persistence): Partial<BlobStore> | undefined {
    return sqliteTransactionReads(persistence, this.prisma, (tx) => {
      // Keep custom reader policy and decoding on the configured port.
      if (
        !hasBaseReads(this, PrismaBlobStore.prototype, ["get", "has", "list"])
      )
        return undefined;
      const reader = new PrismaBlobStore(
        tx as EnginePrismaClient & BlobPrismaClient,
      );
      return {
        get: reader.get.bind(reader),
        has: reader.has.bind(reader),
        list: reader.list.bind(reader),
      };
    });
  }
}

export function createPrismaBlobStore(prisma: BlobPrismaClient): BlobStore {
  return new PrismaBlobStore(prisma);
}
