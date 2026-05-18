import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import { extractPlanName, extractPlanfileFooter, PLAN_NAME_RE } from "./planfile.js";
import {
  type MarkdownHeadingMatcher,
  excludeMarkdownSectionBodies,
  matchesMarkdownHeading,
} from "./content-patterns.js";

export type PlanContractFindingKind =
  | "missing_plan_name"
  | "invalid_plan_name"
  | "missing_planfile_footer"
  | "plan_name_footer_mismatch"
  | "planfile_path_mismatch"
  | "missing_required_heading"
  | "wrong_heading_order"
  | "duplicate_required_heading"
  | "extra_level_two_heading"
  | "required_heading_wrong_level"
  | "missing_user_goal_quote"
  | "answered_assumption_missing_source"
  | "generic_verification_heading"
  | "assistant_verification_not_mcp_check"
  | "manual_verification_contains_project_command"
  | "live_option_menu"
  | "schedule_bucket"
  | "unresolved_assumption_language"
  | "weak_or_vague_section_body";

export interface PlanContractFinding {
  kind: PlanContractFindingKind;
  message: string;
  heading?: string;
  line?: number;
}

interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface PlanContractValidationOptions {
  checkMcpWireName?: string;
  excludedContentSections?: readonly MarkdownHeadingMatcher[];
  expectedPlanFile?: string;
  pathBaseDir?: string;
}

const PROJECT_COMMAND_RE =
  /\b(npm|pnpm|yarn|bun|cargo|pytest|vitest|jest|tsc|eslint|prettier|make|just)\b|\bgo\s+test\b|\bmvn\s+test\b/i;
const UNRESOLVED_RE = /\b(assuming|probably|likely|if needed|should be|might|maybe|to be determined|tbd|unknown)\b/i;
const UNRESOLVED_MATCH_RE = /\b(assuming|probably|likely|if needed|should be|might|maybe|to be determined|tbd|unknown)\b/gi;
const LIVE_OPTION_RE = /\b(option|approach|alternative)\s+([A-Z]|\d+):/i;
const SCHEDULE_RE = /\b(week|day|month)\s*\d+:|\b\d+(-\d+)?\s*(days?|weeks?|months?)\b/i;
export function readRequiredFinalPlanHeadings(projectDir: string): string[] {
  void projectDir;
  const envRoot = process.env.AGENT_FRAMEWORK_ROOT;
  if (envRoot) {
    return extractRequiredFinalPlanHeadings(
      fs.readFileSync(path.join(envRoot, "PLANS.md"), "utf-8"),
    );
  }

  const thisFile = url.fileURLToPath(import.meta.url);
  const plansPath = findAgentFrameworkPlansFile(path.dirname(thisFile));
  const content = fs.readFileSync(plansPath, "utf-8");
  return extractRequiredFinalPlanHeadings(content);
}

function findAgentFrameworkPlansFile(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, "PLANS.md");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir, "..", "..", "PLANS.md");
}

