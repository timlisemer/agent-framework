import {
  analyzeBashCommand,
  evalPayloadCommand,
  firstCommandHead,
  shellPayloadCommand,
} from "./analysis.js";
import { matchPatternInCommandTarget, resolveAlternative, resolvePatternAlternative } from "./helpers.js";
import {
  CHECK_EQUIVALENTS,
  CHECK_ROUTED_COMMAND_POLICIES,
  checkRoutedPolicyFindingsFromPolicies as checkFindingsFromPolicies,
  detectWorkaroundCommand,
  findCheckRoutedPolicies,
  matchCheckRoutedPolicyInCommand,
  WORKAROUND_PATTERNS,
} from "./topics/check-routed.js";
import {
  FILE_WRITE_PATTERNS,
  SHELL_REDIRECT_DENY_REASON,
  fileWritePolicyFindings,
  fileWritePolicyFingerprintCategories,
} from "./topics/file-write.js";
import {
  READ_ONLY_BASH_COMMANDS,
  READ_ONLY_HARD_PATTERNS,
  READ_ONLY_HEAVY_BASH_COMMANDS,
  checkReadOnlyBashAllowlist,
  readOnlyPolicyFindings,
} from "./topics/read-only.js";
import {
  RUN_INSTALL_REMOTE_PATTERNS,
  runInstallRemotePolicyFindings,
} from "./topics/run-install-remote.js";
import {
  SCRIPT_EXEC_PATTERNS,
  scriptExecPolicyFindings,
} from "./topics/script-exec.js";
import {
  READ_ONLY_GIT_COMMANDS_DESCRIPTION,
  contentContainsGitWorkflowWrite,
  contentContainsGitWrite,
  containsGitWorkflowWrite,
  containsGitWrite,
  gitPolicyFindings,
} from "./topics/git.js";
import {
  FIND_DESTRUCTIVE_DENY_REASON,
  FIND_DESTRUCTIVE_FLAG_NAMES,
  FIND_DESTRUCTIVE_FLAG_TOKEN_PATTERN,
  FIND_OPTIONS_WITH_VALUE,
  findDestructiveFlagsFromCommand,
  findDestructiveFlagsFromFindArgs,
  findSedPolicyFindings,
} from "./topics/find-sed.js";
import type {
  BashCommandClassification,
  BashCommandRiskClass,
  BashPolicyMessageOptions,
  BashPolicyFinding,
  BashPolicyResult,
  BashTerminalDecision,
  BlacklistPattern,
  CheckRoutedCommandPolicy,
} from "./types.js";

export {
  CHECK_EQUIVALENTS,
  CHECK_ROUTED_COMMAND_POLICIES,
  READ_ONLY_BASH_COMMANDS,
  READ_ONLY_GIT_COMMANDS_DESCRIPTION,
  READ_ONLY_HEAVY_BASH_COMMANDS,
  WORKAROUND_PATTERNS,
  checkReadOnlyBashAllowlist,
  detectWorkaroundCommand,
  fileWritePolicyFindings,
  fileWritePolicyFingerprintCategories,
  FIND_DESTRUCTIVE_DENY_REASON,
  FIND_DESTRUCTIVE_FLAG_NAMES,
  FIND_DESTRUCTIVE_FLAG_TOKEN_PATTERN,
  FIND_OPTIONS_WITH_VALUE,
  findDestructiveFlagsFromCommand,
  findDestructiveFlagsFromFindArgs,
  matchCheckRoutedPolicyInCommand,
};

const DEFAULT_MESSAGES: BashPolicyMessageOptions = {
  checkMcpAction: "Check-routed command blocked",
  gitWorkflowAlternative: "Workflow command blocked",
};

function checkMcpAction(messages: BashPolicyMessageOptions = DEFAULT_MESSAGES): string {
  return messages.checkMcpAction ?? DEFAULT_MESSAGES.checkMcpAction ?? "Check-routed command blocked";
}

export const GIT_BLACKLIST_PATTERNS: BlacklistPattern[] = [
  { pattern: /\bgit\s+\S+/, commandMatcher: containsGitWorkflowWrite, contentMatcher: contentContainsGitWorkflowWrite, name: "git write op (MCP)", alternative: DEFAULT_MESSAGES.gitWorkflowAlternative ?? "Use workflow tools", topic: "git" },
  { pattern: /\bgit\s+\S+/, commandMatcher: containsGitWrite, contentMatcher: contentContainsGitWrite, name: "git write op", alternative: "Git write operation denied", topic: "git" },
];

