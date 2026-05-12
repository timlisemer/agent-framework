import * as fs from "fs";
import * as path from "path";
import type { EventName } from "../adapter/types.js";
import type { PlanModeTransition } from "./plan-mode-entry-state.js";
import type { PendingInjection } from "./session-injections.js";
import { shortContentHash } from "./session-injections.js";

export interface ContextInjectionProviderInput {
  projectDir: string;
  sourceEvent: EventName;
  planModeTransition: PlanModeTransition;
}

export interface ContextInjectionProvider {
  id: string;
  build(input: ContextInjectionProviderInput): Promise<PendingInjection[]>;
}

function buildPlanModeInjectionMessage(plansContent: string): string {
  return [
    "The session just entered plan mode. Follow this repository planning contract for all planning and <proposed_plan> output.",
    "",
    plansContent.trim(),
  ].join("\n");
}

export const plansMdPlanModeEntryProvider: ContextInjectionProvider = {
  id: "plans-md-plan-mode-entry",

  async build(input: ContextInjectionProviderInput): Promise<PendingInjection[]> {
    if (!input.planModeTransition.entered) return [];

    const plansPath = path.join(input.projectDir, "PLANS.md");
    let plansContent: string;
    try {
      plansContent = await fs.promises.readFile(plansPath, "utf-8");
    } catch {
      return [];
    }
    if (!plansContent.trim()) return [];

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
          content_hash: shortContentHash(plansContent),
        },
        metadata: {
          source_event: input.sourceEvent,
          detection_source: input.planModeTransition.detection_source,
          permission_mode: input.planModeTransition.permission_mode,
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
