import { z } from "zod";

export const ArtifactRefSchema = z.object({
  key: z.string(),
  bytes: z.number().optional(),
  contentType: z.string().optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ArtifactGrantSchema = z.object({
  prefix: z.string(), // broker-chosen per task: remote-activity/{runId}/{stageId}/{taskId}/
  expiresAt: z.string(), // ISO; activity deadline (per-PUT/GET URL TTLs minted on demand)
  presignEndpoint: z.string(),
});
export type ArtifactGrant = z.infer<typeof ArtifactGrantSchema>;

export const ActivityTaskSchema = z.object({
  taskId: z.string(),
  leaseToken: z.string(),
  workflowRunId: z.string(),
  stageId: z.string(),
  stageName: z.string(),
  stageNumber: z.number(),
  attempt: z.number(), // broker re-lease counter
  input: z.unknown(),
  config: z.unknown(),
  resumeState: z.unknown().optional(),
  workflowContext: z.record(z.string(), z.unknown()),
  grant: ArtifactGrantSchema,
  deadline: z.string(),
});
export type ActivityTask = z.infer<typeof ActivityTaskSchema>;

export const BufferedLogSchema = z.object({
  level: z.string(),
  message: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type BufferedLog = z.infer<typeof BufferedLogSchema>;

export const BufferedProgressSchema = z.object({
  progress: z.number(),
  message: z.string().optional(),
  details: z.unknown().optional(),
});
export type BufferedProgress = z.infer<typeof BufferedProgressSchema>;

export const ActivityOutcomeSchema = z.discriminatedUnion("kind", [
  // authoritative artifact refs ride inside `output`; `artifacts` is optional/informational
  z.object({
    kind: z.literal("completed"),
    output: z.unknown(),
    artifacts: z.record(z.string(), ArtifactRefSchema).optional(),
    customMetrics: z.record(z.string(), z.number()).optional(),
  }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
]);
export type ActivityOutcome = z.infer<typeof ActivityOutcomeSchema>;

export const ActivityReportSchema = z.object({
  taskId: z.string(),
  leaseToken: z.string(),
  outcome: ActivityOutcomeSchema,
  logs: z.array(BufferedLogSchema),
  annotations: z.array(z.array(z.unknown())), // raw ctx.annotate(...) arg-tuples
  progress: z.array(BufferedProgressSchema),
});
export type ActivityReport = z.infer<typeof ActivityReportSchema>;

export interface SubmitRequest {
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  input: unknown;
  config: unknown;
  resumeState?: unknown;
  workflowContext: Record<string, unknown>;
  pollInterval: number;
  maxWaitTime: number;
}
export interface SubmitResponse {
  taskId: string;
  pollConfig: { pollInterval: number; maxWaitTime: number; nextPollAt: Date };
}
export interface LeaseRequest {
  workerId: string;
  stageIds: string[];
  stageCodeVersion: string;
}
export interface HeartbeatRequest {
  taskId: string;
  leaseToken: string;
}
export interface HeartbeatResponse {
  ok: boolean;
  cancel: boolean;
}
export interface PresignRequest {
  taskId: string;
  leaseToken: string;
  relKey: string;
  op: "put" | "get";
}
export interface PresignResponse {
  url: string;
}
export type PollState = "pending" | "assigned" | "reported" | "failed";
export interface PollResponse {
  state: PollState;
  outcome?: ActivityOutcome;
  logs: BufferedLog[];
  annotations: unknown[][];
  progress: BufferedProgress[];
  nextCheckIn?: number;
}
