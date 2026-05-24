/**
 * AnnotationBuffer
 *
 * Small flushable list used to collect `ctx.annotate(...)` calls made
 * during a stage's `execute()` or `checkCompletion()`. The kernel
 * handler flushes the buffer inside the stage-completion transaction
 * so annotations persist atomically with the stage outcome.
 *
 * This is what makes annotations durable rather than fire-and-forget:
 * - On stage success → flush inside the success transaction
 * - On stage failure → flush inside the failure transaction (so
 *   annotations recorded before a thrown error still persist)
 * - On Phase-2 stale-version rollback in stage-poll-suspended →
 *   buffer is discarded together with the rolled-back stage update,
 *   preventing the "phantom annotation" race
 */

import type { AnnotateOpts } from "../../core/stage";
import type { CreateAnnotationInput } from "../../persistence/interface";

/**
 * Normalize the three `ctx.annotate(...)` call forms into a flat list of
 * `{ key, value, opts }` records. Handlers wire these into the
 * AnnotationBuffer with their own stage-scope fields.
 *
 * Forms:
 *   - typedKey: `(key: TypedKey<T>, value: T, opts?)` — object with a
 *     string `key` property and no `attributes` field
 *   - string:   `(key: string, value: unknown, opts?)`
 *   - batch:    `(args: { attributes, actor?, payload?, idempotencyKey? })`
 */
export function normalizeAnnotateArgs(
  args: unknown[],
): Array<{ key: string; value: unknown; opts: AnnotateOpts | undefined }> {
  const first = args[0];

  if (typeof first === "string") {
    return [
      { key: first, value: args[1], opts: args[2] as AnnotateOpts | undefined },
    ];
  }

  if (
    first !== null &&
    typeof first === "object" &&
    "key" in first &&
    typeof (first as { key: unknown }).key === "string" &&
    !("attributes" in first)
  ) {
    // TypedKey form
    return [
      {
        key: (first as { key: string }).key,
        value: args[1],
        opts: args[2] as AnnotateOpts | undefined,
      },
    ];
  }

  // Batch form
  const batch = first as {
    attributes?: Record<string, unknown>;
    actor?: AnnotateOpts["actor"];
    payload?: AnnotateOpts["payload"];
    idempotencyKey?: AnnotateOpts["idempotencyKey"];
    emitEvent?: AnnotateOpts["emitEvent"];
  };
  const attributes = batch?.attributes ?? {};
  const opts: AnnotateOpts = {
    actor: batch.actor,
    payload: batch.payload,
    idempotencyKey: batch.idempotencyKey,
    emitEvent: batch.emitEvent,
  };
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value,
    opts,
  }));
}

export class AnnotationBuffer {
  private items: CreateAnnotationInput[] = [];

  push(input: CreateAnnotationInput): void {
    this.items.push(input);
  }

  /**
   * Return all buffered items and clear the buffer. Idempotent — calling
   * flush again returns an empty array.
   */
  flush(): CreateAnnotationInput[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  size(): number {
    return this.items.length;
  }
}

export function createAnnotationBuffer(): AnnotationBuffer {
  return new AnnotationBuffer();
}
