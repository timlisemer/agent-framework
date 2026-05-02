import * as os from "os";
import * as path from "path";

export type HostAdapterName = "claude" | "codex";

export interface HostContext {
  adapter: HostAdapterName;
  projectDir: string;
  configRoot: string;
  plansRoot: string;
  instructionFiles: string[];
  instructionLabel: string;
}

export function resolveHostContext(input?: { cwd?: string }): HostContext {
  const adapter = (process.env.AGENT_FRAMEWORK_ADAPTER === "codex" ? "codex" : "claude") as HostAdapterName;
  const projectDir =
    process.env.AGENT_FRAMEWORK_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    input?.cwd ||
    process.cwd();

  if (adapter === "codex") {
    const configRoot = path.join(os.homedir(), ".codex");
    const plansRoot = process.env.AGENT_FRAMEWORK_PLAN_DIR ?? path.join(configRoot, "plans");
    return {
      adapter,
      projectDir,
      configRoot,
      plansRoot,
      instructionFiles: [path.join(projectDir, "AGENTS.md"), path.join(projectDir, "CLAUDE.md")],
      instructionLabel: "AGENTS.md/CLAUDE.md",
    };
  }

  const configRoot = path.join(os.homedir(), ".claude");
  const plansRoot = process.env.AGENT_FRAMEWORK_PLAN_DIR ?? path.join(configRoot, "plans");
  return {
    adapter,
    projectDir,
    configRoot,
    plansRoot,
    instructionFiles: [path.join(projectDir, "CLAUDE.md")],
    instructionLabel: "CLAUDE.md",
  };
}
