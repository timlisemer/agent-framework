import fs from "node:fs";
import path from "node:path";
import type { AdapterSessionHistoryRecord } from "../../src/adapter/types.js";
import {
  listManagedSessionRecords,
  readManagedSessionRecord,
  stringAt,
  type JsonObject,
} from "../shared/session-history.js";
import { managedProviderRoot } from "../../src/utils/paths.js";

export async function listManagedSessions(input: {
  maxResults: number;
}): Promise<readonly AdapterSessionHistoryRecord[]> {
  return listManagedSessionRecords({
    root: path.join(managedProviderRoot("claude"), "projects"),
    maxResults: input.maxResults,
    readRecord: readClaudeSession,
  });
}

function readClaudeSession(filePath: string): AdapterSessionHistoryRecord | null {
  return readManagedSessionRecord({
    adapterName: "claude",
    filePath,
    defaultSessionId: path.basename(filePath).replace(/\.jsonl$/, ""),
    workingDirPaths: [["cwd"], ["projectDir"], ["message", "cwd"]],
    sessionIdPaths: [["sessionId"], ["session_id"]],
    roleFor: (raw: JsonObject) => {
      const type = stringAt(raw, ["type"]);
      if (type === "assistant" || type === "user") return type;
      const role = stringAt(raw, ["message", "role"]);
      return role === "assistant" || role === "user" ? role : null;
    },
    textPaths: [["text"], ["content"], ["message", "content"]],
    contentPaths: [["content"], ["message", "content"]],
    fallbackWorkingDir: inferWorkingDirFromSidecar,
    targetKeyFor: (sessionId, transcriptPath) => `claude:${sessionId}:${transcriptPath}`,
    resumeTargetFor: (sessionId, transcriptPath) => ({ provider: "claude", target: { sessionId, transcriptPath } }),
  });
}

function inferWorkingDirFromSidecar(filePath: string): string | null {
  try {
    const value = fs.readFileSync(`${filePath}.cwd`, "utf8").trim();
    return value ? path.resolve(value) : null;
  } catch {
    return null;
  }
}
