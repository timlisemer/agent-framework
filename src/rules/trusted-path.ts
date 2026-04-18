import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { FILE_TOOLS, isSensitivePath } from "./utils.js";

export const trustedPathRule: PreToolRule = {
  name: "sensitive-path-block",
  displayName: "Sensitive Path Block",
  priority: 58,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent) return null;
    if (!FILE_TOOLS.includes(ctx.toolName)) return null;

    const filePath =
      (ctx.toolInput as { file_path?: string }).file_path ||
      (ctx.toolInput as { path?: string }).path || "";
    if (!filePath) return null;

    if (isSensitivePath(filePath)) {
      return { fastDeny: `Sensitive path blocked: ${filePath} matches a sensitive-file pattern (.env, credentials, .ssh, .aws, secrets, .key, .pem, password).` };
    }
    return null;
  },
};
