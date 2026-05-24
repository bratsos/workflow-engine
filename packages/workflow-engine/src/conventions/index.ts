/**
 * @bratsos/workflow-engine/conventions
 *
 * Well-known annotation keys for common provenance scenarios — trigger
 * context, decisions, approvals, revisions. Inspired by OpenTelemetry
 * semantic conventions: dot-namespaced flat keys, value type linked to
 * the key via TypeScript phantom-type inference.
 *
 * ## Usage
 *
 * ```ts
 * import { Trigger, Decision } from "@bratsos/workflow-engine/conventions";
 *
 * // Type-checked: value must match the TypedKey<T> parameter.
 * ctx.annotate(Decision.outcome, "low");
 * ctx.annotate(Decision.confidence, 0.42);
 * ctx.annotate(Decision.confidence, "high"); // ❌ TS error
 *
 * // Custom org-defined keys keep working with the string form:
 * ctx.annotate("acme.compliance.signoff", "alice@acme.com");
 * ```
 *
 * ## Versioning policy
 *
 * - Keys are **immutable once `stable`**. Additions only.
 * - Renames and value-type changes ship as **new keys**; the old key
 *   gets a `@deprecated` JSDoc tag.
 * - We deliberately do **not** copy OpenTelemetry's
 *   `OTEL_SEMCONV_STABILITY_OPT_IN` env-var dance — versioning is
 *   handled through semver and JSDoc.
 *
 * See `src/conventions/README.md` for the full policy.
 */

import type { Stability, TypedKey } from "../core/stage";

export type { Stability, TypedKey } from "../core/stage";

/**
 * Define a well-known annotation key. The value-type parameter `T` is
 * phantom — never set at runtime, used only for TypeScript inference
 * when the key is passed to `ctx.annotate(key, value)`.
 */
export function typedKey<T = unknown>(
  key: string,
  meta?: { stability?: Stability; description?: string },
): TypedKey<T> {
  return {
    key,
    stability: meta?.stability ?? "experimental",
    description: meta?.description,
  };
}

// ============================================================================
// Trigger — what initiated the run
// ============================================================================

/**
 * Trigger conventions describe how a workflow run was initiated:
 * caller identity, source system, parent run, free-text reason.
 *
 * Attach at `run.create` time via the `annotations` parameter.
 */
export const Trigger = {
  /** What system or path initiated the run, e.g. `"webhook:zendesk"`, `"manual:cli"`, `"schedule:cron"`. */
  source: typedKey<string>("trigger.source", {
    stability: "stable",
    description: "What system or path initiated this run.",
  }),

  /** Run ID of the prior run when this run is a follow-up / retry / chained execution. */
  parentRunId: typedKey<string>("trigger.parent_run_id", {
    stability: "stable",
    description: "Run ID of the prior run when this is a follow-up.",
  }),

  /** Free-text reason — `"auto-triage on ticket create"`, `"manual rerun after policy change"`, etc. */
  reason: typedKey<string>("trigger.reason", {
    stability: "stable",
    description: "Free-text rationale for triggering this run.",
  }),

  /** Actor kind discriminator — recommended values: `"user"`, `"agent"`, `"system"`. Open string. */
  actorKind: typedKey<string>("trigger.actor.kind", {
    stability: "stable",
    description:
      "Open string. Recommended: 'user' | 'agent' | 'system'. Use the envelope `actor.kind` for the equivalent on stage-scope annotations.",
  }),

  /** Stable identifier for the actor — user email, agent name, service identifier. */
  actorId: typedKey<string>("trigger.actor.id", {
    stability: "stable",
    description: "Stable identifier for the triggering actor.",
  }),
} as const;

// ============================================================================
// Decision — choices made during execution
// ============================================================================

/**
 * Decision conventions describe choices an agent or stage made
 * during execution: the chosen outcome, the reasoning, evidence,
 * alternatives that were considered.
 *
 * Attach from inside `ctx.annotate(...)` within a stage's `execute()`.
 */
export const Decision = {
  /** The chosen outcome. Shape is consumer-defined; `unknown` here for flexibility. */
  outcome: typedKey<unknown>("decision.outcome", {
    stability: "stable",
    description:
      "The chosen outcome of this decision. Shape is consumer-defined.",
  }),

  /** Free-text rationale — why the agent picked this outcome. */
  rationale: typedKey<string>("decision.rationale", {
    stability: "stable",
    description: "Human-readable reason for the decision.",
  }),

  /** Confidence score, typically `0`–`1`. */
  confidence: typedKey<number>("decision.confidence", {
    stability: "stable",
    description: "Confidence score for the decision, typically 0–1.",
  }),

  /** Alternative outcomes that were considered but not selected. */
  alternatives: typedKey<unknown[]>("decision.alternatives", {
    stability: "stable",
    description: "Alternative outcomes considered but not selected.",
  }),

  /** Whether a fallback heuristic was used (e.g., AI confidence below threshold). */
  usedFallback: typedKey<boolean>("decision.used_fallback", {
    stability: "experimental",
    description:
      "Whether the agent fell back to a heuristic after the primary signal was inconclusive.",
  }),
} as const;

// ============================================================================
// Approval — sign-off events
// ============================================================================

/**
 * Approval conventions describe sign-off events on runs or stages.
 * Pluralization follows the OTel rule: `approvers` is plural because a
 * single approval can have multiple approvers; the value type is
 * always `string[]`, even with one approver.
 */
export const Approval = {
  /** Identifiers of all approvers. Always an array — `["alice"]` for a single approver. */
  approvers: typedKey<string[]>("approval.approvers", {
    stability: "stable",
    description: "Identifiers of all approvers (always an array, plural-rule).",
  }),

  /** When the approval was recorded. ISO 8601. */
  timestamp: typedKey<string>("approval.timestamp", {
    stability: "stable",
    description: "ISO 8601 timestamp when approval was recorded.",
  }),

  /** Version of the policy the approval was checked against. */
  policyVersion: typedKey<string>("approval.policy.version", {
    stability: "experimental",
    description: "Version of the policy the approval was checked against.",
  }),
} as const;

// ============================================================================
// Revision — chained/related runs
// ============================================================================

/**
 * Revision conventions describe a run as a revision of a prior run:
 * a deliberate redo, a corrected attempt, a manual override.
 *
 * Distinct from `Trigger.parentRunId` — that's any causal parent
 * (including independent follow-ups), revision is specifically
 * "this run supersedes that one."
 */
export const Revision = {
  /** Run ID this revision supersedes. */
  previousRunId: typedKey<string>("revision.previous_run_id", {
    stability: "stable",
    description: "Run ID this revision explicitly supersedes.",
  }),

  /** Why this revision was created. */
  reason: typedKey<string>("revision.reason", {
    stability: "stable",
    description: "Why this revision was created.",
  }),
} as const;
