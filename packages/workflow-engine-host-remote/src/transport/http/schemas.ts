/**
 * Zod schemas used for validating HTTP request bodies on the broker server.
 * Re-exports ActivityReportSchema from protocol; adds LeaseRequestSchema.
 */
import { z } from "zod";

export { ActivityReportSchema } from "../../protocol.js";

export const LeaseRequestSchema = z.object({
  workerId: z.string(),
  stageIds: z.array(z.string()),
  stageCodeVersion: z.string(),
});
