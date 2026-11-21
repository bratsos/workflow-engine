/**
 * Child process for outbox-flush.test.ts: one `outbox.flush` over the
 * in-memory store with one port method replaced. Prints `timer` when a 20 ms
 * timer fires and `RESOLVED`/`REJECTED` when dispatch settles. A flush that
 * blocks the event loop prints neither and is killed by the parent.
 *
 * Usage: outbox-flush-port-child.ts <method> <throw|reject|value|hang>
 */
import { createKernel } from "../../kernel/kernel.js";
import { InMemoryBlobStore } from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

const [method, behaviour] = process.argv.slice(2) as [string, string];
const persistence = new InMemoryWorkflowPersistence() as any;
await persistence.appendOutboxEvents([
  {
    workflowRunId: "run",
    eventType: "probe",
    payload: { type: "probe" },
    causationId: "child",
    occurredAt: new Date(),
  },
]);
const original = persistence[method]?.bind(persistence);
// The single-event method runs only when the batch method is absent.
if (method === "completeOutboxDelivery")
  persistence.completeOutboxDeliveries = undefined;
const replace =
  (plain: () => unknown) =>
  (...args: unknown[]) => {
    if (behaviour === "throw") throw new Error("storage closed");
    if (behaviour === "reject")
      return Promise.reject(new Error("storage closed"));
    if (behaviour === "hang") return new Promise(() => {});
    void args;
    return plain();
  };
const plainValues: Record<string, () => unknown> = {
  claimOutboxDelivery: () => [],
  completeOutboxDeliveries: () => 1,
  completeOutboxDelivery: () => true,
  failOutboxDelivery: () => "retry",
};
persistence[method] = replace(plainValues[method]!);
void original;

const kernel = createKernel({
  persistence,
  jobTransport: new InMemoryJobQueue(),
  blobStore: new InMemoryBlobStore(),
  clock: { now: () => new Date() },
  registry: { getWorkflow: () => undefined },
  eventSink: {
    async emit() {
      // failOutboxDelivery runs only after a sink rejection.
      if (method === "failOutboxDelivery") throw new Error("sink rejected");
    },
  },
});
setTimeout(() => console.log("timer"), 20);
kernel.dispatch({ type: "outbox.flush", maxEvents: 1 }).then(
  (result) => console.log(`RESOLVED ${JSON.stringify(result)}`),
  (error: Error) => console.log(`REJECTED ${error.message}`),
);
setTimeout(() => process.exit(0), 300);
