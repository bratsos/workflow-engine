import type { Clock } from "../ports";

export class FakeClock implements Clock {
  private currentTime: Date;

  constructor(initialTime?: Date) {
    this.currentTime = initialTime ?? new Date("2025-01-01T00:00:00Z");
  }

  now(): Date {
    return new Date(this.currentTime.getTime());
  }

  advance(ms: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + ms);
  }

  set(time: Date): void {
    this.currentTime = new Date(time.getTime());
  }
}
