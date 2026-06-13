export type CheckRoutedCategory = "type-check" | "build" | "lint" | "format" | "test";

export type BashPolicyTopic =
  | "git"
  | "check-routed"
  | "read-only"
  | "file-write"
  | "script-exec"
  | "run-install-remote"
  | "find-sed";

export type BashPolicyFindingRole = "observation" | "terminal-candidate";
export type BashPolicyFindingKind = "allow" | "deny" | "route-to-check" | "classification";

export type BashInvocationSource = "direct" | "shell-payload" | "eval-payload" | "xargs-payload";

export interface BashInvocation {
  segment: string;
  tokens: string[];
  executable: string;
  args: string[];
  wrapperChain: string[];
  source: BashInvocationSource;
}

export interface BashSegmentAnalysis {
  segment: string;
  tokens: string[];
  invocation: BashInvocation | null;
}

export interface BashAnalysis {
  command: string;
  trimmed: string;
  segments: BashSegmentAnalysis[];
  backgrounded: boolean;
  hasComplexOperator: boolean;
  invocations: BashInvocation[];
}

export interface BashPolicyFinding {
  topic: BashPolicyTopic;
  role: BashPolicyFindingRole;
  kind: BashPolicyFindingKind;
  name: string;
  category?: CheckRoutedCategory | "install" | "run" | "git-write";
  reason: string;
  alternative?: string;
  equivalents?: string[];
  predictionIdentities?: string[];
}

export type BashCommandRiskClass =
  | "blocked"
  | "simple-read-only"
  | "read-only-heavy"
  | "read-only-complex"
  | "high-risk-workaround"
  | "non-read-only-non-workaround";

export interface BashTerminalDecision {
  ownerTopic: BashPolicyTopic | "fallback";
  ownerName: string;
  riskClass: BashCommandRiskClass;
  readOnly: boolean;
  reason?: string;
  alternative?: string;
  commandHead?: string;
  workaroundCategory?: string;
  predictionIdentities?: string[];
  blacklistHighlights?: string[];
}

export interface BashPolicyResult {
  terminal: BashTerminalDecision;
  observations: BashPolicyFinding[];
  secondaryHighlights: string[];
}

export interface BashCommandClassification {
  riskClass: BashCommandRiskClass;
  readOnly: boolean;
  reason?: string;
  alternative?: string;
  commandHead?: string;
  workaroundCategory?: string;
  blacklistHighlights: string[];
  predictionIdentities: string[];
}

export interface BlacklistPattern {
  pattern: RegExp;
  contentPattern?: RegExp;
  commandMatcher?: (command: string) => boolean;
  contentMatcher?: (content: string) => boolean;
  name: string;
  alternative: string | (() => string);
  bashOnly?: boolean;
  redactPaths?: boolean;
  topic?: BashPolicyTopic;
}

export interface CheckRoutedCommandPolicy {
  pattern: RegExp;
  contentPattern?: RegExp;
  commandMatcher?: (command: string) => boolean;
  invocationMatcher?: (invocation: BashInvocation) => boolean;
  name: string;
  category: CheckRoutedCategory;
  variants: string[];
  equivalents: string[];
  bashOnly?: boolean;
  redactPaths?: boolean;
}

export interface BashPolicyMessageOptions {
  checkMcpAction?: string;
  renderCheckMessage?: (policy: CheckRoutedCommandPolicy, workingDir?: string) => string;
  gitWorkflowAlternative?: string;
}

export interface BlacklistHighlight {
  lineIndex: number;
  line: string;
  message: string;
  rendered: string;
}

export interface ContentBlacklistOptions {
  inverseCodeBlocks?: boolean;
  checkMcpMessage?: string;
  gitWorkflowMessage?: string;
}
