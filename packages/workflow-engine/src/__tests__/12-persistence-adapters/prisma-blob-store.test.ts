import { describe, expect, it, vi } from "vitest";
import {
  type BlobPrismaClient,
  createPrismaBlobStore,
} from "../../persistence/prisma/blob-store.js";

function fakeClient() {
  const rows = new Map<string, unknown>();
  const workflowBlob = {
    upsert: vi.fn(async ({ where, create }: any) => {
      rows.set(where.key, create.data);
    }),
    findUnique: vi.fn(async ({ where }: any) =>
      rows.has(where.key)
        ? { key: where.key, data: rows.get(where.key) }
        : null,
    ),
    deleteMany: vi.fn(async ({ where }: any) => {
      rows.delete(where.key);
      return { count: 1 };
    }),
    findMany: vi.fn(async ({ where }: any) =>
      [...rows.keys()]
        .filter((k) => k.startsWith(where.key.startsWith))
        .sort()
        .map((key) => ({ key })),
    ),
  };
  return { workflowBlob, rows } as unknown as BlobPrismaClient & {
    rows: Map<string, unknown>;
  };
}

describe("PrismaBlobStore", () => {
  it("round-trips, lists by prefix, and throws on a missing key", async () => {
    const client = fakeClient();
    const store = createPrismaBlobStore(client);

    await store.put("wf/run-1/a/output.json", { a: 1 });
    await store.put("wf/run-1/b/output.json", { b: 2 });
    await store.put("wf/run-2/a/output.json", { a: 3 });

    expect(await store.get("wf/run-1/a/output.json")).toEqual({ a: 1 });
    expect(await store.has("wf/run-1/b/output.json")).toBe(true);
    expect(await store.list("wf/run-1/")).toEqual([
      "wf/run-1/a/output.json",
      "wf/run-1/b/output.json",
    ]);
    await store.delete("wf/run-1/a/output.json");
    expect(await store.has("wf/run-1/a/output.json")).toBe(false);
    await expect(store.get("wf/run-1/a/output.json")).rejects.toThrow(
      /Blob not found: wf\/run-1\/a\/output.json/,
    );
  });
});
