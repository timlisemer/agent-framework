import path from "node:path";
import type { AdapterSessionHistoryRecord } from "../../src/adapter/types.js";
import {
  listManagedSessionRecords,
  readManagedSessionRecord,
  stringAt,
  type JsonObject,
} from "../shared/session-history.js";
import { managedProviderRoot } from "../../src/utils/paths.js";
import { codexTranscriptCwd, codexTranscriptSessionId } from "./paths.js";
import { codexEntrySessionId } from "./transcript-metadata.js";

export async function listManagedSessions(input: {
  maxResults: number;
}): Promise<readonly AdapterSessionHistoryRecord[]> {
  return listManagedSessionRecords({
    root: path.join(managedProviderRoot("codex"), "sessions"),
    maxResults: input.maxResults,
    readRecord: readCodexSession,
  });
}

function readCodexSession(filePath: string): AdapterSessionHistoryRecord | null {
  return readManagedSessionRecord({
    adapterName: "codex",
    filePath,
    defaultSessionId: codexTranscriptSessionId(filePath) ?? path.basename(filePath).replace(/\.jsonl$/, ""),
    workingDirPaths: [["payload", "cwd"], ["cwd"]],
    sessionIdPaths: [],
    sessionIdFor: codexEntrySessionId,
    roleFor: (raw: JsonObject) => {
      if (stringAt(raw, ["type"]) === "event_msg" && stringAt(raw, ["payload", "type"]) === "agent_message") {
        return "assistant";
      }
      const role = stringAt(raw, ["role"]) ?? stringAt(raw, ["message", "role"]) ?? stringAt(raw, ["payload", "role"]);
      return role === "assistant" || role === "user" ? role : null;
    },
    textPaths: [["text"], ["content"], ["message", "content"], ["payload", "text"], ["payload", "content"], ["payload", "message"]],
    contentPaths: [["content"], ["message", "content"], ["payload", "content"]],
    fallbackWorkingDir: (filePath) => codexTranscriptCwd(filePath) ?? null,
    targetKeyFor: (threadId, transcriptPath) => `codex:${threadId}:${transcriptPath}`,
    resumeTargetFor: (threadId, transcriptPath) => ({ provider: "codex", target: { threadId, transcriptPath } }),
  });
}
