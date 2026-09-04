/**
 * Claim-check spilling for payloads that can grow without bound.
 *
 * The engine has no payload ceiling, which is the right default for AI
 * workloads — a stage that returns a 4 MB extraction should not have to
 * think about it. The cost of having no ceiling is that a very large value
 * simply becomes a very large row, read back in full on every replay.
 *
 * Stage outputs have never had that problem: they are written to the
 * `BlobStore` and the row keeps only a key (`outputData._artifactKey`).
 * This module generalises that to the two ports the kernel fully owns and
 * whose rows are engine plumbing rather than part of a consumer's read
 * model:
 *
 *  - **durable step results** (`workflow_steps.result`) — an AI step's
 *    result is the single largest thing the engine stores per row, and a
 *    replay reads every step of the stage.
 *  - **job payloads** (`job_queue.payload`) — carries the run's config, and
 *    a transport that puts the row on a real queue is bound by that queue's
 *    message size.
 *
 * The spill is *soft*: values at or below the threshold are stored inline
 * exactly as before, so nothing changes for the overwhelming majority of
 * runs, and there is no hard ceiling above it. Reads are transparent — a
 * spilled value is resolved back before it reaches the caller, so no
 * consumer code changes.
 *
 * Requires a `BlobStore` every process that executes or replays a run can
 * read, which is the same requirement stage outputs already impose (see
 * `createPrismaBlobStore`). Without one, spilling cannot be enabled: the
 * kernel's `blobStore` port is mandatory, and `createSpillingJobTransport`
 * takes one as an argument, so there is no configuration in which a value
 * is spilled with nowhere to put it. Reading a spilled value back through
 * a *different* blob store than the one that wrote it throws
 * `SpilledPayloadUnavailableError` naming the key.
 */

import type {
  DequeueOptions,
  DequeueResult,
  EnqueueJobInput,
  JobAckFence,
  JobRecord,
} from "../persistence/interface.js";
import { SpilledPayloadUnavailableError } from "./errors.js";
import type {
  BlobStore,
  JobTransport,
  StepLedger,
  StepRecord,
  StepRecordExpectation,
  StepRecordPatch,
} from "./ports.js";

// ============================================================================
// Threshold
// ============================================================================

/**
 * Default soft threshold, in bytes of serialised JSON, above which a
 * payload is written to the blob store instead of inline.
 *
 * 64 KiB. The number is chosen from the smallest ceiling downstream of a
 * payload rather than from the database: a job payload is what a real queue
 * transport puts in a message, and the tightest common limit is Cloudflare
 * Queues at 128 KiB (Amazon SQS is 256 KiB). 64 KiB is the largest round
 * value that leaves a whole message envelope of headroom under that.
 *
 * It is also two orders of magnitude above Postgres's ~2 KiB TOAST
 * threshold, so an ordinary payload — a config object, a small extraction,
 * a handful of ids — never spills and never pays the extra round trip.
 * Everything that does spill was going to be read back in full on every
 * replay, which is the cost the claim check removes.
 *
 * Raise it when your blob store is slow relative to your database; set the
 * threshold to `Number.POSITIVE_INFINITY` to stop spilling new values
 * entirely (already-spilled values still resolve on read).
 */
export const DEFAULT_SPILL_THRESHOLD_BYTES = 65_536;

// ============================================================================
// The reference (claim check)
// ============================================================================

/** Discriminant field of a spilled-payload reference. */
export const SPILL_REF_MARKER = "$wfSpill" as const;

/** What is stored inline in place of a spilled value. */
export interface SpillRef {
  /** Format version of the reference. */
  readonly $wfSpill: 1;
  /** Blob store key holding the real value. */
  readonly key: string;
  /** Size of the spilled value in bytes of serialised JSON. */
  readonly bytes: number;
}

/** Whether a stored value is a claim check rather than the value itself. */
export function isSpillRef(value: unknown): value is SpillRef {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { [SPILL_REF_MARKER]?: unknown })[SPILL_REF_MARKER] === 1 &&
    typeof (value as { key?: unknown }).key === "string"
  );
}

// ============================================================================
// Codec
// ============================================================================

export interface PayloadSpillOptions {
  /** Where spilled values are written. Required — see the module comment. */
  blobStore: BlobStore;
  /**
   * Soft threshold in bytes of serialised JSON. Defaults to
   * `DEFAULT_SPILL_THRESHOLD_BYTES`. `Number.POSITIVE_INFINITY` stops new
   * values from spilling without breaking reads of old ones.
   */
  thresholdBytes?: number;
}