export const BLACKLIST_PATTERNS: BlacklistPattern[] = [
  ...FILE_WRITE_PATTERNS,
  ...READ_ONLY_HARD_PATTERNS,
  ...GIT_BLACKLIST_PATTERNS,
  ...RUN_INSTALL_REMOTE_PATTERNS,
  ...SCRIPT_EXEC_PATTERNS,
];

export function matchPatternInCommand(command: string, pattern: BlacklistPattern): boolean {
  return matchPatternInCommandTarget(command, pattern);
}

function patternAlternative(pattern: BlacklistPattern, messages: BashPolicyMessageOptions): string {
  return resolvePatternAlternative(pattern.name, pattern.alternative, messages.gitWorkflowAlternative ?? DEFAULT_MESSAGES.gitWorkflowAlternative ?? "Workflow command blocked");
}

function hardPatternFindings(command: string, messages: BashPolicyMessageOptions): BashPolicyFinding[] {
  return READ_ONLY_HARD_PATTERNS
    .filter((pattern) => matchPatternInCommand(command, pattern))
    .map((pattern) => {
      const alternative = patternAlternative(pattern, messages);
      const finding: BashPolicyFinding = {
        topic: pattern.topic ?? "read-only",
        role: "terminal-candidate",
        kind: "deny",
        name: pattern.name,
        reason: pattern.name === "nix eval" ? alternative : pattern.name,
        alternative,
      };
      if (pattern.name.includes("install")) {
        finding.category = "install";
      }
      return finding;
    });
}

function basePredictionIdentities(riskClass: BashCommandRiskClass, commandHead?: string): string[] {
  return ["Bash", `Bash:${riskClass}`, ...(commandHead ? [`Bash:${commandHead}`] : [])];
}

function checkHighlight(policy: CheckRoutedCommandPolicy, workingDir?: string, messages: BashPolicyMessageOptions = DEFAULT_MESSAGES): string {
  const msg = messages.renderCheckMessage?.(policy, workingDir) ?? checkMcpAction(messages);
  return `[CHECK-ROUTED: ${policy.name}] ${msg}`;
}

function hardHighlight(finding: BashPolicyFinding): string {
  return `[BLACKLIST: ${finding.name}] ${finding.alternative ?? finding.reason}`;
}

function terminalFromFinding(
  finding: BashPolicyFinding,
  riskClass: BashCommandRiskClass,
  commandHead?: string,
  extra: Partial<BashTerminalDecision> = {},
): BashTerminalDecision {
  return {
    ownerTopic: finding.topic,
    ownerName: finding.name,
    riskClass,
    readOnly: riskClass === "simple-read-only" || riskClass === "read-only-heavy" || riskClass === "read-only-complex",
    reason: finding.reason,
    alternative: finding.alternative,
    commandHead,
    predictionIdentities: basePredictionIdentities(riskClass, commandHead),
    ...extra,
  };
}

