/**
 * Shared Kernel Test Harness
 *
 * The single `createTestKernel()` factory for kernel-dispatch tests: wires an
 * `InMemoryWorkflowPersistence` + `InMemoryBlobStore` + `InMemoryJobQueue` +
 * `CollectingEventSink` + `FakeClock` behind `createKernel()`, plus a
 * `registry` Map and an `outbox.flush` `flush()` helper.
 *
 * This replaces ~40 byte-identical (modulo brace style) local copies that
 * used to live at the top of individual test files. `KernelConfig.scheduler`
 * is optional and unused by the kernel (see `kernel/kernel.ts`), so this
 * factory does not construct or pass one -- pass `opts.eventSink` /
 * `opts.plugins` for the handful of tests that need non-default wiring.
 *
 * @example
 * ```typescript
 * import { createTestKernel } from "../utils/index.js";
 *
 * const { kernel, flush, persistence } = createTestKernel([myWorkflow]);
 * ```
 */

import type { Workflow } from "../../core/workflow.js";
import { createKernel, type WorkflowRegistry } from "../../kernel/kernel.js";
import {
  createPluginRunner,
  type PluginDefinition,
} from "../../kernel/plugins.js";
import type { EventSink } from "../../kernel/ports.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
} from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

export interface CreateTestKernelOptions<
  TEventSink extends EventSink = CollectingEventSink,
> {
  /**
   * Worker id passed to the underlying `InMemoryJobQueue`. Defaults to
   * `"test-worker"`, matching every existing fixture -- pass this
   * explicitly at call sites where the test asserts on the literal id.
   */
  workerId?: string;
  /**
   * Starting time for the `FakeClock`. Ignored when `opts.clock` is given.
   * Defaults to `FakeClock`'s own default (a fixed 2025-01-01T00:00:00Z).
   * Pass `new Date()` for tests (e.g. reap/duration checks) that compare
   * the clock against real `new Date()` timestamps stamped by
   * `InMemoryWorkflowPersistence`.
   */
  clockStart?: Date;
  /**
   * A pre-built `FakeClock` to use verbatim, taking precedence over
   * `clockStart`. For tests that need to hold a `FakeClock` reference
   * *before* the kernel is constructed (e.g. a stage closure that calls
   * `clock.advance()` during execution). Typed as the concrete class
   * (not the `Clock` port) so `opts.clock ?? new FakeClock(...)` doesn't
   * widen the returned `clock` field back down to the port interface.
   */
  clock?: FakeClock;
  /**
   * Plugin definitions wired through a `createPluginRunner` EventSink.
   * Ignored when `opts.eventSink` is given.
   */
  plugins?: PluginDefinition[];
  /** Max retries for the plugin runner. Only used with `opts.plugins`. */
  pluginMaxRetries?: number;
  /**
   * Full EventSink override, taking precedence over `opts.plugins`. Use
   * for ad hoc sinks (e.g. one that fails on specific events).
   */
  eventSink?: TEventSink;
  /** Forwarded to `createKernel`'s `idempotencyStaleInProgressMs`. */
  idempotencyStaleInProgressMs?: number;
}

export function createTestKernel<
  TEventSink extends EventSink = CollectingEventSink,
>(
  workflows: Workflow<any, any>[] = [],
  opts: CreateTestKernelOptions<TEventSink> = {},
) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue(opts.workerId ?? "test-worker");
  const clock = opts.clock ?? new FakeClock(opts.clockStart);

  // Precedence: explicit `eventSink` override > `plugins` runner > default
  // CollectingEventSink. The cast is sound for the default and override
  // cases (TEventSink is inferred from `opts.eventSink` there); the
  // `plugins`-only path returns a PluginRunner typed as the default
  // CollectingEventSink, which is fine because no fixture destructures
  // `eventSink` from that path today.
  const eventSink = (opts.eventSink ??
    (opts.plugins
      ? createPluginRunner({
          plugins: opts.plugins,
          maxRetries: opts.pluginMaxRetries,
        })
      : new CollectingEventSink())) as TEventSink;

  const registry = new Map<string, Workflow<any, any>>();
  for (const w of workflows) registry.set(w.id, w);
  const workflowRegistry: WorkflowRegistry = {
    getWorkflow: (id) => registry.get(id),
  };

  const kernel = createKernel({
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    clock,
    registry: workflowRegistry,
    ...(opts.idempotencyStaleInProgressMs !== undefined
      ? { idempotencyStaleInProgressMs: opts.idempotencyStaleInProgressMs }
      : {}),
  });

  const flush = () => kernel.dispatch({ type: "outbox.flush" as const });

  return {
    kernel,
    flush,
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    clock,
    registry,
  };
}
