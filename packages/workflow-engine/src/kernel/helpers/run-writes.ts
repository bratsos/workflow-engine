import { RUN_WRITE_LEASE_MS } from "../../persistence/interface.js";
import type { KernelDeps } from "../kernel.js";
import type { Persistence } from "../ports.js";

/**
 * A registration of this process as a writer of one run's data, which
 * `run.purge` waits for. It is admitted only while the run exists and has
 * not ended, so once a run has ended no new writer can start; it is
 * refreshed while held, so one whose process died stops counting after
 * `RUN_WRITE_LEASE_MS`.
 */
export interface RunWriter {
  /** Whether the registration is held. */
  readonly held: boolean;
  /**
   * Run a write. While the registration is held it runs as it is and is
   * waited for by `close`; otherwise it runs under a registration of its
   * own and is skipped (resolving `undefined`) once the run has ended.
   */
  write<T>(fn: () => T | Promise<T>): Promise<T | undefined>;
  /** Release once the writes started while held have settled. */
  close(): Promise<void>;
}

/** Register (or adopt `token`, registered in a transaction) and keep it alive. */
export async function openRunWriter(
  persistence: Persistence,
  workflowRunId: string,
  token?: string,
): Promise<RunWriter> {
  if (
    !persistence.beginRunWrite ||
    !persistence.refreshRunWrite ||
    !persistence.endRunWrite
  ) {
    return { held: true, write: async (fn) => fn(), close: async () => {} };
  }
  const id = token ?? crypto.randomUUID();
  const registered =
    token !== undefined || (await persistence.beginRunWrite(workflowRunId, id));
  let held = registered;
  let confirmedAt = Date.now();
  // A registration erased with its run, or one this process could not
  // refresh, no longer admits writes.
  const refresh = async () => {
    const kept = await persistence.refreshRunWrite!(id).catch(() => false);
    if (kept) confirmedAt = Date.now();
    else held = false;
  };
  const pending = new Set<Promise<unknown>>();
  const timer = registered
    ? setInterval(() => void refresh(), RUN_WRITE_LEASE_MS / 3)
    : undefined;
  timer?.unref?.();
  let closed = false;
  return {
    get held() {
      return held;
    },
    async write(fn) {
      // After a stall (the refreshes could not run), check before writing:
      // erasure may have taken the run once the lease lapsed.
      if (held && Date.now() - confirmedAt > RUN_WRITE_LEASE_MS / 2)
        await refresh();
      if (!held) return writeForRun(persistence, workflowRunId, fn);
      const write = Promise.resolve().then(fn);
      pending.add(write);
      void write.finally(() => pending.delete(write)).catch(() => {});
      return write;
    },
    async close() {
      if (closed) return;
      closed = true;
      held = false;
      if (!registered) return;
      const end = async () => {
        await Promise.allSettled([...pending]);
        clearInterval(timer);
        await persistence.endRunWrite!(id).catch(() => {});
      };
      // A write the caller did not await keeps the registration (and its
      // refresh) until it settles, without holding the caller.
      if (pending.size === 0) return end();
      void end();
    },
  };
}

/** One write under its own registration; skipped once the run has ended. */
export async function writeForRun<T>(
  persistence: Persistence,
  workflowRunId: string,
  write: () => T | Promise<T>,
): Promise<T | undefined> {
  if (!persistence.beginRunWrite) return write();
  const writer = await openRunWriter(persistence, workflowRunId);
  if (!writer.held) return undefined;
  try {
    return await write();
  } finally {
    await writer.close();
  }
}

function fenced<T extends object>(
  target: T,
  methods: readonly string[],
  wrap: (method: string, call: () => unknown) => unknown,
): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      if (typeof property === "string" && methods.includes(property)) {
        return (...args: unknown[]) =>
          wrap(property, () => value.apply(object, args));
      }
      return value.bind(object);
    },
  });
}

/**
 * The ports a stage execution writes run data through (blobs, step rows, AI
 * calls), each write going through `writer` (by default, its own
 * registration per write). A context the stage code keeps after its
 * execution returned therefore cannot write to a run that has ended.
 */
export function fenceRunWrites(
  deps: KernelDeps,
  workflowRunId: string,
  writer?: RunWriter,
): KernelDeps {
  if (!deps.persistence.beginRunWrite) return deps;
  // `undefined` when the run has ended and the write was skipped.
  const write = (call: () => unknown) => {
    const boxed = async () => ({ value: await call() });
    return writer
      ? writer.write(boxed)
      : writeForRun(deps.persistence, workflowRunId, boxed);
  };
  const aiLogger = deps.services?.aiLogger;
  return {
    ...deps,
    blobStore: fenced(deps.blobStore, ["put"], async (_, call) => {
      await write(call);
    }),
    stepLedger:
      deps.stepLedger &&
      fenced(
        deps.stepLedger,
        ["claim", "update", "compareAndSet"],
        async (method, call) => {
          const written = await write(call);
          if (written) return written.value;
          if (method === "compareAndSet")
            return { applied: false, record: null };
          throw new Error(`Run ${workflowRunId} has ended; step not written`);
        },
      ),
    services: aiLogger
      ? {
          ...deps.services,
          aiLogger: fenced(
            aiLogger,
            ["logCall", "logBatchResults"],
            (method, call) => {
              const written = write(call).then(() => {});
              // AI helpers do not await `logCall`: a failed write is dropped
              // as the logger's own failures are.
              if (method === "logCall") written.catch(() => {});
              return written;
            },
          ),
        }
      : deps.services,
  };
}
