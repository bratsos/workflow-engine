# Large Payloads and the Claim Check

The workflow engine imposes no hard ceiling on payload sizes, allowing stages to exchange multi-megabyte objects without arbitrary size rejections. The trade-off is database footprint and replay latency: a very large value stored inline becomes a very large database row that must be deserialised in full on every stage replay. The claim-check pattern moves values exceeding a configurable soft threshold into the configured `BlobStore`, leaving a lightweight pointer reference inline in the database row. This reference covers how durable step results and job payloads use the claim check, how the threshold is configured, which tables remain inline, and how to handle push-based queue consumers.

## What problem the claim check solves

Workflows that process documents, parse bulk artifacts, or interact with large language models frequently produce multi-megabyte payloads. The engine deliberately enforces no payload ceiling: rejecting a payload at an arbitrary limit forces workflows to introduce bespoke storage plumbing into individual stage bodies.

However, having no ceiling means that storing payloads directly in operational database rows degrades performance over time. When a stage suspends and resumes, its execution re-runs, and durable step results are re-read from the step ledger on every replay. A 4 MiB extraction stored inline in `workflow_steps.result` requires reading and deserialising 4 MiB of JSON on every poll and every subsequent step transition.

Stage outputs have always avoided this problem: stage outputs are written directly to the `BlobStore` upon stage completion, leaving only a storage key (`outputData._artifactKey`) on the stage record. Claim-check spilling generalises this mechanism to internal engine plumbing:

- **Durable step results** (`workflow_steps.result`): Step results can grow large on LLM calls or extraction steps. Because replays re-read every step row recorded by the stage, large inline results severely penalise stage replay.
- **Job payloads** (`job_queue.payload`): Job payloads carry stage input and configuration. Real-world message queue transports enforce strict payload boundaries; for example, Cloudflare Queues enforces a 128 KiB ceiling, and Amazon SQS enforces 256 KiB. Spilling prevents oversized job payloads from failing message transport ingestion.

The claim check is soft and transparent: values below the threshold remain inline, avoiding extra network round trips, while values above the threshold spill to the blob store. Reads automatically resolve the pointer back to the original value before returning it to the caller, requiring no manual fetch code in stage definitions.

```typescript
/** What is stored inline in place of a spilled value. */
interface SpillRef {
  readonly $wfSpill: 1;
  readonly key: string;
  readonly bytes: number;
}

declare function isSpillRef(value: unknown): value is SpillRef;
```

`SpillRef`, `isSpillRef` and `SPILL_REF_MARKER` (`"$wfSpill"`) are exported
from the root entry, so a custom `StepLedger` or `JobTransport` can recognise
a reference it did not create.

The underlying codec is encapsulated by the `PayloadSpill` interface, instantiated via `createPayloadSpill`:

```typescript
export interface PayloadSpillOptions {
  blobStore: BlobStore;
  thresholdBytes?: number;
}

export interface PayloadSpill {
  readonly thresholdBytes: number;
  pack(key: string, value: unknown): Promise<unknown>;
  unpack(value: unknown): Promise<unknown>;
  deleteUnder(prefix: string, keep?: Iterable<string>): Promise<void>;
}
```

- `pack(key, value)` serialises `value` to JSON to compute its UTF-8 byte length. If `value` is `null`, `undefined`, not JSON-serialisable, already a `SpillRef`, or its serialised length does not exceed `thresholdBytes`, `pack` returns `value` untouched. If the byte length exceeds `thresholdBytes`, it writes `value` to `blobStore.put(key, value)` and returns a `SpillRef`.
- `unpack(value)` checks `isSpillRef(value)`. If it is not a reference, it returns `value` untouched. If it is a `SpillRef`, it fetches the value via `blobStore.get(value.key)`. If `blobStore.get` throws or returns `null` or `undefined`, it throws `SpilledPayloadUnavailableError`.
- `deleteUnder(prefix, keep)` lists keys under `prefix` using `blobStore.list(prefix)` and deletes all keys except those in `keep`. This partial retention is required when clearing a step ledger while preserving active external step keys.