export interface PayloadSpill {
  /** Threshold in effect, for diagnostics. */
  readonly thresholdBytes: number;
  /**
   * Store `value` under `key` and return a `SpillRef` when it exceeds the
   * threshold; return `value` untouched otherwise. Values that are not
   * JSON-serialisable are returned untouched — the ledger's own
   * serialisation contract, not this one, decides what happens to them.
   */
  pack(key: string, value: unknown): Promise<unknown>;
  /** Resolve a `SpillRef` back to its value; pass anything else through. */
  unpack(value: unknown): Promise<unknown>;
  /**
   * Best-effort delete of every spilled value under a key prefix, except
   * any key listed in `keep`. The exception exists for a partial ledger
   * clear, which must leave the results of the rows it preserves readable.
   */
  deleteUnder(prefix: string, keep?: Iterable<string>): Promise<void>;
}

/**
 * Number of UTF-8 bytes `json` occupies. Skips the encode entirely when the
 * string is short enough that it cannot exceed `limit` at the worst case of
 * 3 bytes per UTF-16 code unit, which is the common path.
 */
function jsonByteLength(json: string, limit: number): number {
  if (json.length * 3 <= limit) return json.length;
  return new TextEncoder().encode(json).length;
}

export function createPayloadSpill(options: PayloadSpillOptions): PayloadSpill {
  const { blobStore } = options;
  const thresholdBytes =
    options.thresholdBytes ?? DEFAULT_SPILL_THRESHOLD_BYTES;
  if (thresholdBytes < 0 || Number.isNaN(thresholdBytes)) {
    throw new Error(
      `spillThresholdBytes must be a non-negative number, got ${thresholdBytes}`,
    );
  }

  return {
    thresholdBytes,

    async pack(key, value) {
      if (value === undefined || value === null) return value;
      if (!Number.isFinite(thresholdBytes)) return value;
      // Never spill a reference again: re-packing an already-packed value
      // (two decorators applied to one port) must be a no-op.
      if (isSpillRef(value)) return value;

      let json: string | undefined;
      try {
        json = JSON.stringify(value);
      } catch {
        return value;
      }
      if (json === undefined) return value;

      const bytes = jsonByteLength(json, thresholdBytes);
      if (bytes <= thresholdBytes) return value;

      await blobStore.put(key, value);
      return { [SPILL_REF_MARKER]: 1, key, bytes } satisfies SpillRef;
    },

    async unpack(value) {
      if (!isSpillRef(value)) return value;
      let blob: unknown;
      try {
        blob = await blobStore.get(value.key);
      } catch (error) {
        throw new SpilledPayloadUnavailableError(value.key, error);
      }
      if (blob === undefined || blob === null) {
        throw new SpilledPayloadUnavailableError(value.key);
      }
      return blob;
    },

    async deleteUnder(prefix, keep) {
      const kept = new Set(keep ?? []);
      const keys = await blobStore.list(prefix).catch(() => [] as string[]);
      for (const key of keys) {
        if (kept.has(key)) continue;
        await blobStore.delete(key).catch(() => {});
      }
    },
  };
}

// ============================================================================
// Key layout
// ============================================================================

/** Prefix holding every spilled result of one stage record's steps. */
export function stepSpillPrefix(stageRecordId: string): string {
  return `workflow-v2/spill/steps/${encodeURIComponent(stageRecordId)}/`;
}

function stepSpillKey(stageRecordId: string, stepId: string): string {
  return `${stepSpillPrefix(stageRecordId)}${encodeURIComponent(stepId)}.json`;
}

function jobSpillKey(workflowRunId: string, stageId: string): string {
  return `workflow-v2/spill/jobs/${encodeURIComponent(workflowRunId)}/${encodeURIComponent(stageId)}.json`;
}

// ============================================================================
// StepLedger decorator
// ============================================================================

/**
 * Wraps a `StepLedger` so results above the threshold live in the blob
 * store. Every write path packs and every read path resolves, so callers
 * see the value they stored — `createKernel` applies this to the ledger it
 * is given, so a consumer does not wire it themselves.
 *
 * `clear()` removes the stage's spilled blobs after the rows, so a failure
 * between the two leaks a blob rather than orphaning a reference.
 */
