import * as path from "path";
import { activeSpec } from "../adapter/spec.js";
import { hashSha256Prefix } from "../utils/hash-utils.js";
import { readSessionTranscriptPath } from "../utils/paths.js";

/** Derive the Agent Framework host-run identity from its native transcript boundary. */
export function canonicalHookRunId(adapter: string, transcriptPath: string): string {
  const digest = hashSha256Prefix(`${adapter}\0${path.resolve(transcriptPath)}`, 32);
  return `hook-${adapter}-${digest}`;
}

export function canonicalHookRunIdForSession(sessionDir: string): string | null {
  const transcriptPath = readSessionTranscriptPath(sessionDir);
  return transcriptPath ? canonicalHookRunId(activeSpec().name, transcriptPath) : null;
}