export function extractRequiredFinalPlanHeadings(plansMd: string): string[] {
  const lines = plansMd.split("\n");
  const headings: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Required Final Plan Structure\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;
    const match = line.match(/^\s*\d+\.\s+`##\s+([^`]+)`/);
    if (match) headings.push(match[1].trim());
  }
  return headings;
}

export function extractMarkdownPlanPresentation(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  const withoutApprovalQuestion = trimmed.replace(
    /\s*(?:Implement|Approve|Proceed with|Use|Accept)\s+(?:this\s+)?plan\?\s*$/i,
    "",
  ).trim();
  if (withoutApprovalQuestion === trimmed) return null;

  const headings = parseMarkdownHeadings(withoutApprovalQuestion);
  const headingTexts = new Set(headings.map((h) => h.text.toLowerCase()));
  const hasPlanShape =
    headings.some((h) => h.level <= 2 && /plan/i.test(h.text)) ||
    headingTexts.has("summary") ||
    headingTexts.has("key changes") ||
    headingTexts.has("test plan") ||
    headingTexts.has("assumptions") ||
    headingTexts.has("user goal");

  return hasPlanShape ? withoutApprovalQuestion : null;
}

const DEFAULT_EXCLUDED_CONTENT_SECTIONS: readonly MarkdownHeadingMatcher[] = ["User Goal"];

export function validatePlanContract(
  plan: string,
  projectDir: string,
  options: PlanContractValidationOptions = {},
): PlanContractFinding[] {
  let required: string[];
  try {
    required = readRequiredFinalPlanHeadings(projectDir);
  } catch {
    return [];
  }
  if (required.length === 0) return [];
  return validatePlanContractWithRequiredHeadings(plan, required, {
    ...options,
    pathBaseDir: options.pathBaseDir ?? projectDir,
  });
}

export function validatePlanContractWithRequiredHeadings(
  plan: string,
  required: readonly string[],
  options: PlanContractValidationOptions = {},
): PlanContractFinding[] {
  const findings: PlanContractFinding[] = [];
  findings.push(...validatePlanfileMetadata(plan, options.expectedPlanFile, options.pathBaseDir));
  const headings = parseMarkdownHeadings(plan);
  const excludedContentSections =
    options.excludedContentSections ?? DEFAULT_EXCLUDED_CONTENT_SECTIONS;
  const contentCheckedPlan = excludeMarkdownSectionBodies(plan, excludedContentSections);
  const contentCheckedHeadings = parseMarkdownHeadings(contentCheckedPlan);
  const requiredSet = new Set(required);
  const levelTwo = headings.filter((h) => h.level === 2);
  const seen = new Map<string, Heading[]>();

  for (const heading of headings) {
    if (requiredSet.has(heading.text) && heading.level !== 2) {
      findings.push({
        kind: "required_heading_wrong_level",
        heading: heading.text,
        line: heading.line,
        message: `Required heading "${heading.text}" must be a level-two ## heading.`,
      });
    }
  }

  for (const heading of levelTwo) {
    if (!seen.has(heading.text)) seen.set(heading.text, []);
    seen.get(heading.text)!.push(heading);
    if (!requiredSet.has(heading.text)) {
      findings.push({
        kind: "extra_level_two_heading",
        heading: heading.text,
        line: heading.line,
        message: `Extra level-two heading "## ${heading.text}" is not in the required final-plan structure.`,
      });
    }
  }

  for (const requiredHeading of required) {
    const occurrences = seen.get(requiredHeading) ?? [];
    if (occurrences.length === 0) {
      findings.push({
        kind: "missing_required_heading",
        heading: requiredHeading,
        message: `Missing required heading "## ${requiredHeading}".`,
      });
    } else if (occurrences.length > 1) {
      findings.push({
        kind: "duplicate_required_heading",
        heading: requiredHeading,
        line: occurrences[1].line,
        message: `Required heading "## ${requiredHeading}" appears more than once.`,
      });
    }
  }

  const actualRequired = levelTwo
    .filter((h) => requiredSet.has(h.text))
    .map((h) => h.text);
  const expectedPresentOrder = required.filter((h) => actualRequired.includes(h));
  if (actualRequired.join("\n") !== expectedPresentOrder.join("\n")) {
    findings.push({
      kind: "wrong_heading_order",
      message: "Required ## headings are not in the exact planning-contract order.",
    });
  }

  const sections = sectionBodies(plan, levelTwo);
  const userGoal = sections.get("User Goal") ?? "";
  if (userGoal.trim() && !/^>\s*["“]?/m.test(userGoal)) {
    findings.push({
      kind: "missing_user_goal_quote",
      heading: "User Goal",
      message: "User Goal must quote the user's goal verbatim with Markdown blockquote syntax.",
    });
  }

  const assumptions = sections.get("Answered Assumptions") ?? "";
  if (hasSubstantiveBody(assumptions)) {
    for (const item of assumptions.split("\n").filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line))) {
      if (!/\b(source|user text|repository|inspection|documentation|direct user answer|official documentation)\b/i.test(item)) {
        findings.push({
          kind: "answered_assumption_missing_source",
          heading: "Answered Assumptions",
          message: "Each answered assumption must include the source of the answer.",
        });
        break;
      }
    }
  }

  for (const heading of contentCheckedHeadings) {
    if (/^(verification|testing|test plan)\b/i.test(heading.text)) {
      findings.push({
        kind: "generic_verification_heading",
        heading: heading.text,
        line: heading.line,
        message: `"${"#".repeat(heading.level)} ${heading.text}" is a generic verification heading; use the required Assistant Verification and Manual User Verification headings.`,
      });
    }
  }

  const assistantVerification = sections.get("Assistant Verification") ?? "";
  if (
    assistantVerification.trim() &&
    options.checkMcpWireName &&
    !assistantVerification.includes(options.checkMcpWireName)
  ) {
    findings.push({
      kind: "assistant_verification_not_mcp_check",
      heading: "Assistant Verification",
      message: "Assistant Verification must use the agent-framework check MCP with the repository working_dir.",
    });
  }
  if (PROJECT_COMMAND_RE.test(assistantVerification)) {
    findings.push({
      kind: "assistant_verification_not_mcp_check",
      heading: "Assistant Verification",
      message: "Assistant Verification must not list project shell commands; the MCP check owns verification.",
    });
  }

  const manualVerification = sections.get("Manual User Verification") ?? "";
  if (PROJECT_COMMAND_RE.test(manualVerification)) {
    findings.push({
      kind: "manual_verification_contains_project_command",
      heading: "Manual User Verification",
      message: "Manual User Verification must not include project check, lint, test, build, typecheck, format, or package-manager commands.",
    });
  }

  for (const [index, line] of contentCheckedPlan.split("\n").entries()) {
    if (LIVE_OPTION_RE.test(line)) {
      findings.push({
        kind: "live_option_menu",
        line: index + 1,
        message: "Final plans must describe one chosen path, not live Option/Approach/Alternative menus.",
      });
    }
    if (SCHEDULE_RE.test(line)) {
      findings.push({
        kind: "schedule_bucket",
        line: index + 1,
        message: "Final plans must not contain schedule buckets or timeline estimates.",
      });
    }
    if (UNRESOLVED_RE.test(line)) {
      const matches = unresolvedAssumptionMatches(line);
      findings.push({
        kind: "unresolved_assumption_language",
        line: index + 1,
        message: `Final plans must not contain unresolved assumption language. Line ${index + 1} contains ${formatQuotedList(matches)}.`,
      });
    }
  }

  for (const requiredHeading of required) {
    if (excludedContentSections.some((section) => matchesMarkdownHeading(requiredHeading, section))) {
      continue;
    }
    const body = sections.get(requiredHeading);
    if (body === undefined) continue;
    const weakReason = weakSectionReason(requiredHeading, body);
    if (weakReason) {
      findings.push({
        kind: "weak_or_vague_section_body",
        heading: requiredHeading,
        message: `Section "## ${requiredHeading}" is weak or vague: ${weakReason}`,
      });
    }
  }

  return findings;
}

