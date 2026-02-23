import type { KernelEvent, KernelEventType } from "../events";
import type { EventSink } from "../ports";

export class CollectingEventSink implements EventSink {
  readonly events: KernelEvent[] = [];

  async emit(event: KernelEvent): Promise<void> {
    this.events.push(event);
  }

  getByType<T extends KernelEventType>(
    type: T,
  ): Extract<KernelEvent, { type: T }>[] {
    return this.events.filter(
      (e): e is Extract<KernelEvent, { type: T }> => e.type === type,
    );
  }

  clear(): void {
    this.events.length = 0;
  }

  get length(): number {
    return this.events.length;
  }
}