## Durable step results (automatic)

Step result spilling is **automatic**. Whenever a `stepLedger` is supplied to `createKernel`, the kernel automatically wraps that ledger with `withStepResultSpill`:

```typescript
// Inside createKernel:
const stepLedger = config.stepLedger
  ? withStepResultSpill(
      config.stepLedger,
      createPayloadSpill({
        blobStore,
        ...(config.spillThresholdBytes !== undefined
          ? { thresholdBytes: config.spillThresholdBytes }
          : {}),
      }),
    )
  : undefined;
```

`withStepResultSpill(ledger, spill)` decorates every ledger read and write method:
- `claim`: Packs `record.result` before claiming the row, and resolves `record.result` on the returned outcome.
- `get`: Reads the record and resolves `record.result` if spilled.
- `update`: Packs `patch.result` if present before calling the underlying ledger update, then resolves the returned record.
- `compareAndSet`: Packs `patch.result` if present before executing the compare-and-set, then resolves the returned record.
- `list`: Resolves `record.result` across all returned records in parallel.
- `clear`: Clears the stage ledger rows first, then calls `spill.deleteUnder(stepSpillPrefix(stageRecordId))` to purge spilled blobs. Cleaning up rows before deleting blobs ensures that an intermediate failure leaves an orphaned blob rather than an orphaned reference pointing to missing storage.
- `clearExcept`: Forwards directly to the underlying ledger if implemented, retaining blobs for any `keepStepIds` so that preserved rows remain readable on subsequent replays.

Blob keys for durable steps are structured predictably:
- Step prefix: `workflow-v2/spill/steps/${encodeURIComponent(stageRecordId)}/`
- Step key: `${stepSpillPrefix(stageRecordId)}${encodeURIComponent(stepId)}.json`

Because the kernel owns all reads and writes to `StepLedger`, `ctx.step.run(...)` transparently receives the original value on both initial execution and replay without developer intervention. Every step outcome write spills the same way — `run` and `waitFor` results, `ctx.step.ai.*` results and a map item's failed verdict — and every read resolves, including a replay answered from the ledger and a worker parked on another worker's outcome. Spilled blobs go with their rows: clearing a stage's ledger (a redrive, a fresh attempt of a terminally failed stage) deletes them, a partial `clearExcept` keeps the blobs of the rows it keeps, and `run.purge` deletes both spill prefixes of a run along with its stage outputs and artifacts. Measured on one stage with two large step results: 520,022 inline bytes before spilling, 224 after; a 300,036-byte job payload becomes a 79-byte queue row.

## Job payloads (opt-in at wiring)

Unlike the step ledger, which is entirely internal to the kernel, the `JobTransport` is shared between the kernel (which enqueues jobs) and the host worker (which dequeues and executes jobs). Consequently, job payload spilling cannot be wrapped invisibly inside `createKernel`. It is **opt-in at wiring time**.

To enable job payload spilling, wrap your `JobTransport` in `createSpillingJobTransport` before passing it to both the kernel and the host:

```typescript
import {
  createKernel,
  createPayloadSpill,
  createPrismaBlobStore,
  createPrismaJobQueue,
  createSpillingJobTransport,
} from "@bratsos/workflow-engine";
import { createNodeHost } from "@bratsos/workflow-engine-host-node";

const blobStore = createPrismaBlobStore(prisma);
const rawTransport = createPrismaJobQueue(prisma);

const spillingTransport = createSpillingJobTransport(rawTransport, {
  blobStore,
  // thresholdBytes defaults to 65_536 (64 KiB)
});

const kernel = createKernel({
  persistence,
  blobStore,
  jobTransport: spillingTransport, // Enqueue packs payloads
  // ... other kernel config
});

const host = createNodeHost({
  kernel,
  workerId: "worker-1",
  jobTransport: spillingTransport, // Dequeue unpacks payloads
  // ... other host config
});
```