function validatePlanfileMetadata(
  plan: string,
  expectedPlanFile?: string,
  pathBaseDir: string = process.cwd(),
): PlanContractFinding[] {
  const findings: PlanContractFinding[] = [];
  const firstName = extractPlanName(plan);
  const firstNonEmptyLine = firstNonEmptyLineNumber(plan);
  if (!firstName) {
    const firstNonEmpty = plan.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
    findings.push({
      kind: firstNonEmpty.startsWith("Plan Name:") ? "invalid_plan_name" : "missing_plan_name",
      line: firstNonEmptyLine,
      message: "First non-empty line must be `Plan Name: <name>` using lowercase kebab-case.",
    });
  } else if (!PLAN_NAME_RE.test(firstName)) {
    findings.push({
      kind: "invalid_plan_name",
      line: firstNonEmptyLine,
      message: `Invalid plan name "${firstName}"; use lowercase kebab-case.`,
    });
  }

  const footer = extractPlanfileFooter(plan);
  if (!footer) {
    findings.push({
      kind: "missing_planfile_footer",
      message: "Final two non-empty lines must be `Planfile Path: <path>` and `Plan Name: <same-name>`.",
    });
    return findings;
  }

  if (firstName && footer.planName !== firstName) {
    findings.push({
      kind: "plan_name_footer_mismatch",
      message: `Footer plan name "${footer.planName}" must match top plan name "${firstName}".`,
    });
  }

  if (
    expectedPlanFile &&
    resolvePlanfileFooterPath(footer.planFilePath, pathBaseDir) !==
      resolvePlanfileFooterPath(expectedPlanFile, pathBaseDir)
  ) {
    findings.push({
      kind: "planfile_path_mismatch",
      message: `Footer planfile path "${footer.planFilePath}" must match "${expectedPlanFile}".`,
    });
  }

  return findings;
}

