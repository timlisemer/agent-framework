import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSessionHistoryService } from "../../src/ai-backend/session-history.js";
import { writeJsonl } from "../../src/utils/file-io.js";
import { writeManagedCodexTranscript } from "../helpers/managed-session-fixtures.js";
import { withEnvForTest } from "../helpers/provider-env.js";

describe("AI session history service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no native history for native runtime homes", async () => {
    const service = new AiSessionHistoryService();
    await expect(service.listChoices({ sdkRuntimeHome: "native" }))
      .resolves.toEqual({ sessions: [], workingDirectories: [] });
  });

  it("treats stale opaque resume ids as not found", () => {
    const service = new AiSessionHistoryService();
    expect(service.resolve("stale-resume-id")).toBeNull();
  });

  it("lists and hydrates managed Claude and Codex session history", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-history-test-"));
    const restoreEnv = withEnvForTest({ HOME: home });
    try {
      const projectDir = path.join(home, "project");
      fs.mkdirSync(projectDir, { recursive: true });
      const managedRoot = path.join(home, ".agent-framework", "astral-ai");
      const claudeTranscript = path.join(managedRoot, "claude", "projects", "project", "claude-session.jsonl");
      const codexTranscript = path.join(managedRoot, "codex", "sessions", "2026", "codex-session.jsonl");
      writeJsonl(claudeTranscript, [
        {
          type: "user",
          sessionId: "claude-native-session",
          cwd: projectDir,
          timestamp: "2026-06-20T10:00:00.000Z",
          message: { content: "Review the plan\nwith details" },
        },
        {
          type: "assistant",
          sessionId: "claude-native-session",
          timestamp: "2026-06-20T10:01:00.000Z",
          message: { content: [{ type: "text", text: "Plan reviewed." }] },
        },
      ]);
      writeManagedCodexTranscript({
        filePath: codexTranscript,
        projectDir,
        threadId: "codex-thread",
        userText: "Continue implementation",
        assistantText: "Done.",
        userTimestamp: "2026-06-20T10:02:00.000Z",
        assistantTimestamp: "2026-06-20T10:03:00.000Z",
        largeMiddleBytes: 300 * 1024,
      });

      const service = new AiSessionHistoryService();
      const choices = await service.listChoices({ sdkRuntimeHome: "managedAstral", maxResults: 10 });

      expect(choices.sessions).toHaveLength(2);
      expect(choices.workingDirectories).toEqual([{
        path: projectDir,
        sessionCount: 2,
        lastUsedAt: "2026-06-20T10:03:00.000Z",
      }]);
      const summaries = choices.sessions.map((session) => session.summary).sort();
      expect(summaries).toEqual(["Continue implementation", "Review the plan"]);
      const codex = choices.sessions.find((session) => session.summary === "Continue implementation");
      if (!codex) throw new Error("expected Codex session choice");
      const resolved = service.resolve(codex.resumeId);
      expect(resolved?.target).toEqual({
        provider: "codex",
        threadId: "codex-thread",
        transcriptPath: codexTranscript,
      });
      expect(resolved?.transcript.map((entry) => ({
        role: entry.role,
        text: entry.content[0]?.type === "text" ? entry.content[0].text : "",
      }))).toEqual([
        { role: "user", text: "Continue implementation" },
        { role: "assistant", text: "Done." },
      ]);
    } finally {
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("selects newest managed transcripts before applying the result limit", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-history-limit-test-"));
    const restoreEnv = withEnvForTest({ HOME: home });
    try {
      const projectDir = path.join(home, "project");
      const sessionsRoot = path.join(home, ".agent-framework", "astral-ai", "codex", "sessions");
      for (let index = 0; index < 500; index += 1) {
        const filePath = path.join(sessionsRoot, `${String(index).padStart(3, "0")}.jsonl`);
        writeJsonl(filePath, [{
          timestamp: "2026-06-19T10:00:00.000Z",
          payload: { cwd: projectDir, thread_id: `old-${index}`, role: "user", text: `Old ${index}` },
        }]);
        fs.utimesSync(filePath, new Date("2026-06-19T10:00:00.000Z"), new Date("2026-06-19T10:00:00.000Z"));
      }
      const newest = path.join(sessionsRoot, "zzz-newest.jsonl");
      writeJsonl(newest, [{
        timestamp: "2026-06-20T10:00:00.000Z",
        payload: { cwd: projectDir, thread_id: "newest", role: "user", text: "Newest session" },
      }]);
      fs.utimesSync(newest, new Date("2026-06-20T10:00:00.000Z"), new Date("2026-06-20T10:00:00.000Z"));

      const service = new AiSessionHistoryService();
      const choices = await service.listChoices({ sdkRuntimeHome: "managedAstral", maxResults: 1 });

      expect(choices.sessions).toHaveLength(1);
      expect(choices.sessions[0].summary).toBe("Newest session");
    } finally {
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("continues past newer invalid transcripts until enough valid sessions are returned", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-history-invalid-test-"));
    const restoreEnv = withEnvForTest({ HOME: home });
    try {
      const projectDir = path.join(home, "project");
      const sessionsRoot = path.join(home, ".agent-framework", "astral-ai", "codex", "sessions");
      const invalid = path.join(sessionsRoot, "newer-invalid.jsonl");
      writeJsonl(invalid, [{
        timestamp: "2026-06-20T11:00:00.000Z",
        payload: { role: "user", text: "Missing cwd" },
      }]);
      fs.utimesSync(invalid, new Date("2026-06-20T11:00:00.000Z"), new Date("2026-06-20T11:00:00.000Z"));
      const valid = path.join(sessionsRoot, "older-valid.jsonl");
      writeManagedCodexTranscript({
        filePath: valid,
        projectDir,
        threadId: "older-valid",
        userText: "Older valid session",
        userTimestamp: "2026-06-20T10:00:00.000Z",
        assistantTimestamp: "2026-06-20T10:01:00.000Z",
      });
      fs.utimesSync(valid, new Date("2026-06-20T10:01:00.000Z"), new Date("2026-06-20T10:01:00.000Z"));

      const service = new AiSessionHistoryService();
      const choices = await service.listChoices({ sdkRuntimeHome: "managedAstral", maxResults: 1 });

      expect(choices.sessions).toHaveLength(1);
      expect(choices.sessions[0].summary).toBe("Older valid session");
    } finally {
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("hydrates managed Codex event_msg agent messages as assistant text", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-history-event-msg-test-"));
    const restoreEnv = withEnvForTest({ HOME: home });
    try {
      const projectDir = path.join(home, "project");
      fs.mkdirSync(projectDir, { recursive: true });
      const transcript = path.join(home, ".agent-framework", "astral-ai", "codex", "sessions", "event-msg.jsonl");
      writeJsonl(transcript, [
        {
          type: "session_meta",
          timestamp: "2026-06-20T10:00:00.000Z",
          payload: { cwd: projectDir, id: "event-thread" },
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

      const service = new AiSessionHistoryService();
      const choices = await service.listChoices({ sdkRuntimeHome: "managedAstral", maxResults: 10 });
      expect(choices.sessions).toHaveLength(1);
      const resolved = service.resolve(choices.sessions[0].resumeId);

      expect(resolved?.target).toEqual({
        provider: "codex",
        threadId: "event-thread",
        transcriptPath: transcript,
      });
      expect(resolved?.transcript.map((entry) => ({
        role: entry.role,
        text: entry.content[0]?.type === "text" ? entry.content[0].text : "",
      }))).toEqual([
        { role: "user", text: "Show status" },
        { role: "assistant", text: "Status is clean." },
      ]);
    } finally {
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("hydrates managed Codex response_item messages with string payload content", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-history-response-item-test-"));
    const restoreEnv = withEnvForTest({ HOME: home });
    try {
      const projectDir = path.join(home, "project");
      fs.mkdirSync(projectDir, { recursive: true });
      const transcript = path.join(home, ".agent-framework", "astral-ai", "codex", "sessions", "response-item.jsonl");
      writeJsonl(transcript, [
        {
          type: "session_meta",
          timestamp: "2026-06-20T10:00:00.000Z",
          payload: { cwd: projectDir, id: "response-item-thread" },
        },
        {
          type: "response_item",
          timestamp: "2026-06-20T10:01:00.000Z",
          payload: { type: "message", role: "user", content: "Inspect this file" },
        },
        {
          type: "response_item",
          timestamp: "2026-06-20T10:02:00.000Z",
          payload: { type: "message", role: "assistant", content: "Inspection complete." },
        },
      ]);

      const service = new AiSessionHistoryService();
      const choices = await service.listChoices({ sdkRuntimeHome: "managedAstral", maxResults: 10 });
      expect(choices.sessions).toHaveLength(1);
      expect(choices.sessions[0].summary).toBe("Inspect this file");
      const resolved = service.resolve(choices.sessions[0].resumeId);

      expect(resolved?.transcript.map((entry) => ({
        role: entry.role,
        text: entry.content[0]?.type === "text" ? entry.content[0].text : "",
      }))).toEqual([
        { role: "user", text: "Inspect this file" },
        { role: "assistant", text: "Inspection complete." },
      ]);
    } finally {
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
