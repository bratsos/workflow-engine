import type { AsyncLocalStorage } from "node:async_hooks";
import type { EnginePrismaClient } from "./prisma-client-type.js";
import { isReadOnlySql } from "./read-only-sql.js";

let independentScope: Promise<AsyncLocalStorage<boolean>> | undefined;
const scopes = () =>
  (independentScope ??= import("node:async_hooks").then(
    ({ AsyncLocalStorage }) => new AsyncLocalStorage<boolean>(),
  ));

export async function independentWrites<T>(work: () => Promise<T>): Promise<T> {
  return (await scopes()).run(true, work);
}

export async function isIndependentWrite(): Promise<boolean> {
  return independentScope
    ? (await independentScope).getStore() === true
    : false;
}

const clients = new WeakMap<object, EnginePrismaClient>();
const mutations = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

interface NativeTransaction {
  result: Promise<boolean>;
  finish(committed: boolean): void;
}
const engines = new WeakMap<object, Set<Promise<boolean>>>();

function nativeTransactions(
  prisma: EnginePrismaClient,
): Set<Promise<boolean>> | undefined {
  // Prisma 6/7 expose no public transaction observer. Observe their shared
  // engine boundary so a caller's own $transaction is fenced too, including
  // when its callback enters an external AsyncResource.
  const engine = (prisma as any)._engine;
  if (!engine || typeof engine.transaction !== "function") return undefined;
  const known = engines.get(engine);
  if (known) return known;
  const active = new Set<Promise<boolean>>();
  const transactions = new Map<string, NativeTransaction>();
  const transaction = engine.transaction.bind(engine);
  engine.transaction = async (
    action: string,
    headers: unknown,
    options: any,
  ) => {
    if (action === "start") {
      const started = await transaction(action, headers, options);
      let resolve!: (committed: boolean) => void;
      const result = new Promise<boolean>((finish) => {
        resolve = finish;
      });
      const timer =
        options.timeout === undefined
          ? undefined
          : setTimeout(() => resolve(false), options.timeout);
      const entry = {
        result,
        finish(committed: boolean) {
          clearTimeout(timer);
          resolve(committed);
        },
      };
      transactions.set(started.id, entry);
      active.add(result);
      return started;
    }
    const entry = transactions.get(options?.id);
    try {
      const result = await transaction(action, headers, options);
      entry?.finish(action === "commit");
      return result;
    } catch (error) {
      entry?.finish(false);
      throw error;
    } finally {
      if (entry) active.delete(entry.result);
      transactions.delete(options?.id);
    }
  };
  engines.set(engine, active);
  return active;
}

/** Keep outer adapter writes from escaping an enclosing transaction's rollback. */
export function withTransactionWriteGuard<T extends object>(
  client: T,
  databaseType?: string,
): T {
  const prisma = client as T & EnginePrismaClient;
  const cached = clients.get(client);
  if (cached) return cached as T;
  // SQLite on Prisma 8 owns this guard in its write queue. Native SQLite
  // adapters share a gate because only one connection can hold the writer.
  // Transaction clients already write on the transaction's connection.
  if (
    prisma.$databaseType ||
    Object.getOwnPropertySymbols(prisma).some((key) => {
      if (key.description === "prisma.client.transaction.id")
        return typeof Reflect.get(prisma, key) === "string";
      if (key.description === "prisma.client.transaction.scope_context")
        return typeof Reflect.get(prisma as object, key)?.txId === "string";
      return false;
    }) ||
    typeof prisma.$transaction !== "function" ||
    (databaseType ?? (prisma as any)._activeProvider) !== "sqlite"
  )
    return client;
  const active = nativeTransactions(prisma);
  if (!active) return client;
  const guard = (operation: any) => {
    let pending: Promise<unknown> | undefined;
    const run = () =>
      (pending ??= (async () => {
        // Capture by connection ownership, independent of async context. A root
        // write awaited by its transaction waits until the driver rolls it back.
        const owners = [...active];
        const independent = await isIndependentWrite();
        if (
          (await Promise.all(owners)).some((committed) => !committed) &&
          !independent
        ) {
          throw Object.assign(
            new Error(
              "Transaction rolled back before an outer adapter write could run. Use the transaction client for transactional writes.",
            ),
            { code: "P2028" },
          );
        }
        return await operation;
      })());
    return new Proxy(operation, {
      get(target, key) {
        if (key === "then") return (...args: any[]) => run().then(...args);
        if (key === "catch") return (...args: any[]) => run().catch(...args);
        if (key === "finally")
          return (...args: any[]) => run().finally(...args);
        const value: any = Reflect.get(target, key);
        // Preserve PrismaPromise's requestTransaction for batch transactions.
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const wrap = (target: EnginePrismaClient): EnginePrismaClient => {
    const delegates = new Map<PropertyKey, unknown>();
    return new Proxy(target, {
      get(target, key) {
        const value: any = Reflect.get(target, key);
        if (key === "$withColumns" && typeof value === "function")
          return (...args: any[]) => wrap(value.apply(target, args));
        if (
          key === "$executeRaw" ||
          key === "$executeRawUnsafe" ||
          key === "$queryRaw" ||
          key === "$queryRawUnsafe"
        )
          return (...args: any[]) => {
            const sql =
              typeof args[0] === "string"
                ? args[0]
                : Array.from(args[0]).join("?");
            if (
              (key === "$queryRaw" || key === "$queryRawUnsafe") &&
              isReadOnlySql(sql)
            )
              return value.apply(target, args);
            return guard(value.apply(target, args));
          };
        if (
          typeof key === "string" &&
          !key.startsWith("$") &&
          value &&
          typeof value === "object" &&
          typeof value.create === "function"
        ) {
          if (!delegates.has(key))
            delegates.set(
              key,
              new Proxy(value, {
                get(delegate, method) {
                  const fn = Reflect.get(delegate, method);
                  if (typeof fn !== "function") return fn;
                  return (...args: any[]) =>
                    mutations.has(String(method))
                      ? guard(fn.apply(delegate, args))
                      : fn.apply(delegate, args);
                },
              }),
            );
          return delegates.get(key);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const view = wrap(prisma);
  clients.set(client, view);
  clients.set(view, view);
  return view as T;
}
