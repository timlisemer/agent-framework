import * as path from "path";
import { idSchema } from "../protocol/common.js";

export function canonicalRunsRoot(root: string): string {
  return path.join(root, "runs");
}

export function canonicalRunDir(runId: string, root: string): string {
  return path.join(canonicalRunsRoot(root), idSchema.parse(runId));
}

export function runManifestPath(runId: string, root: string): string {
  return path.join(canonicalRunDir(runId, root), "manifest.json");
}

export function runJournalPath(runId: string, root: string): string {
  return path.join(canonicalRunDir(runId, root), "scenario.records.jsonl");
}

export function runSnapshotPath(runId: string, root: string): string {
  return path.join(canonicalRunDir(runId, root), "scenario.snapshot.json");
}

export function runFeedbackPath(runId: string, root: string): string {
  return path.join(canonicalRunDir(runId, root), "feedback.jsonl");
}

export function runArtifactsDir(runId: string, root: string): string {
  return path.join(canonicalRunDir(runId, root), "artifacts");
}

export function runIndexPath(root: string): string {
  return path.join(root, "run-index.jsonl");
}
