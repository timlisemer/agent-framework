import * as os from "os";
import * as path from "path";
import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { FILE_TOOLS, isTrustedPath, isSensitivePath, isPathInDirectory } from "./utils.js";

export const trustedPathRule: PreToolRule = {
  name: "trusted-path",
  displayName: "Trusted Path",
  priority: 58,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!FILE_TOOLS.includes(ctx.toolName)) {
      return null;
    }

    const filePath =
      (ctx.toolInput as { file_path?: string }).file_path ||
      (ctx.toolInput as { path?: string }).path;

    if (!filePath) {
      return null;
    }

    const trusted = isTrustedPath(filePath, ctx.projectDir);
    const sensitive = isSensitivePath(filePath);

    if (!trusted || sensitive) {
      return null;
    }

    // Exclude plan files and CLAUDE.md files -- they have their own validators
    const plansDir = path.join(os.homedir(), ".claude", "plans");
    if (isPathInDirectory(filePath, plansDir)) {
      return null;
    }
    if (filePath.endsWith("CLAUDE.md")) {
      return null;
    }

    if (!ctx.useSyncPipeline) {
      return { fastAllow: "Trusted file fast-path" };
    }

    return null;
  },
};
