import type { Persistence, TransactionReadPort } from "../ports.js";

const boundReads = new WeakSet<object>();

export function isTransactionReadBound(port: object): boolean {
  return boundReads.has(port);
}

/** Share the transaction's connection for reads without rebinding writes. */
export function withTransactionReads<T extends object>(
  port: T,
  persistence: Persistence,
  methods: readonly (keyof T)[],
): T {
  const reads = (port as T & TransactionReadPort<T>).transactionReads?.(
    persistence,
  );
  if (!reads) return port;

  const view = new Proxy(port, {
    get(target, key) {
      const source =
        methods.includes(key as keyof T) && key in reads ? reads : target;
      const value = Reflect.get(source, key);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
  boundReads.add(view);
  return view;
}
