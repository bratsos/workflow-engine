import type { AsyncLocalStorage } from "node:async_hooks";
import type { EnginePrismaClient } from "./prisma-client-type.js";
import { isReadOnlySql } from "./read-only-sql.js";

/** A root write proven by async context to belong to a rolled-back transaction. */
export const rolledBackWrite = () =>
  Object.assign(
    new Error(
      "Transaction rolled back before an outer adapter write could run. Use the transaction client for transactional writes.",
    ),
    { code: "P2028" },
  );

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

function nativeTransactionId(client: object): string | undefined {
  for (const key of Object.getOwnPropertySymbols(client)) {
    const marker = Reflect.get(client, key);
    if (
      key.description === "prisma.client.transaction.id" &&
      typeof marker === "string"
    )
      return marker;
    if (
      key.description === "prisma.client.transaction.scope_context" &&
      typeof marker?.txId === "string"
    )
      return marker.txId;
  }
  return undefined;
}

interface NativeTransaction {
  result: Promise<boolean>;
  timer: ReturnType<typeof setTimeout> | undefined;
  finish(committed: boolean): void;
}
interface NativeWriteQueue {
  tail: Promise<void>;
  fenceOf(client: object): Promise<boolean> | undefined;
}
const engines = new WeakMap<object, NativeWriteQueue>();

interface NativeOwner {
  queue: NativeWriteQueue;
  fence: Promise<boolean>;
}
let owners: Promise<AsyncLocalStorage<NativeOwner> | undefined> | undefined;
// Without async context nothing proves ownership, so nothing is rejected.
const ownerContext = () =>
  (owners ??= import("node:async_hooks").then(
    ({ AsyncLocalStorage }) => new AsyncLocalStorage<NativeOwner>(),
    () => undefined,
  ));

/**
 * Waits for `turn`. Only async context can reject here: a caller inside a
 * transaction's callback belongs to it and cannot outlive its rollback. Any
 * other caller just waits, because another writer's rollback is not its own.
 * Checked at the adapter's call, where the context is the caller's: Prisma's
 * batch dispatch runs in whichever context queued first.
 */
async function admitted(
  queue: NativeWriteQueue,
  turn?: Promise<void>,
): Promise<void> {
  const owner = (await ownerContext())?.getStore();
  if (owner?.queue === queue && !(await owner.fence)) throw rolledBackWrite();
  await turn;
}

function nativeTransactions(
  prisma: EnginePrismaClient,
): NativeWriteQueue | undefined {
  // Prisma 6/7 expose no public transaction observer. Observe their shared
  // engine boundary so a caller's own $transaction takes a turn too.
  const engine = (prisma as any)._engine;
  if (!engine || typeof engine.transaction !== "function") return undefined;
  const known = engines.get(engine);
  if (known) return known;
  const transactions = new Map<string, NativeTransaction[]>();
  const transaction = engine.transaction.bind(engine);
  const queue: NativeWriteQueue = {
    tail: Promise.resolve(),
    fenceOf(client) {
      const id = nativeTransactionId(client);
      return id ? transactions.get(id)?.at(-1)?.result : undefined;
    },
  };
  engine.transaction = async (
    action: string,
    headers: unknown,
    options: any,
  ) => {
    if (action === "start") {
      let resolve!: (committed: boolean) => void;
      const result = new Promise<boolean>((finish) => {
        resolve = finish;
      });
      // Every transaction takes a turn, including one opened on the raw client:
      // Prisma 7 runs root statements on an open transaction's connection, so
      // a write that overlapped one would go with its rollback. A savepoint
      // runs inside its transaction's turn.
      const turn = options?.newTxId === undefined ? queue.tail : undefined;
      if (turn) queue.tail = result.then(() => {});
      let started: any;
      try {
        await turn;
        started = await transaction(action, headers, options);
      } catch (error) {
        resolve(false);
        throw error;
      }
      const entry: NativeTransaction = {
        result,
        timer:
          options.timeout === undefined
            ? undefined
            : setTimeout(async () => {
                // The driver's own timer starts its ROLLBACK first. Wait for
                // it, or the next turn could land on that connection.
                if (turn)
                  await transaction("rollback", headers, started).catch(
                    () => {},
                  );
                resolve(false);
              }, options.timeout),
        finish: resolve,
      };
      // Prisma 7 reuses a transaction ID for nested savepoint scopes.
      const stack = transactions.get(started.id) ?? [];
      stack.push(entry);
      transactions.set(started.id, stack);
      return started;
    }
    const stack = transactions.get(options?.id);
    const entry = stack?.at(-1);
    clearTimeout(entry?.timer);
    try {
      const result = await transaction(action, headers, options);
      entry?.finish(action === "commit");
      return result;
    } catch (error) {
      entry?.finish(false);
      throw error;
    } finally {
      stack?.pop();
      if (stack?.length === 0) transactions.delete(options?.id);
    }
  };
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
    nativeTransactionId(prisma) !== undefined ||
    typeof prisma.$transaction !== "function" ||
    (databaseType ?? (prisma as any)._activeProvider) !== "sqlite"
  )
    return client;
  const queue = nativeTransactions(prisma);
  if (!queue) return client;
  const afterTurn = <R>(work: () => Promise<R>): Promise<R> => {
    const pending = admitted(queue, queue.tail).then(work);
    queue.tail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
  const guard = (operation: any) => {
    let pending: Promise<unknown> | undefined;
    const run = () => (pending ??= afterTurn(() => operation));
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
            typeof arg === "function"
              ? admitted(queue).then(() =>
                  value.call(
                    target,
                    async (tx: EnginePrismaClient) => {
                      const fence = queue.fenceOf(tx);
                      if (!fence) return arg(tx);
                      const context = await ownerContext();
                      const callback = async () => arg(tx);
                      return Promise.race([
                        context
                          ? context.run({ queue, fence }, callback)
                          : callback(),
                        // A callback need not cooperate with the native driver's
                        // timeout, and only that timeout ends one still running.
                        fence.then((committed) => {
                          if (!committed)
                            throw Object.assign(
                              new Error(
                                "Transaction already closed: the transaction timeout passed before its callback settled.",
                              ),
                              { code: "P2028" },
                            );
                          return new Promise<never>(() => {});
                        }),
                      ]);
                    },
                    options,
                  ),
                )
              : // Waits without holding the turn: Prisma 7 sends a batch through
                // `transaction("start")`, which takes its own.
                admitted(queue, queue.tail).then(() =>
                  value.call(target, arg, options),
                );
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
