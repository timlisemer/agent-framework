import '../utils/load-env.js';
import type { TelemetryConfig, TelemetryEvent } from './types.js';
import { TelemetryQueue } from './queue.js';
import { sanitizeToolInput } from './sanitizer.js';

let instance: TelemetryClient | null = null;
let currentSessionId: string | undefined;

export class TelemetryClient {
  private config: Required<TelemetryConfig>;
  private queue: TelemetryQueue;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(config: TelemetryConfig) {
    this.config = {
      batchSize: 10,
      flushIntervalMs: 5000,
      maxQueueSize: 1000,
      enableHomeAssistant: true,
      ...config,
    };
    this.queue = new TelemetryQueue(this.config.maxQueueSize);
    this.startFlushTimer();
  }

  static initialize(config: TelemetryConfig): TelemetryClient {
    if (!instance) {
      instance = new TelemetryClient(config);
    }
    return instance;
  }

  static getInstance(): TelemetryClient | null {
    return instance;
  }

  static isInitialized(): boolean {
    return instance !== null;
  }

  async track(
    event: Omit<TelemetryEvent, 'hostId' | 'timestamp'>
  ): Promise<void> {
    const fullEvent: TelemetryEvent = {
      ...event,
      hostId: this.config.hostId,
      timestamp: new Date().toISOString(),
      toolInput: event.toolInput
        ? sanitizeToolInput(event.toolInput)
        : undefined,
    };

    this.queue.enqueue(fullEvent);

    if (this.queue.size() >= this.config.batchSize) {
      await this.flush();
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[Telemetry] Flush error:', err);
      });
    }, this.config.flushIntervalMs);
  }

  async flush(): Promise<void> {
    if (this.queue.isEmpty()) return;

    const events = this.queue.drain(this.config.batchSize);
    if (events.length === 0) return;

    try {
      const response = await fetch(
        `${this.config.endpoint}/api/v1/telemetry/batch`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.config.apiKey,
          },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(5000),
        }
      );

      if (!response.ok) {
        events.forEach((e) => this.queue.enqueue(e));
        console.error(`[Telemetry] Flush failed: ${response.status}`);
      }
    } catch (error) {
      events.forEach((e) => this.queue.enqueue(e));
      if (error instanceof Error && error.name !== 'TimeoutError') {
        console.error(`[Telemetry] Network error: ${error.message}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  getConfig(): Required<TelemetryConfig> {
    return this.config;
  }
}

export function setSessionId(sessionId: string): void {
  currentSessionId = sessionId;
}

export function getSessionId(): string {
  return currentSessionId || `process-${process.pid}-${Date.now()}`;
}

export function trackEvent(
  event: Omit<TelemetryEvent, 'hostId' | 'timestamp'>
): void {
  const client = TelemetryClient.getInstance();
  if (client) {
    client
      .track({
        ...event,
        sessionId: event.sessionId || getSessionId(),
      })
      .catch(() => {});
  }
}

export function initializeTelemetry(): TelemetryClient | null {
  const hostId = process.env.TELEMETRY_HOST_ID;
  const endpoint = process.env.TELEMETRY_ENDPOINT;
  const apiKey = process.env.AGENT_FRAMEWORK_API_KEY;

  if (!hostId || !endpoint || !apiKey) {
    console.error(
      '[Telemetry] Missing required env vars: TELEMETRY_HOST_ID, TELEMETRY_ENDPOINT, AGENT_FRAMEWORK_API_KEY'
    );
    return null;
  }

  return TelemetryClient.initialize({
    hostId,
    endpoint,
    apiKey,
    enableHomeAssistant: process.env.WEBHOOK_ID_AGENT_LOGS !== undefined,
  });
}