`SpillingJobTransportOptions` is `PayloadSpillOptions` plus the fairness path:

```typescript
export interface SpillingJobTransportOptions extends PayloadSpillOptions {
  /** Dotted payload path naming the fairness group; defaults to the wrapped transport's `fairnessGroupBy`. */
  groupBy?: string;
}
```

The decorator intercepts specific transport methods:
- **Packs on**: `enqueueParallel(jobs)`. For each job whose `payload` is defined, it packs the payload under `workflow-v2/spill/jobs/${encodeURIComponent(job.workflowRunId)}/${encodeURIComponent(job.stageId)}.json`.
- **Unpacks on**: `dequeue()` and `getJobsByWorkflowRun(workflowRunId)`. Each returned job record has its `payload` resolved through `spill.unpack` before being handed to the host.
- **Deletes on**: `deleteByRunAndStages(workflowRunId, stageIds)`. Calls the underlying transport method and removes spilled blobs under `jobSpillKey(workflowRunId, stageId)` for each designated stage.
- **Passes through**: `complete`, `suspend`, and `fail` forward all arguments including `fence` intact (preserving optimistic concurrency fencing); `releaseStaleJobs`, `cancelByRun`, and `touchJob` delegate directly. Optional methods `expireRunawayJobs`, `adoptWorkerId` and `defer` are forwarded only when present on the wrapped transport, so the wrapper never claims a capability the inner transport lacks — and, like any decorator around a transport, it must forward `fence` explicitly, because a delegation that drops the optional parameter still typechecks and silently turns every fenced acknowledgement back into an unconditional write.

### Spilling and per-group fairness

A queue with fairness on (`createPrismaJobQueue(prisma, { fairness: { maxConcurrentPerGroup, groupBy: "config.tenantId" } })`, see 05-persistence-setup.md) reads the group off the payload row. Replacing that payload with a claim check would hide the configured path and collapse every spilled job into one anonymous group — losing starvation protection for exactly the tenants whose payloads are largest. So the decorator discovers the wrapped queue's `fairnessGroupBy` (or takes an explicit `groupBy` of its own), and when a payload is about to spill it hoists the string or number at that path onto `EnqueueJobInput.groupKey` before packing, so the row still carries `_groupKey`; the fairness statement falls back to `_groupKey` when the configured path is absent from the row. Inline payloads are not touched, and a job that already carries `groupKey` keeps it. The wrapper re-exposes the path as its own `fairnessGroupBy`.

## The threshold and how to change it

The default soft threshold is defined by `DEFAULT_SPILL_THRESHOLD_BYTES = 65_536` (64 KiB).

The rationale for 64 KiB is derived from the tightest downstream message envelope rather than database row considerations:
1. **Downstream transport limits**: When using cloud queue services as transports, message bodies have strict caps. The tightest common ceiling is Cloudflare Queues at 128 KiB (Amazon SQS allows 256 KiB). A 64 KiB threshold ensures that a spilled reference plus transport metadata fits well within a 128 KiB envelope with headroom.
2. **Well above where Postgres already helps**: Postgres moves a large field out of line into TOAST at roughly 2 KiB, so it is already handling the middle of the range on its own. 64 KiB is two orders of magnitude above that, which is what keeps an ordinary payload — a config object, a small extraction, a handful of ids — inline and free of a blob-store round trip. Everything that does spill was going to be read back in full on every replay, which is the cost the claim check removes.

To tune or disable spilling, pass `spillThresholdBytes` to `createKernel` and `thresholdBytes` to `createSpillingJobTransport`:

```typescript
const kernel = createKernel({
  // ...
  blobStore,
  spillThresholdBytes: 128 * 1024, // Raise threshold to 128 KiB
});

const spillingTransport = createSpillingJobTransport(transport, {
  blobStore,
  thresholdBytes: 128 * 1024,
});
```

