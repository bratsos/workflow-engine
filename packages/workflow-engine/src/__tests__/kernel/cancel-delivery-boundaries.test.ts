import { describe } from "vitest";
import { createKernel } from "../../kernel/kernel.js";
import { createTestKernel, InMemoryStepLedger } from "../../testing/index.js";
import { cancelDeliveryScenarios } from "../utils/cancel-delivery-scenarios.js";

describe("kernel: a run.cancel sweep and the stage's job deliveries", () => {
  cancelDeliveryScenarios(async (clock) => {
    const ledger = new InMemoryStepLedger({ now: () => clock.now() });
    const test = createTestKernel([], { clock, stepLedger: ledger });
    return {
      persistence: test.persistence,
      jobTransport: test.jobTransport,
      ledger,
      blobStore: test.blobStore,
      concurrentTransactions: true,
      makeKernel: (config) =>
        createKernel({
          persistence: test.persistence,
          blobStore: test.blobStore,
          jobTransport: test.jobTransport,
          eventSink: test.eventSink,
          clock,
          registry: { getWorkflow: () => undefined },
          stepLedger: ledger,
          ...config,
        }),
    };
  });
});
