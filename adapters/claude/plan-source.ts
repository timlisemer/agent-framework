import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  PlanExitDetectionInput,
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

export async function findCurrentPlanSource(
  input: PlanSourceLookupInput,
): Promise<PlanSourceDescriptor | null> {
  const slug = await extractSlugFromSession(input.transcriptPath);
  if (!slug) return null;

  const planDir = process.env.AGENT_FRAMEWORK_PLAN_DIR ?? path.join(os.homedir(), ".claude", "plans");
  const planPath = path.join(planDir, `${slug}.md`);
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
