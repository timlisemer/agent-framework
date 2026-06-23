import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { FILE_TOOLS, extractFilePaths, isSensitivePath } from "./utils.js";

export const trustedPathRule: PreToolRule = {
  name: "sensitive-path-block",
  displayName: "Sensitive Path Block",
  priority: 58,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!FILE_TOOLS.includes(ctx.toolName) && ctx.toolName !== "Read") return null;

    const filePaths = extractFilePaths(ctx.toolName, ctx.toolInput);
    for (const filePath of filePaths) {
      if (isSensitivePath(filePath)) {
        return {
          fastDeny: `Sensitive path blocked: ${filePath} matches a sensitive-file pattern (real .env files, credentials, .ssh, .aws, .gnupg, .kube, secrets, SOPS/age/key material, private keys, passwords).`,
        };
      }
    }
    return null;
  },
};
