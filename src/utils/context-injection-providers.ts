import * as fs from "fs";
import * as path from "path";
import type { EventName } from "../adapter/types.js";
import type { PlanModeTransition } from "./plan-mode-entry-state.js";
import { markPlansMdDelivered } from "./plan-mode-entry-state.js";
import type { PendingInjection } from "./session-injections.js";
import { shortContentHash } from "./session-injections.js";
import { agentFrameworkRoot } from "./paths.js";

export interface ContextInjectionProviderInput {
  projectDir: string;
  sourceEvent: EventName;
  planModeTransition: PlanModeTransition;
}

export interface ContextInjectionProvider {
  id: string;
  build(input: ContextInjectionProviderInput): Promise<PendingInjection[]>;
}

const PLAN_MODE_CONTRACT_HOOK_INJECTION_ENABLED = false;

function buildPlanModeInjectionMessage(plansContent: string): string {
  return [
    "The session is in plan mode. The planning contract below applies to every final named planfile you produce in this foreground session.",
    "",
    "Final planning output must use exactly the 14 required level-two Markdown headings from the contract, in order, with no extra ## headings. Ordinary ### subsections are allowed under those required headings.",
    "",
    plansContent.trim(),
  ].join("\n");
}

export const plansMdPlanModeEntryProvider: ContextInjectionProvider = {
  id: "plans-md-plan-mode-entry",

  async build(input: ContextInjectionProviderInput): Promise<PendingInjection[]> {
    if (input.sourceEvent !== "UserPromptSubmit") return [];
    if (!input.planModeTransition.active) return [];
    // Temporarily disabled while Codex parses but does not yet implement
    // suppressOutput for hook context. The provider stays in place so the
    // hidden hook injection path can be re-enabled when Codex supports it.
    if (!PLAN_MODE_CONTRACT_HOOK_INJECTION_ENABLED) return [];

    const plansPath = path.join(agentFrameworkRoot(), "PLANS.md");
    let plansContent: string;
    try {
      plansContent = await fs.promises.readFile(plansPath, "utf-8");
    } catch {
      return [];
    }
    if (!plansContent.trim()) return [];
    const contentHash = shortContentHash(plansContent);
    if (input.planModeTransition.current.deliveredPlansMdHash === contentHash) {
      return [];
    }

    markPlansMdDelivered(input.planModeTransition, contentHash);

    return [
      {
        id: this.id,
        trigger: "plan-mode-entry",
        channel: "context",
        message: buildPlanModeInjectionMessage(plansContent),
        source_file: {
          kind: "file",
          path: plansPath,
          content: plansContent,
          content_hash: contentHash,
        },
        metadata: {
          source_event: input.sourceEvent,
          detection_source: input.planModeTransition.detection_source,
          mode: input.planModeTransition.mode,
        },
      },
    ];
  },
};

export const contextInjectionProviders: readonly ContextInjectionProvider[] = [
  plansMdPlanModeEntryProvider,
];

export async function buildPendingContextInjections(
  input: ContextInjectionProviderInput,
): Promise<PendingInjection[]> {
  const pending: PendingInjection[] = [];
  for (const provider of contextInjectionProviders) {
    pending.push(...await provider.build(input));
  }
  return pending;
}
