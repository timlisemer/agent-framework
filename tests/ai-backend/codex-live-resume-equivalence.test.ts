import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLiveTranscriptWatcher } from "../../src/ai-backend/live-transcript-watcher.js";
import { projectTranscriptFile } from "../../src/ai-backend/transcript-runtime.js";
import { runCodexTranscriptTurn } from "../../src/ai-backend/provider.js";
import { createTimelineSnapshotPublisher } from "../../src/ai-backend/timeline-snapshot-publisher.js";
import { writeJsonl } from "../../src/utils/file-io.js";

describe("Codex live/resume transcript equivalence", () => {
  it("unrefs and stops transcript polling when the turn aborts", () => {
    const abortController = new AbortController();
    const interval = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
      .mockImplementation((() => interval) as unknown as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval")
      .mockImplementation((() => undefined) as unknown as typeof clearInterval);
    try {
      const publisher = createTimelineSnapshotPublisher({
        adapterName: "codex",
        queue: { push: vi.fn(), fail: vi.fn() },
        nativeSessionId: () => "thread-cleanup",
        resolveTranscriptPath: () => null,
        signal: abortController.signal,
      });

      publisher.startPolling();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(interval.unref).toHaveBeenCalledTimes(1);

      abortController.abort();
      expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("binds a live Codex SDK thread to its transcript and emits a snapshot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-codex-live-binding-"));
    try {
      const projectDir = path.join(dir, "project");
      const runtimeHomeRoot = path.join(dir, "codex-home");
      const transcriptPath = path.join(runtimeHomeRoot, "sessions", "2026", "06", "26", "rollout-live.jsonl");
      const liveSession = {
        runtimeHome: { root: runtimeHomeRoot },
        thread: {
          id: "thread-live-binding",
          runStreamed: async () => {
            writeJsonl(transcriptPath, [
              {
                type: "session_meta",
                timestamp: "2026-06-20T10:00:00.000Z",
                payload: { cwd: projectDir, id: "thread-live-binding" },
              },
              {
                timestamp: "2026-06-20T10:01:00.000Z",
                payload: { role: "user", text: "Show status" },
              },
              {
                type: "event_msg",
                timestamp: "2026-06-20T10:02:00.000Z",
                payload: { type: "agent_message", message: "Status is clean." },
              },
            ]);
            return {
              events: (async function* () {
                yield { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } };
              })(),
            };
          },
        },
      };
      const events: unknown[] = [];
      for await (const event of runCodexTranscriptTurn({
        liveSession,
        config: {
          model: null,
          workingDir: projectDir,
          systemPrompt: null,
          continuable: false,
          sdkRuntimeEnvironment: "isolated",
        },
        prompt: "Show status",
        signal: new AbortController().signal,
        resumeTranscriptPath: null,
      })) {
        events.push(event);
      }

      const snapshot = events.find((event): event is {
        type: "timeline.snapshot";
        transcript: Array<{ content: Array<{ type: string; text?: string }> }>;
        provider?: { nativeSessionId?: string | null };
      } => typeof event === "object" && event !== null && (event as { type?: unknown }).type === "timeline.snapshot");
      expect(snapshot?.provider?.nativeSessionId).toBe("thread-live-binding");
      expect(snapshot?.transcript.map((entry) => entry.content[0]?.text)).toEqual([
        "Show status",
        "Status is clean.",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("projects the same public rows from a bound live watcher and resume projection", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-live-resume-"));
    try {
      const transcriptPath = path.join(dir, "codex-session.jsonl");
      writeJsonl(transcriptPath, [
        {
          type: "session_meta",
          timestamp: "2026-06-20T10:00:00.000Z",
          payload: { cwd: dir, id: "thread-equivalent" },
        },
        {
          timestamp: "2026-06-20T10:01:00.000Z",
          payload: { role: "user", text: "Show status" },
        },
        {
          type: "event_msg",
          timestamp: "2026-06-20T10:02:00.000Z",
          payload: { type: "agent_message", message: "Status is clean." },
        },
        {
          type: "response_item",
          timestamp: "2026-06-20T10:02:00.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Status is clean." }],
          },
        },
      ]);

      const watcher = createLiveTranscriptWatcher({
        adapterName: "codex",
        transcriptPath,
        workingDir: dir,
        sessionDir: null,
      });
      const live = watcher.poll();
      const resume = projectTranscriptFile({
        adapterName: "codex",
        transcriptPath,
        workingDir: dir,
        sessionDir: null,
      });

      expect(live?.transcript).toEqual(resume.transcript);
      expect(live?.toolCalls).toEqual(resume.toolCalls);
      expect(resume.transcript.map((entry) => entry.content[0]?.type === "text" ? entry.content[0].text : "")).toEqual([
        "Show status",
        "Status is clean.",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
