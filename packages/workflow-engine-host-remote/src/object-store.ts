export interface Clockish {
  now(): Date;
}

export interface ObjectStorePresigner {
  presignPut(key: string, ttlMs: number): Promise<string>;
  presignGet(key: string, ttlMs: number): Promise<string>;
}

interface UrlGrant {
  key: string;
  op: "put" | "get";
  expiresAt: number;
}

/**
 * In-memory object store used in tests/examples. A single instance plays
 * three roles: the orchestrator's BlobStore (put/get/has/delete/list), the
 * broker's presigner, and the worker's upload/download target.
 */
export class InMemoryObjectStore implements ObjectStorePresigner {
  private readonly blobs = new Map<string, unknown>();
  private readonly urls = new Map<string, UrlGrant>();
  private seq = 0;
  private readonly clock: Clockish;

  constructor(clock: Clockish = { now: () => new Date() }) {
    this.clock = clock;
  }

  // --- ObjectStorePresigner ---
  async presignPut(key: string, ttlMs: number): Promise<string> {
    const url = `mem://put/${this.seq++}`;
    this.urls.set(url, {
      key,
      op: "put",
      expiresAt: this.clock.now().getTime() + ttlMs,
    });
    return url;
  }
  async presignGet(key: string, ttlMs: number): Promise<string> {
    const url = `mem://get/${this.seq++}`;
    this.urls.set(url, {
      key,
      op: "get",
      expiresAt: this.clock.now().getTime() + ttlMs,
    });
    return url;
  }

  // --- worker-side transfer via a presigned url ---
  async putViaUrl(url: string, data: unknown): Promise<void> {
    const g = this.requireUrl(url, "put");
    this.blobs.set(g.key, data);
  }
  async getViaUrl(url: string): Promise<unknown> {
    const g = this.requireUrl(url, "get");
    return this.blobs.get(g.key);
  }

  // --- engine BlobStore shape (orchestrator side) ---
  async put(key: string, data: unknown): Promise<void> {
    this.blobs.set(key, data);
  }
  async get(key: string): Promise<unknown> {
    return this.blobs.get(key);
  }
  async has(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }
  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.blobs.keys()].filter((k) => k.startsWith(prefix));
  }

  private requireUrl(url: string, op: "put" | "get"): UrlGrant {
    const g = this.urls.get(url);
    if (!g || g.op !== op) throw new Error(`invalid ${op} url`);
    if (this.clock.now().getTime() > g.expiresAt)
      throw new Error("url expired");
    return g;
  }
}