export function withStepResultSpill(
  ledger: StepLedger,
  spill: PayloadSpill,
): StepLedger {
  async function resolve(record: StepRecord): Promise<StepRecord> {
    if (!isSpillRef(record.result)) return record;
    return { ...record, result: await spill.unpack(record.result) };
  }

  async function packPatch(
    stageRecordId: string,
    stepId: string,
    patch: StepRecordPatch,
  ): Promise<StepRecordPatch> {
    if (!Object.hasOwn(patch, "result")) return patch;
    return {
      ...patch,
      result: await spill.pack(
        stepSpillKey(stageRecordId, stepId),
        patch.result,
      ),
    };
  }

  return {
    async claim(record) {
      const result = await spill.pack(
        stepSpillKey(record.stageRecordId, record.stepId),
        record.result,
      );
      const outcome = await ledger.claim({ ...record, result });
      return {
        created: outcome.created,
        record: await resolve(outcome.record),
      };
    },

    async get(stageRecordId, stepId) {
      const record = await ledger.get(stageRecordId, stepId);
      return record ? resolve(record) : null;
    },

    async update(stageRecordId, stepId, patch) {
      const updated = await ledger.update(
        stageRecordId,
        stepId,
        await packPatch(stageRecordId, stepId, patch),
      );
      return resolve(updated);
    },

    async compareAndSet(
      stageRecordId: string,
      stepId: string,
      expected: StepRecordExpectation,
      patch: StepRecordPatch,
    ) {
      const outcome = await ledger.compareAndSet(
        stageRecordId,
        stepId,
        expected,
        await packPatch(stageRecordId, stepId, patch),
      );
      return {
        applied: outcome.applied,
        record: outcome.record ? await resolve(outcome.record) : null,
      };
    },

    async list(stageRecordId) {
      const records = await ledger.list(stageRecordId);
      return Promise.all(records.map(resolve));
    },

    async clear(stageRecordId) {
      await ledger.clear(stageRecordId);
      await spill.deleteUnder(stepSpillPrefix(stageRecordId));
    },

    // `clearExcept` is optional on the port and the kernel branches on its
    // presence: a ledger without it gets the whole-ledger clear that
    // destroys the external keys of effects still in flight. So the
    // decorator must expose it exactly when the wrapped ledger does —
    // wrapping an implementation that has it and not forwarding would
    // silently downgrade every kernel to the fallback path.
    ...(ledger.clearExcept
      ? {
          async clearExcept(stageRecordId: string, keepStepIds: string[]) {
            await ledger.clearExcept?.(stageRecordId, keepStepIds);
            // Only the blobs of the rows that actually went. A preserved
            // row is re-opened, not deleted, and its last result must stay
            // readable, so its spilled value has to stay too.
            await spill.deleteUnder(
              stepSpillPrefix(stageRecordId),
              keepStepIds.map((stepId) => stepSpillKey(stageRecordId, stepId)),
            );
          },
        }
      : {}),
  };
}

// ============================================================================
// JobTransport decorator
// ============================================================================

export interface SpillingJobTransportOptions extends PayloadSpillOptions {
  /**
   * Dotted path into the job payload naming the fairness group. Defaults to
   * the wrapped transport's own `fairnessGroupBy` when it exposes one (the
   * Prisma job queue does), so a queue with fairness configured needs no extra
   * configuration here. When set (or discovered) and a payload is about to
   * spill, the value at that path is hoisted onto `EnqueueJobInput.groupKey`
   * before the body is packed, so the queue row still carries the group and
   * starvation protection survives spilling.
   */
  groupBy?: string;
}

/**
 * Splits a dotted payload path into segments matching the convention used by
 * PrismaJobQueue. Kept local rather than exported from job-queue.ts to avoid
 * coupling kernel spilling to the Prisma persistence module.
 */
function splitGroupPath(groupBy: string): string[] {
  const segments = groupBy.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error(
      `JobQueueFairness.groupBy must name at least one payload field, got ${JSON.stringify(groupBy)}`,
    );
  }
  return segments;
}

/**
 * Resolves a nested property from a payload object along the given key path.
 * Returns undefined if any intermediate property is not an object or if the
 * final value is absent. Values that are objects, arrays, null, or undefined
 * are ignored because they cannot serve as a sensible group key.
 */
