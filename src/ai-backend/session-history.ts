import crypto from "node:crypto";
import path from "node:path";
import type {
  AiSessionChoicesConfig,
  AiSessionDescriptor,
  AiTranscriptEntry,
  AiWorkingDirectoryCandidate,
} from "../ai-protocol/index.js";
import type { AdapterResumeTarget, AdapterSessionHistoryRecord } from "../adapter/types.js";
import { allAdapterSpecs } from "../adapter/spec.js";

export const DEFAULT_SESSION_HISTORY_LIMIT = 100;
const MAX_RESUME_CACHE_ENTRIES = DEFAULT_SESSION_HISTORY_LIMIT * 5;

export type ResumeTarget =
  | { provider: "codex"; threadId: string; transcriptPath: string }
  | { provider: "claude"; sessionId: string; transcriptPath: string };

export type ResolvedResumeSession = {
  descriptor: AiSessionDescriptor;
  target: ResumeTarget;
  transcript: AiTranscriptEntry[];
};

type ResumeEntry = {
  descriptor: AiSessionDescriptor;
  target: ResumeTarget;
  transcript: AiTranscriptEntry[];
};

export class AiSessionHistoryService {
  readonly #secret = crypto.randomBytes(32).toString("hex");
  readonly #resume = new Map<string, ResumeEntry>();

  async listChoices(config: AiSessionChoicesConfig): Promise<{
    sessions: AiSessionDescriptor[];
    workingDirectories: AiWorkingDirectoryCandidate[];
  }> {
    if (config.sdkRuntimeHome !== "managedAstral") {
      return { sessions: [], workingDirectories: [] };
    }
    const maxResults = Math.min(config.maxResults ?? DEFAULT_SESSION_HISTORY_LIMIT, DEFAULT_SESSION_HISTORY_LIMIT);
    const records: AdapterSessionHistoryRecord[] = [];
    for (const spec of allAdapterSpecs()) {
      if (!spec.sessionHistory) continue;
      const adapterRecords = await spec.sessionHistory.listManagedSessions({ maxResults });
      records.push(...adapterRecords);
    }

    records.sort(compareHistoryRecords);
    const selected: AdapterSessionHistoryRecord[] = [];
    const sessions: AiSessionDescriptor[] = [];
    for (const record of records) {
      const descriptor = this.descriptorFor(record);
      if (!descriptor) continue;
      sessions.push(descriptor);
      selected.push(record);
      if (sessions.length >= maxResults) break;
    }
    const workingDirectories = summarizeWorkingDirectories(selected);
    return { sessions, workingDirectories };
  }

  resolve(resumeId: string): ResolvedResumeSession | null {
    const entry = this.#resume.get(resumeId);
    return entry
      ? {
          descriptor: structuredClone(entry.descriptor),
          target: structuredClone(entry.target),
          transcript: structuredClone(entry.transcript),
        }
      : null;
  }

  private descriptorFor(record: AdapterSessionHistoryRecord): AiSessionDescriptor | null {
    const target = normalizeResumeTarget(record.resumeTarget);
    if (!target) return null;
    const resumeId = this.resumeIdFor(record);
    const descriptor = {
      resumeId,
      summary: record.summary,
      workingDir: path.resolve(record.workingDir),
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    };
    this.#resume.delete(resumeId);
    this.#resume.set(resumeId, {
      descriptor,
      target,
      transcript: hydrateTranscript(record),
    });
    this.pruneResumeCache();
    return descriptor;
  }

  private resumeIdFor(record: AdapterSessionHistoryRecord): string {
    return crypto
      .createHmac("sha256", this.#secret)
      .update(record.targetKey)
      .digest("base64url");
  }

  private pruneResumeCache(): void {
    while (this.#resume.size > MAX_RESUME_CACHE_ENTRIES) {
      const oldest = this.#resume.keys().next().value;
      if (!oldest) return;
      this.#resume.delete(oldest);
    }
  }
}

function normalizeResumeTarget(target: AdapterResumeTarget): ResumeTarget | null {
  if (target.provider === "codex") {
    const { threadId, transcriptPath } = target.target;
    return threadId && transcriptPath ? { provider: "codex", threadId, transcriptPath } : null;
  }
  if (target.provider === "claude") {
    const { sessionId, transcriptPath } = target.target;
    return sessionId && transcriptPath ? { provider: "claude", sessionId, transcriptPath } : null;
  }
  return null;
}

export const sessionHistoryService = new AiSessionHistoryService();

function summarizeWorkingDirectories(records: readonly AdapterSessionHistoryRecord[]): AiWorkingDirectoryCandidate[] {
  const counts = new Map<string, { path: string; sessionCount: number; lastUsedAt?: string }>();
  for (const record of records) {
    const canonical = path.resolve(record.workingDir);
    const existing = counts.get(canonical) ?? { path: canonical, sessionCount: 0 };
    existing.sessionCount += 1;
    if (!existing.lastUsedAt || (record.updatedAt ?? "") > existing.lastUsedAt) {
      existing.lastUsedAt = record.updatedAt;
    }
    counts.set(canonical, existing);
  }
  return [...counts.values()]
    .sort((a, b) => {
      const time = (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "");
      return time || b.sessionCount - a.sessionCount || a.path.localeCompare(b.path);
    })
    .map((entry) => ({
      path: entry.path,
      sessionCount: entry.sessionCount,
      ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {}),
    }));
}

function hydrateTranscript(record: AdapterSessionHistoryRecord): AiTranscriptEntry[] {
  return record.messages.map((message, index) => {
    const createdAt = message.createdAt ?? record.updatedAt ?? new Date(0).toISOString();
    return {
      id: `history-message-${index + 1}`,
      turnId: null,
      role: message.role,
      content: message.text ? [{ type: "text" as const, text: message.text }] : [],
      status: "completed" as const,
      createdAt,
      updatedAt: createdAt,
      completedAt: createdAt,
      usage: null,
    };
  });
}

function compareHistoryRecords(a: AdapterSessionHistoryRecord, b: AdapterSessionHistoryRecord): number {
  const time = (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  return time || path.resolve(a.workingDir).localeCompare(path.resolve(b.workingDir)) || a.summary.localeCompare(b.summary);
}
