/** Shared path precedence for adapter host contexts. */

import * as os from "os";
import * as path from "path";
import type { HostContextInput } from "../../src/adapter/types.js";

export interface BaseHostContext {
  projectDir: string;
  configRoot: string;
  plansRoot: string;
}

/** Resolve the repository scope once for all adapter consumers. Empty values fall through. */
export function resolveProjectDirectory(input: HostContextInput = {}): string {
  return path.resolve(
    input.projectDir ||
    process.env.AGENT_FRAMEWORK_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    input.cwd ||
    process.cwd(),
  );
}

export function resolveBaseHostContext(
  input: HostContextInput,
  configDirectory: string,
): BaseHostContext {
  const projectDir = resolveProjectDirectory(input);
  const configRoot = path.join(os.homedir(), configDirectory);
  return {
    projectDir,
    configRoot,
    plansRoot: process.env.AGENT_FRAMEWORK_PLAN_DIR ?? path.join(configRoot, "plans"),
  };
}