function extractGroupValue(payload: unknown, segments: string[]): unknown {
  let current: unknown = payload;
  for (const segment of segments) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Wraps a `JobTransport` so job payloads above the threshold live in the
 * blob store and the queue row (or message) carries only a claim check.
 *
 * Pass the wrapped transport to **both** `createKernel` and the host, so
 * the enqueue that packs and the dequeue that resolves are the same object.
 *
 * One caveat, for push transports only: a consumer who delivers job
 * messages through their own queue (Cloudflare Queues, SQS) and calls
 * `host.handleJob(msg)` with a message they built themselves bypasses
 * `dequeue()`, and so bypasses the resolve. Those consumers should resolve
 * the payload first with a `createPayloadSpill(...)` of their own:
 *
 * ```ts
 * const spill = createPayloadSpill({ blobStore });
 * await host.handleJob({
 *   ...msg,
 *   payload: (await spill.unpack(msg.payload)) as Record<string, unknown>,
 * });
 * ```
 */
export function createSpillingJobTransport(
  transport: JobTransport,
  options: SpillingJobTransportOptions,
): JobTransport {
  const spill = createPayloadSpill(options);
  const groupByPath = options.groupBy ?? transport.fairnessGroupBy ?? null;
  const groupSegments = groupByPath ? splitGroupPath(groupByPath) : null;

  async function resolvePayload(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!isSpillRef(payload)) return payload;
    return (await spill.unpack(payload)) as Record<string, unknown>;
  }

  return {
    async enqueueParallel(jobs: EnqueueJobInput[]) {
      const packed = await Promise.all(
        jobs.map(async (job) => {
          if (job.payload === undefined) return job;
          const originalGroupValue =
            groupSegments && job.groupKey === undefined
              ? extractGroupValue(job.payload, groupSegments)
              : undefined;
          const payload = await spill.pack(
            jobSpillKey(job.workflowRunId, job.stageId),
            job.payload,
          );
          // Only hoist the group value to `groupKey` when the payload actually
          // spilled. Inline rows retain their full payload in the database row,
          // so Postgres can read the group key directly from the configured
          // path; hoisting for inline rows is unnecessary and would alter
          // grouping semantics for existing inline consumers.
          const shouldHoistGroupKey =
            isSpillRef(payload) &&
            job.groupKey === undefined &&
            (typeof originalGroupValue === "string" ||
              (typeof originalGroupValue === "number" &&
                Number.isFinite(originalGroupValue)));

          return {
            ...job,
            ...(shouldHoistGroupKey
              ? { groupKey: String(originalGroupValue) }
              : {}),
            payload: payload as Record<string, unknown>,
          };
        }),
      );
      return transport.enqueueParallel(packed);
    },

    async deleteByRunAndStages(workflowRunId: string, stageIds: string[]) {
      const removed = await transport.deleteByRunAndStages(
        workflowRunId,
        stageIds,
      );
      for (const stageId of stageIds) {
        await spill.deleteUnder(jobSpillKey(workflowRunId, stageId));
      }
      return removed;
    },

    async dequeue(options?: DequeueOptions): Promise<DequeueResult | null> {
      const job = await transport.dequeue(options);
      if (!job) return null;
      return { ...job, payload: await resolvePayload(job.payload) };
    },

    async getJobsByWorkflowRun(workflowRunId: string): Promise<JobRecord[]> {
      const jobs = await transport.getJobsByWorkflowRun(workflowRunId);
      return Promise.all(
        jobs.map(async (job) => ({
          ...job,
          payload: await resolvePayload(job.payload),
        })),
      );
    },

    // The acknowledgement methods carry a `fence` the host builds from the
    // claim it is acknowledging. Forward it verbatim: a decorator that drops
    // it silently turns every fenced acknowledgement back into an
    // unconditional write, which is exactly the stale-worker overwrite the
    // fence exists to stop — and TypeScript cannot catch the omission,
    // because a function taking fewer parameters is assignable to one taking
    // more.
    complete: (jobId: string, fence?: JobAckFence) =>
      transport.complete(jobId, fence),
    suspend: (jobId: string, nextPollAt: Date, fence?: JobAckFence) =>
      transport.suspend(jobId, nextPollAt, fence),
    fail: (
      jobId: string,
      error: string,
      shouldRetry?: boolean,
      fence?: JobAckFence,
    ) => transport.fail(jobId, error, shouldRetry, fence),
    releaseStaleJobs: (staleThresholdMs?: number) =>
      transport.releaseStaleJobs(staleThresholdMs),
    cancelByRun: (workflowRunId: string) =>
      transport.cancelByRun(workflowRunId),
    touchJob: (jobId: string) => transport.touchJob(jobId),
    // Both optional methods are forwarded only when the wrapped transport
    // has them, so wrapping never claims a capability the inner transport
    // lacks — and never hides one it has.
    ...(transport.expireRunawayJobs
      ? {
          expireRunawayJobs: (absoluteTimeoutMs: number) =>
            transport.expireRunawayJobs?.(absoluteTimeoutMs) ??
            Promise.resolve(0),
        }
      : {}),
    ...(transport.adoptWorkerId
      ? {
          adoptWorkerId: (workerId: string) =>
            transport.adoptWorkerId?.(workerId) ?? workerId,
        }
      : {}),
    ...(transport.defer
      ? {
          defer: (
            jobId: string,
            nextPollAt: Date,
            reason: string,
            fence?: JobAckFence,
          ) =>
            transport.defer?.(jobId, nextPollAt, reason, fence) ??
            Promise.resolve("acknowledged" as const),
        }
      : {}),
    ...(groupByPath !== null
      ? { fairnessGroupBy: groupByPath }
      : transport.fairnessGroupBy !== undefined
        ? { fairnessGroupBy: transport.fairnessGroupBy }
        : {}),
  };
}