function resolvePlanfileFooterPath(planPath: string, baseDir: string): string {
  return path.resolve(path.isAbsolute(planPath) ? planPath : path.join(baseDir, planPath));
}

function firstNonEmptyLineNumber(plan: string): number | undefined {
  const lines = plan.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim().length > 0);
  return index >= 0 ? index + 1 : undefined;
}

function parseMarkdownHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*>/.test(line)) continue;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    headings.push({ level: match[1].length, text: match[2].trim(), line: i + 1 });
  }
  return headings;
}

function sectionBodies(markdown: string, levelTwo: readonly Heading[]): Map<string, string> {
  const lines = markdown.split("\n");
  const sections = new Map<string, string>();
  for (let i = 0; i < levelTwo.length; i++) {
    const current = levelTwo[i];
    const next = levelTwo[i + 1];
    const start = current.line;
    const end = next ? next.line - 1 : lines.length;
    sections.set(current.text, lines.slice(start, end).join("\n"));
  }
  return sections;
}

function hasSubstantiveBody(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  return !/^not applicable\b/i.test(trimmed) && !/^no\b.*required\b/i.test(trimmed);
}

function unresolvedAssumptionMatches(line: string): string[] {
  return [...new Set([...line.matchAll(UNRESOLVED_MATCH_RE)].map((match) => match[1]))];
}

function formatQuotedList(values: readonly string[]): string {
  if (values.length === 0) return "a banned unresolved-assumption phrase";
  if (values.length === 1) return `"${values[0]}"`;
  const quoted = values.map((value) => `"${value}"`);
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

function weakSectionReason(heading: string, body: string): string | null {
  if (heading === "User Goal" && /^>\s*["“]?/m.test(body)) return null;
  const stripped = body
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .join(" ");
  const normalized = stripped.toLowerCase();
  if (!normalized) return "the body is empty";
  if (/^(n\/a|none|todo|tbd|placeholder|not sure)\.?$/.test(normalized)) {
    return "the body is a placeholder";
  }
  if (/^not applicable\.?$/.test(normalized)) {
    return "not applicable sections must state why they are not applicable";
  }
  if (normalized.split(/\s+/).length < 5) {
    return "the body is extremely short";
  }
  if (/\b(update|modify|change|adjust|fix|handle|stuff|things|as needed|etc\.?)\b/i.test(stripped) &&
      !/[`/]/.test(stripped) &&
      !/\bsrc\/|\badapters\/|\btests\//.test(stripped)) {
    return "the body uses generic verbs without concrete files, symbols, or details";
  }
  if (heading === "Data Flow" && !/not required because/i.test(stripped) && !/[|+>\-]/.test(stripped)) {
    return "non-trivial plans need an ASCII data-flow diagram or a reason it is not required";
  }
  return null;
}