To disable spilling entirely and keep all new payloads inline:

```typescript
const kernel = createKernel({
  // ...
  blobStore,
  spillThresholdBytes: Number.POSITIVE_INFINITY,
});
```

Setting the threshold to `Number.POSITIVE_INFINITY` stops new values from spilling. Already-spilled values previously recorded in the database will continue to resolve normally during reads, because `unpack` always inspects `isSpillRef` regardless of the configured threshold.

## What is not spilled and why

Only two locations in the database schema participate in claim-check spilling:
- `workflow_steps.result`
- `job_queue.payload`

The engine deliberately **does not spill** the following columns:
- `workflow_runs.input`, `workflow_runs.output`, and `workflow_runs.config`
- `workflow_stages.suspendedState`
- `workflow_annotations.value` and `payload`
- `workflow_logs.metadata`

The reason is architectural: the run, stage, annotation, and log tables constitute the consumer-facing read model. External SQL dashboards, business intelligence pipelines, operational queries, and reporting views query these tables directly. Replacing values with JSON pointer references in those tables would break external queries and require consumers to implement custom resolution logic.

In contrast, `workflow_steps` and `job_queue` represent private engine plumbing. Stages and hosts interact with them strictly through the engine's kernel and transport ports, making the claim check completely invisible to application code.

Furthermore, stage outputs did not need claim checks added: stages already write outputs to `BlobStore` when producing artifacts, recording only the key (`outputData._artifactKey`) on the stage record.

## When the blob store is not shared

Claim checks require that every process executing, resuming, or polling a run has access to the exact same `BlobStore`.

If a worker or host process attempts to unpack a spilled reference using a `BlobStore` that does not contain the key—for instance, if one process uses `createPrismaBlobStore` while another uses a disconnected `InMemoryBlobStore`, or if separate workers connect to different storage buckets—the unpack operation fails with `SpilledPayloadUnavailableError`:

```
Spilled payload "workflow-v2/spill/steps/stage-123/step-1.json" is not in the blob store. Every process that executes or polls a run must share one BlobStore (see createPrismaBlobStore).
```

`SpilledPayloadUnavailableError` exposes:
- `key`: The missing blob key that failed resolution.
- `cause`: The underlying error thrown by `blobStore.get(key)`, if one occurred.

Because the kernel's `blobStore` configuration option is mandatory, and `createSpillingJobTransport` requires a `blobStore` in its options, the engine prevents configurations where data could be spilled without an available storage backend.

## The push-handler caveat

Hosts that poll for work via `host.processAvailableJobs()` or use `transport.dequeue()` automatically run through `spill.unpack`.

However, serverless architectures often ingest messages through push handlers where the queue service delivers directly to an HTTP or worker handler (such as a Cloudflare Queue consumer or an AWS Lambda triggered by SQS). When code constructs a job structure directly and calls `host.handleJob(msg)`, it bypasses `transport.dequeue()` and therefore bypasses the automatic unpack logic.

In this scenario, `msg.payload` may still be a raw `SpillRef` object `{ $wfSpill: 1, key: "...", bytes: ... }`. Push consumers must unpack the payload explicitly before invoking `host.handleJob`:

```typescript
import { createPayloadSpill } from "@bratsos/workflow-engine";

const spill = createPayloadSpill({ blobStore });

export async function handleQueueMessage(msg: QueueMessage) {
  const resolvedPayload = (await spill.unpack(msg.body.payload)) as Record<string, unknown>;

  await host.handleJob({
    jobId: msg.body.jobId,
    workflowRunId: msg.body.workflowRunId,
    workflowId: msg.body.workflowId,
    stageId: msg.body.stageId,
    attempt: msg.body.attempt,
    maxAttempts: msg.body.maxAttempts,
    payload: resolvedPayload,
  });
}
```

If the payload was not spilled, `spill.unpack` returns the payload object as-is without contacting the blob store.
