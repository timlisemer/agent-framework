import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { createPlanfileAuthorization } from "../utils/create-planfile.js";
import { CREATE_PLANFILE_ALLOW_RULE_POLICY } from "./policies.js";

export const createPlanfileAllowRule: PreToolRule = {
  name: "create-planfile-allow",
  displayName: "Create Planfile Allow",
  priority: 36,
  appealable: false,
  usesLlm: false,
  version: "1",
  configuration: CREATE_PLANFILE_ALLOW_RULE_POLICY,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const authorization = createPlanfileAuthorization({
      toolName: ctx.toolName,
      rawToolName: ctx.rawToolName,
      toolInput: ctx.toolInput,
      planMode: ctx.planMode,
      currentPrediction: ctx.state.currentPrediction,
    });
    if (!authorization) return null;

    if (authorization === "workflow") {
      return {
        fastAllow:
          "Workflow requires create_planfile next; planfile creation is authorized.",
      };
    }

    return {
      fastAllow:
        "Plan mode allows create_planfile to write and validate the session planfile.",
    };
  },
};
