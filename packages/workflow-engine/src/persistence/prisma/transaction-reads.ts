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

export function sqliteTransactionReads<R extends Reads>(
  persistence: Persistence,
  client: object,
  read: (tx: EnginePrismaClient) => R,
): R | undefined {
  const binding = bindings.get(persistence);
  if (!binding || (binding.root !== client && binding.client !== client)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(read(binding.client)).map(([name, fn]) => [
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
