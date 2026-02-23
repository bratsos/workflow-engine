import type { BlobStore } from "../ports";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryBlobStore implements BlobStore {
  private store = new Map<string, unknown>();

  async put(key: string, data: unknown): Promise<void> {
    this.store.set(key, deepClone(data));
  }

  async get(key: string): Promise<unknown> {
    if (!this.store.has(key)) {
      throw new Error(`Blob not found: ${key}`);
    }
    return deepClone(this.store.get(key));
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }

  // Test helpers
  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
