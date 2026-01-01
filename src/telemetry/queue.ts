import type { TelemetryEvent } from "./types.js";

export class TelemetryQueue {
  private items: TelemetryEvent[] = [];
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  enqueue(item: TelemetryEvent): void {
    if (this.items.length >= this.maxSize) {
      this.items.shift();
    }
    this.items.push(item);
  }

  drain(count: number): TelemetryEvent[] {
    return this.items.splice(0, count);
  }

  size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }
}
