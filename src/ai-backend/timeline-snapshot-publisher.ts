import type { AiRuntimeEvent } from "./runtime-events.js";
import { createLiveTranscriptWatcher, type LiveTranscriptWatcher } from "./live-transcript-watcher.js";
import type { TranscriptProjection } from "./transcript-runtime.js";
import { resolveTranscriptProjectionSessionDir } from "./transcript-session-dir.js";

export type TimelineSnapshotPublisher = {
  publishPolled(): void;
  publishSnapshot(): void;
  startPolling(): void;
  stopPolling(): void;
};

type RuntimeEventSink = {
  push(event: AiRuntimeEvent): void;
  fail(error: unknown): void;
};

export function emptyTranscriptProjection(): TranscriptProjection {
  return {
    transcript: [],
    toolCalls: [],
    providerPatch: {},
    digest: "empty",
    agentFrameworkSessionDir: null,
  };
}

export function timelineSnapshotEvent(
  projection: TranscriptProjection,
  nativeSessionId: string | null
): AiRuntimeEvent {
  return {
    type: "timeline.snapshot",
    transcript: projection.transcript,
    toolCalls: projection.toolCalls,
    agentFrameworkSessionDir: projection.agentFrameworkSessionDir,
    provider: {
      ...projection.providerPatch,
      nativeSessionId,
    },
  };
}

export function createTimelineSnapshotPublisher(input: {
  adapterName: string;
  workingDir?: string | null;
  queue: RuntimeEventSink;
  nativeSessionId(): string | null;
  resolveTranscriptPath(): string | null;
  signal?: AbortSignal;
  transformProjection?: (projection: TranscriptProjection) => TranscriptProjection;
  fallbackProjection?: () => TranscriptProjection;
}): TimelineSnapshotPublisher {
  let watcher: LiveTranscriptWatcher | null = null;
  let lastProjection: TranscriptProjection | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let abortListener: (() => void) | null = null;

  const ensureWatcher = (): LiveTranscriptWatcher | null => {
    if (watcher) return watcher;
    const transcriptPath = input.resolveTranscriptPath();
    if (!transcriptPath) return null;
    watcher = createLiveTranscriptWatcher({
      adapterName: input.adapterName,
      transcriptPath,
      workingDir: input.workingDir,
      sessionDir: resolveTranscriptProjectionSessionDir({
        transcriptPath,
        workingDir: input.workingDir,
        create: true,
      }),
    });
    return watcher;
  };

  const publish = (projection: TranscriptProjection | null): void => {
    if (!projection) return;
    lastProjection = projection;
    input.queue.push(timelineSnapshotEvent(
      input.transformProjection?.(projection) ?? projection,
      input.nativeSessionId()
    ));
  };

  const publishPolled = (): void => {
    publish(ensureWatcher()?.poll() ?? null);
  };

  const stopPolling = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (abortListener) {
      input.signal?.removeEventListener("abort", abortListener);
      abortListener = null;
    }
  };

  return {
    publishPolled,
    publishSnapshot(): void {
      publish(ensureWatcher()?.snapshot() ?? lastProjection ?? input.fallbackProjection?.() ?? null);
    },
    startPolling(): void {
      if (pollTimer || input.signal?.aborted) return;
      pollTimer = setInterval(() => {
        try {
          publishPolled();
        } catch (error) {
          input.queue.fail(error);
        }
      }, 100);
      pollTimer.unref?.();
      if (input.signal && !abortListener) {
        abortListener = () => stopPolling();
        input.signal.addEventListener("abort", abortListener, { once: true });
      }
    },
    stopPolling,
  };
}
