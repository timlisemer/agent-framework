import * as path from "path";
import { readJson, writeJson } from "./file-io.js";
import { hashSha256 } from "./hash-utils.js";
import { sessionPlanValidationStatusFile } from "./paths.js";

export type PlanValidationRecordedStatus = "pass" | "fail";

export interface PlanValidationStatusRecord {
  status: PlanValidationRecordedStatus;
  timestamp: string;
  planPath: string;
  contentHash: string;
  reasons: string[];
}

type PlanValidationStatusStore = Record<string, PlanValidationStatusRecord>;

export function hashPlanContent(content: string): string {
  return hashSha256(Buffer.from(content, "utf8"));
}

export function planValidationStatusKey(planPath: string, contentHash: string): string {
  return `${path.resolve(planPath)}#${contentHash}`;
}

function readStore(sessionDir: string): PlanValidationStatusStore {
  try {
    const parsed = readJson<PlanValidationStatusStore>(sessionPlanValidationStatusFile(sessionDir));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readPlanValidationStatus(input: {
  sessionDir: string;
  planPath: string;
  contentHash: string;
}): PlanValidationStatusRecord | null {
  const store = readStore(input.sessionDir);
  return store[planValidationStatusKey(input.planPath, input.contentHash)] ?? null;
}

export function recordPlanValidationStatus(input: {
  sessionDir: string;
  planPath: string;
  contentHash: string;
  status: PlanValidationRecordedStatus;
  reasons: readonly string[];
}): PlanValidationStatusRecord {
  const record: PlanValidationStatusRecord = {
    status: input.status,
    timestamp: new Date().toISOString(),
    planPath: path.resolve(input.planPath),
    contentHash: input.contentHash,
    reasons: [...input.reasons],
  };
  const store = readStore(input.sessionDir);
  store[planValidationStatusKey(input.planPath, input.contentHash)] = record;
  writeJson(sessionPlanValidationStatusFile(input.sessionDir), store);
  return record;
}
