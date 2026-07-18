import type { AgentFrameworkHostCommand } from "./host-command.js";

/** Committed fixture sources that exercise live Agent Framework host behavior. */
export const AGENT_FRAMEWORK_COMMITTED_BEHAVIOR_SOURCES = [
  "expected-to-pass",
  "non-deterministic",
  "expected-to-fail",
] as const;

export type AgentFrameworkCommittedBehaviorSource =
  typeof AGENT_FRAMEWORK_COMMITTED_BEHAVIOR_SOURCES[number];

/** Classify host commands whose behavior must be evaluated through live effects. */
export function isAgentFrameworkLiveBehaviorCommand(
  command: AgentFrameworkHostCommand,
): boolean {
  return command.type !== "hostSessionStarted";
}
