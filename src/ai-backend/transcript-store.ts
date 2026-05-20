import type {
  AiPlanState,
  AiSessionConfig,
  AiSessionSnapshot,
  AiSessionStatus,
  AiTranscriptEntry,
  ProviderResumeMetadata,
  SessionId,
} from "../ai-protocol/index.js";

const defaultPlan: AiPlanState = {
  mode: "disabled",
  planText: null,
  approved: false,
};

export class TranscriptStore {
  readonly #sessions = new Map<SessionId, AiSessionSnapshot>();
  readonly #configs = new Map<SessionId, AiSessionConfig>();
  create(sessionId: SessionId, config: AiSessionConfig): AiSessionSnapshot {
    const snapshot: AiSessionSnapshot = {
      sessionId,
      status: "idle" as AiSessionStatus,
      transcript: [],
      pendingTools: [],
      plan: { ...defaultPlan },
      resume: config.provider
        ? {
            provider: config.provider,
            nativeSessionId: null,
            nativeThreadId: null,
          }
        : null,
      error: null,
    };
    this.#sessions.set(sessionId, snapshot);
    this.#configs.set(sessionId, config);
    return snapshot;
  }

  get(sessionId: SessionId): AiSessionSnapshot | undefined {
    return this.#sessions.get(sessionId);
  }

  getConfig(sessionId: SessionId): AiSessionConfig | undefined {
    return this.#configs.get(sessionId);
  }

  append(sessionId: SessionId, entry: AiTranscriptEntry): AiSessionSnapshot {
    return this.update(sessionId, (snapshot) => {
      snapshot.transcript.push(entry);
    });
  }

  setStatus(sessionId: SessionId, status: AiSessionStatus, error: string | null = null): AiSessionSnapshot {
    return this.update(sessionId, (snapshot) => {
      snapshot.status = status;
      snapshot.error = error;
    });
  }

  setPlan(sessionId: SessionId, plan: AiPlanState): AiSessionSnapshot {
    return this.update(sessionId, (snapshot) => {
      snapshot.plan = plan;
    });
  }

  setResume(sessionId: SessionId, resume: ProviderResumeMetadata): AiSessionSnapshot {
    return this.update(sessionId, (snapshot) => {
      snapshot.resume = resume;
    });
  }

  update(sessionId: SessionId, f: (snapshot: AiSessionSnapshot) => void): AiSessionSnapshot {
    const snapshot = this.#sessions.get(sessionId);
    if (!snapshot) throw new Error(`Unknown AI session: ${sessionId}`);
    f(snapshot);
    return snapshot;
  }
}
