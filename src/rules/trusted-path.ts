import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { extractFilePaths, isSensitivePath } from "./utils.js";
import { SENSITIVE_PATH_RULE_POLICY } from "./policies.js";

export const trustedPathRule: PreToolRule = {
  name: "sensitive-path-block",
  displayName: "Sensitive Path Block",
  priority: 58,
  appealable: false,
  usesLlm: false,
  version: "1",
  configuration: SENSITIVE_PATH_RULE_POLICY,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!(SENSITIVE_PATH_RULE_POLICY.fileTools as readonly string[]).includes(ctx.toolName))
      return null;

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
