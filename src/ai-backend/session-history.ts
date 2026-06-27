import crypto from "node:crypto";
import path from "node:path";
import type {
  AiSessionChoicesConfig,
  AiSessionDescriptor,
  AiToolCall,
  AiTranscriptEntry,
  AiWorkingDirectoryCandidate,
} from "../ai-protocol/index.js";
import type { AdapterResumeTarget, AdapterSessionHistoryRecord } from "../adapter/types.js";
import { allAdapterSpecs } from "../adapter/spec.js";
import { projectTranscriptFile } from "./transcript-runtime.js";

export const DEFAULT_SESSION_HISTORY_LIMIT = 100;
const MAX_RESUME_CACHE_ENTRIES = DEFAULT_SESSION_HISTORY_LIMIT * 5;

export type ResumeTarget = {
  provider: string;
  target: Record<string, string>;
  transcriptPath: string;
  nativeSessionId: string | null;
};

export type ResolvedResumeSession = {
  descriptor: AiSessionDescriptor;
  target: ResumeTarget;
  transcript: AiTranscriptEntry[];
  toolCalls: AiToolCall[];
  agentFrameworkSessionDir: string | null;
};

type ResumeEntry = {
  descriptor: AiSessionDescriptor;
  target: ResumeTarget;
  adapterName: string;
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
    if (!entry) return null;
    const projection = projectTranscriptFile({
      adapterName: entry.adapterName,
      transcriptPath: entry.target.transcriptPath,
      workingDir: entry.descriptor.workingDir,
    });
    return {
      descriptor: structuredClone(entry.descriptor),
      target: structuredClone(entry.target),
      transcript: structuredClone(projection.transcript),
      toolCalls: structuredClone(projection.toolCalls),
      agentFrameworkSessionDir: projection.agentFrameworkSessionDir,
    };
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
      adapterName: record.adapterName,
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
  const transcriptPath = target.target.transcriptPath;
  if (!transcriptPath) return null;
  const nativeSessionId = target.target.threadId ?? target.target.sessionId ?? null;
  return {
    provider: target.provider,
    target: { ...target.target },
    transcriptPath,
    nativeSessionId,
  };
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

function compareHistoryRecords(a: AdapterSessionHistoryRecord, b: AdapterSessionHistoryRecord): number {
  const time = (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  return time || path.resolve(a.workingDir).localeCompare(path.resolve(b.workingDir)) || a.summary.localeCompare(b.summary);
}