function ensureSingleTerminal(result: BashPolicyResult): BashPolicyResult {
  const terminalFindings = result.observations.filter((finding) => finding.role === "terminal-candidate");
  if (terminalFindings.length > 1 && (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development")) {
    throw new Error(`Bash policy selected multiple terminal candidates: ${terminalFindings.map((f) => f.name).join(", ")}`);
  }
  return result;
}

function chooseTerminalFinding(findings: BashPolicyFinding[], chosen: BashPolicyFinding): BashPolicyFinding[] {
  return findings.map((finding) => finding === chosen ? finding : { ...finding, role: "observation" as const });
}

function hardFindingPriority(finding: BashPolicyFinding): number {
  if (finding.name === "cd" || finding.name === "cd && chain" || finding.name === "nix eval") return 5;
  if (finding.category === "install" || finding.name.includes("install")) return 20;
  return 10;
}

function highestPriorityHardFinding(findings: BashPolicyFinding[]): BashPolicyFinding | undefined {
  return findings.reduce<BashPolicyFinding | undefined>((chosen, finding) => {
    if (!chosen) return finding;
    return hardFindingPriority(finding) < hardFindingPriority(chosen) ? finding : chosen;
  }, undefined);
}

function invocationIsWrapperOnly(invocation: ReturnType<typeof analyzeBashCommand>["invocations"][number]): boolean {
  return shellPayloadCommand(invocation) !== null || evalPayloadCommand(invocation) !== null;
}

function invocationIsCheckRoutedOrReadOnly(invocation: ReturnType<typeof analyzeBashCommand>["invocations"][number]): boolean {
  if (invocationIsWrapperOnly(invocation)) return true;
  if (findCheckRoutedPolicies(invocation.segment).length > 0) return true;
  return checkReadOnlyBashAllowlist(invocation.segment).allowed;
}

function segmentHasCheckRoutedCommandOrPayload(segment: string): boolean {
  const segmentAnalysis = analyzeBashCommand(segment);
  return segmentAnalysis.invocations.some((invocation) => findCheckRoutedPolicies(invocation.segment).length > 0) &&
    segmentAnalysis.invocations.every(invocationIsCheckRoutedOrReadOnly);
}

function segmentIsCheckRoutedOrReadOnly(segment: string): boolean {
  if (segmentHasCheckRoutedCommandOrPayload(segment)) return true;
  return checkReadOnlyBashAllowlist(segment).allowed;
}

function allSegmentsCheckRoutedOrReadOnly(analysis: ReturnType<typeof analyzeBashCommand>): boolean {
  return analysis.segments
    .map((segment) => segment.segment.trim())
    .filter(Boolean)
    .every(segmentIsCheckRoutedOrReadOnly);
}

function terminalResultForDenyFinding(
  chosen: BashPolicyFinding,
  findings: BashPolicyFinding[],
  riskClass: BashCommandRiskClass,
  commandHead: string | undefined,
  blacklistHighlights: string[],
  secondaryHighlights: string[],
  hasInstallWorkaround: boolean,
): BashPolicyResult {
  const extra: Partial<BashTerminalDecision> = {
    blacklistHighlights,
  };
  if (chosen.category === "install" || chosen.topic !== "read-only" && hasInstallWorkaround) {
    extra.workaroundCategory = "install";
  }
  if (chosen.topic === "file-write" && extra.workaroundCategory === undefined) {
    extra.workaroundCategory = chosen.category ?? "file-write";
  }
  return ensureSingleTerminal({
    terminal: terminalFromFinding(chosen, riskClass, commandHead, extra),
    observations: chooseTerminalFinding(findings, chosen),
    secondaryHighlights,
  });
}

export function evaluateBashPolicy(command: string, workingDir?: string, messages: BashPolicyMessageOptions = DEFAULT_MESSAGES): BashPolicyResult {
  const trimmed = command.trim();
  const commandHead = firstCommandHead(trimmed);
  const analysis = analyzeBashCommand(trimmed);

  const emptyTerminal: BashTerminalDecision = {
    ownerTopic: "fallback",
    ownerName: "empty command",
    riskClass: "blocked",
    readOnly: false,
    reason: "empty command",
    commandHead,
    predictionIdentities: basePredictionIdentities("blocked", commandHead),
    blacklistHighlights: [],
  };
  if (!trimmed) {
    return { terminal: emptyTerminal, observations: [], secondaryHighlights: [] };
  }

  const hardFindings = hardPatternFindings(trimmed, messages);
  const checkPolicies = findCheckRoutedPolicies(trimmed, analysis);
  const checkFindings = checkFindingsFromPolicies(checkPolicies);
  const findSedFindings = findSedPolicyFindings(trimmed);
  const fileWriteFindings = fileWritePolicyFindings(trimmed);
  const gitFindings = gitPolicyFindings(trimmed).map((finding) =>
    finding.name === "git write op (MCP)"
      ? { ...finding, alternative: messages.gitWorkflowAlternative ?? DEFAULT_MESSAGES.gitWorkflowAlternative ?? "Use workflow tools" }
      : finding
  );
  const runInstallRemoteFindings = runInstallRemotePolicyFindings(trimmed, matchPatternInCommand);
  const scriptExecFindings = scriptExecPolicyFindings(trimmed, matchPatternInCommand);
  const topicFindings = [
    ...fileWriteFindings,
    ...gitFindings,
    ...runInstallRemoteFindings,
    ...scriptExecFindings,
    ...findSedFindings,
  ];
  const topicObservations = topicFindings.map((finding) => ({ ...finding, role: "observation" as const }));

  const checkHighlights = checkPolicies.map((policy) => checkHighlight(policy, workingDir, messages));
  const hardHighlights = hardFindings.map(hardHighlight);
  const topicHighlights = topicFindings.map(hardHighlight);
  const blacklistHighlights = [...hardHighlights, ...topicHighlights, ...checkHighlights];

  const workaroundCategory = detectWorkaroundCommand(trimmed);
  const hasInstallWorkaround = workaroundCategory === "install" || runInstallRemoteFindings.some((finding) => finding.category === "install");
  const checkFindingForWorkaround = checkFindings.find((finding) => finding.category === workaroundCategory) ?? checkFindings[0];
  const prioritizedHardFinding = highestPriorityHardFinding(hardFindings);
  if (prioritizedHardFinding && (prioritizedHardFinding.category !== "install" || checkFindings.length > 0)) {
    const chosen = prioritizedHardFinding;
    const riskClass = chosen.category === "install" ? "high-risk-workaround" : "blocked";
    return terminalResultForDenyFinding(chosen, [...topicObservations, ...hardFindings, ...checkFindings], riskClass, commandHead, blacklistHighlights, checkHighlights, hasInstallWorkaround);
  }

  const findSedFinding = findSedFindings[0];
  if (findSedFinding) {
    const observations = chooseTerminalFinding([...topicObservations, ...hardFindings, ...checkFindings, findSedFinding], findSedFinding);
    return ensureSingleTerminal({
      terminal: terminalFromFinding(findSedFinding, "blocked", commandHead, {
        blacklistHighlights,
      }),
      observations,
      secondaryHighlights: checkHighlights,
    });
  }

  const deterministicTopicFinding = [
    ...fileWriteFindings,
    ...gitFindings,
    ...runInstallRemoteFindings,
    ...scriptExecFindings,
  ][0];
  if (deterministicTopicFinding) {
    const riskClass = deterministicTopicFinding.category === "install" ? "high-risk-workaround" : "blocked";
    return terminalResultForDenyFinding(deterministicTopicFinding, [...topicObservations, ...hardFindings, ...checkFindings, deterministicTopicFinding], riskClass, commandHead, blacklistHighlights, checkHighlights, hasInstallWorkaround);
  }

  if (checkFindingForWorkaround && allSegmentsCheckRoutedOrReadOnly(analysis)) {
    const observations = chooseTerminalFinding([...topicObservations, ...hardFindings, ...checkFindings], checkFindingForWorkaround);
    return ensureSingleTerminal({
      terminal: terminalFromFinding(checkFindingForWorkaround, "high-risk-workaround", commandHead, {
        workaroundCategory: checkFindingForWorkaround.category,
        blacklistHighlights,
        reason: `workaround category: ${checkFindingForWorkaround.category}`,
      }),
      observations,
      secondaryHighlights: hardHighlights,
    });
  }

  if (workaroundCategory && allSegmentsCheckRoutedOrReadOnly(analysis)) {
    const installFinding = runInstallRemoteFindings.find((finding) => finding.category === "install");
    const fallbackCategory = workaroundCategory as BashPolicyFinding["category"];
    const fallbackFinding: BashPolicyFinding = installFinding ?? {
      topic: "run-install-remote",
      role: "terminal-candidate",
      kind: "deny",
      name: workaroundCategory,
      category: fallbackCategory,
      reason: `workaround category: ${workaroundCategory}`,
    };
    const fallbackFindings = installFinding
      ? [...topicObservations, ...hardFindings, ...checkFindings]
      : [...topicObservations, ...hardFindings, ...checkFindings, fallbackFinding];
    const observations = chooseTerminalFinding(fallbackFindings, fallbackFinding);
    return ensureSingleTerminal({
      terminal: terminalFromFinding(fallbackFinding, "high-risk-workaround", commandHead, {
        workaroundCategory,
        blacklistHighlights,
        reason: `workaround category: ${workaroundCategory}`,
      }),
      observations,
      secondaryHighlights: checkHighlights,
    });
  }

  const readOnlyFinding = readOnlyPolicyFindings(trimmed)[0];
  if (readOnlyFinding?.kind === "deny") {
    const finding: BashPolicyFinding = {
      ...readOnlyFinding,
      topic: readOnlyFinding.reason === SHELL_REDIRECT_DENY_REASON ? "file-write" : readOnlyFinding.topic,
      role: "terminal-candidate",
      alternative: readOnlyFinding.alternative ?? readOnlyFinding.reason,
    };
    return ensureSingleTerminal({
      terminal: terminalFromFinding(finding, "blocked", commandHead, {
        blacklistHighlights,
      }),
      observations: [finding, ...topicObservations],
      secondaryHighlights: [],
    });
  }

  if (readOnlyFinding?.kind === "allow") {
    const riskClass: BashCommandRiskClass = commandHead && READ_ONLY_HEAVY_BASH_COMMANDS.has(commandHead)
      ? "read-only-heavy"
      : analysis.hasComplexOperator ? "read-only-complex" : "simple-read-only";
    const finding: BashPolicyFinding = {
      ...readOnlyFinding,
      name: riskClass,
    };
    return ensureSingleTerminal({
      terminal: terminalFromFinding(finding, riskClass, commandHead, {
        blacklistHighlights: [],
      }),
      observations: [finding, ...topicObservations],
      secondaryHighlights: [],
    });
  }

  const fallbackFinding: BashPolicyFinding = readOnlyFinding ? {
    ...readOnlyFinding,
    role: "terminal-candidate",
  } : {
    topic: "read-only",
    role: "terminal-candidate",
    kind: "classification",
    name: "non-read-only",
    reason: "command not in read-only allowlist",
  };
  return ensureSingleTerminal({
    terminal: terminalFromFinding(fallbackFinding, "non-read-only-non-workaround", commandHead, {
      blacklistHighlights,
    }),
    observations: [fallbackFinding, ...topicObservations],
    secondaryHighlights: [],
  });
}

export function classifyBashCommand(command: string, workingDir?: string, messages: BashPolicyMessageOptions = DEFAULT_MESSAGES): BashCommandClassification {
  const result = evaluateBashPolicy(command, workingDir, messages);
  return {
    riskClass: result.terminal.riskClass,
    readOnly: result.terminal.readOnly,
    reason: result.terminal.reason,
    alternative: result.terminal.alternative,
    commandHead: result.terminal.commandHead,
    workaroundCategory: result.terminal.workaroundCategory,
    blacklistHighlights: result.terminal.blacklistHighlights ?? [],
    predictionIdentities: result.terminal.predictionIdentities ?? basePredictionIdentities(result.terminal.riskClass, result.terminal.commandHead),
  };
}

export function getCheckRoutedCommandHighlights(toolName: string, toolInput: unknown, workingDir?: string, messages: BashPolicyMessageOptions = DEFAULT_MESSAGES): string[] {
  if (toolName !== "Bash") return [];
  const command = (toolInput as { command?: string }).command;
  if (!command) return [];
  return findCheckRoutedPolicies(command).map((policy) => checkHighlight(policy, workingDir, messages));
}

export function getBlacklistHighlights(toolName: string, toolInput: unknown, workingDir?: string, messages: BashPolicyMessageOptions = DEFAULT_MESSAGES): string[] {
  if (toolName !== "Bash") return [];
  const command = (toolInput as { command?: string }).command;
  if (!command) return [];

  const result = evaluateBashPolicy(command, workingDir, messages);
  const highlights = result.terminal.blacklistHighlights ?? [];
  if (highlights.length > 0) return highlights;

  if (result.terminal.riskClass === "blocked") {
    return [`[BLACKLIST: bash blocked] ${result.terminal.alternative ?? result.terminal.reason ?? "Bash command blocked"}`];
  }
  return [];
}

export function getHardBlacklistHighlights(toolName: string, toolInput: unknown, workingDir?: string, messages: BashPolicyMessageOptions = DEFAULT_MESSAGES): string[] {
  return getBlacklistHighlights(toolName, toolInput, workingDir, messages);
}

export function getBlacklistDescription(messages: BashPolicyMessageOptions = DEFAULT_MESSAGES): string {
  return [...BLACKLIST_PATTERNS, ...CHECK_ROUTED_COMMAND_POLICIES.map((policy) => ({
    name: policy.name,
    alternative: () => checkMcpAction(messages),
  }))]
    .map((pattern) => `- ${pattern.name} → ${
      "pattern" in pattern
        ? patternAlternative(pattern, messages)
        : resolveAlternative(pattern.alternative)
    }`)
    .join("\n");
}

export function detectCheckRoutedWorkaroundCommand(command: string): string | null {
  return detectWorkaroundCommand(command);
}

export function detectWorkaroundPattern(
  toolName: string,
  toolInput: unknown,
): string | null {
  if (toolName !== "Bash") return null;
  const command = (toolInput as { command?: string }).command ?? "";
  return detectWorkaroundCommand(command);
}
