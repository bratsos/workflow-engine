// The real setImmediate, taken at import, before a test can install fake timers.
const realSetImmediate = globalThis.setImmediate;

/**
 * Turn the event loop once. Work that runs on promises alone (every await on a
 * synchronous SQLite driver resolves as a microtask) never lets the loop turn,
 * so Vitest's worker cannot read the reply to its `onTaskUpdate` RPC. Past 60 s
 * the call times out and the run exits 1 with every assertion passing.
 */
export const yieldToHost = () =>
  new Promise<void>((resolve) => realSetImmediate(resolve));
