import type { Persistence } from "../../kernel/ports.js";
import type { EnginePrismaClient } from "./prisma-client-type.js";

interface Binding {
  root: object;
  client: EnginePrismaClient;
}

const bindings = new WeakMap<Persistence, Binding>();

/** Internal scope association; neither the persistence nor its read facades expose the client. */
export function registerSqliteTransaction(
  persistence: Persistence,
  parent: Persistence,
  root: object,
  client: EnginePrismaClient,
): () => void {
  const binding = { root: bindings.get(parent)?.root ?? root, client };
  bindings.set(persistence, binding);
  return () => {
    if (bindings.get(persistence) === binding) bindings.delete(persistence);
  };
}

type Reads = Record<string, (...args: any[]) => Promise<unknown>>;

/** Accessor overrides opt out without evaluating custom read providers. */
export function hasBaseReads(
  port: object,
  prototype: object,
  methods: readonly string[],
): boolean {
  return methods.every((method) => {
    const base = Object.getOwnPropertyDescriptor(prototype, method)?.value;
    if (typeof base !== "function") return false;
    let owner: object | null = port;
    while (owner) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, method);
      if (descriptor) {
        return (
          "value" in descriptor &&
          descriptor.value === base &&
          Reflect.get(port, method) === base
        );
      }
      owner = Object.getPrototypeOf(owner);
    }
    return false;
  });
}

export function sqliteTransactionReads<R extends Reads>(
  persistence: Persistence,
  client: object,
  read: (tx: EnginePrismaClient) => R | undefined,
): R | undefined {
  const binding = bindings.get(persistence);
  if (!binding || (binding.root !== client && binding.client !== client)) {
    return undefined;
  }
  const reads = read(binding.client);
  if (!reads) return undefined;
  return Object.fromEntries(
    Object.entries(reads).map(([name, fn]) => [
      name,
      async (...args: any[]) => {
        if (bindings.get(persistence) !== binding) {
          throw Object.assign(
            new Error("SQLite transaction reads are no longer active"),
            {
              code: "P2028",
            },
          );
        }
        return fn(...args);
      },
    ]),
  ) as R;
}
