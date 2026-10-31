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
interface NativeWriteQueue {
  active: Set<Promise<boolean>>;
  tail: Promise<void>;
}
const engines = new WeakMap<object, NativeWriteQueue>();

function nativeTransactions(
  prisma: EnginePrismaClient,
): NativeWriteQueue | undefined {
  // Prisma 6/7 expose no public transaction observer. Observe their shared
  // engine boundary so a caller's own $transaction is fenced too, including
  // when its callback enters an external AsyncResource.
  const engine = (prisma as any)._engine;
  if (!engine || typeof engine.transaction !== "function") return undefined;
  const known = engines.get(engine);
  if (known) return known;
  const active = new Set<Promise<boolean>>();
  const transactions = new Map<string, NativeTransaction[]>();
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
      // Prisma 7 reuses a transaction ID for nested savepoint scopes.
      const stack = transactions.get(started.id) ?? [];
      stack.push(entry);
      transactions.set(started.id, stack);
      active.add(result);
      return started;
    }
    const stack = transactions.get(options?.id);
    const entry = stack?.at(-1);
    try {
      const result = await transaction(action, headers, options);
      entry?.finish(action === "commit");
      return result;
    } catch (error) {
      entry?.finish(false);
      throw error;
    } finally {
      if (entry) active.delete(entry.result);
      stack?.pop();
      if (stack?.length === 0) transactions.delete(options?.id);
    }
  };
  const queue = { active, tail: Promise.resolve() };
  engines.set(engine, queue);
  return queue;
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
  const queue = nativeTransactions(prisma);
  if (!queue) return client;
  const afterTransactions = <R>(work: () => Promise<R>): Promise<R> => {
    const owners = [...queue.active];
    const independent = isIndependentWrite();
    const closed = () =>
      Object.assign(
        new Error(
          "Transaction rolled back before an outer adapter write could run. Use the transaction client for transactional writes.",
        ),
        { code: "P2028" },
      );
    const permit = Promise.all(owners).then(async (results) => {
      if (results.some((committed) => !committed) && !(await independent))
        throw closed();
    });
    const pending = queue.tail.then(async () => {
      await permit;
      return work();
    });
    queue.tail = pending.then(
      () => {},
      () => {},
    );
    // Native Prisma waits for its callback even after rolling the driver back.
    // Reject a self-dependent queued write at that deadline so its callback
    // can unwind, release the queue, and leave the queued SQL unexecuted.
    const rollback = new Promise<never>((_, reject) => {
      for (const owner of owners)
        owner.then(async (committed) => {
          if (!committed && !(await independent)) reject(closed());
        });
    });
    return Promise.race([
      pending,
      rollback,
      permit.then(() => new Promise<never>(() => {})),
    ]);
  };
  const guard = (operation: any) => {
    let pending: Promise<unknown> | undefined;
    const run = () => (pending ??= afterTransactions(() => operation));
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
        if (key === "$transaction")
          return (arg: any, options?: any) =>
            // Gate both transaction forms before Prisma starts them. Retain the
            // array form so a batch does not gain an interactive deadline.
            afterTransactions(() => value.call(target, arg, options));
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
