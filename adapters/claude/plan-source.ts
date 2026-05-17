import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  PlanExitDetectionInput,
  NativePlanFileLookupInput,
  PlanSourceDescriptor,
  PlanSourceLookupInput,
} from "../../src/adapter/types.js";

interface SessionMetadata {
  slug?: string;
}

async function extractSlugFromSession(transcriptPath: string): Promise<string | null> {
  try {
    const content = await fs.promises.readFile(transcriptPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionMetadata;
        if (entry.slug) return entry.slug;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function findNativePlanFile(input: NativePlanFileLookupInput): Promise<string | null> {
  const slug = await extractSlugFromSession(input.transcriptPath);
  if (!slug) return null;

  const planDir = process.env.AGENT_FRAMEWORK_PLAN_DIR ?? path.join(os.homedir(), ".claude", "plans");
  return path.join(planDir, `${slug}.md`);
}

export async function findCurrentPlanSource(
  input: PlanSourceLookupInput,
): Promise<PlanSourceDescriptor | null> {
  const planPath = await findNativePlanFile(input);
  if (!planPath) return null;
  try {
    await fs.promises.access(planPath);
    return { kind: "file", path: planPath };
  } catch {
    return null;
  }
}

export function isPlanExit(input: PlanExitDetectionInput): boolean {
  if (input.event !== "PreToolUse") return false;
  return input.canonicalToolName === "ExitPlanMode" || input.rawToolName === "ExitPlanMode";
}

export function extractStopProposedPlan(_text: string | null | undefined): string | null {
  return null;
}
