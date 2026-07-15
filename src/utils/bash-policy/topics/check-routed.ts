import {
  analyzeBashCommand,
  splitShellSegments,
} from "../analysis.js";
import { parseShellOptionArguments } from "../../shell-command-parser.js";
import { contentCommandCandidate, policyTarget } from "../helpers.js";
import { INSTALL_WORKAROUND_VARIANTS } from "../constants.js";
import type { BashAnalysis, BashInvocation, BashPolicyFinding, CheckRoutedCommandPolicy } from "../types.js";

function isCargoSubcommand(invocation: BashInvocation, subcommands: ReadonlySet<string>): boolean {
  if (invocation.executable !== "cargo") return false;
  const [first, second] = invocation.args;
  const subcommand = first?.startsWith("+") ? second : first;
  return subcommand !== undefined && subcommands.has(subcommand);
}

const NPM_RUN_LIKE = new Set(["npm", "pnpm", "yarn", "bun"]);
const EXEC_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["--package", "-p"]);
const NPX_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["--package", "-p", "--cache", "--userconfig"]);
const MAKE_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["-C", "-f", "--file", "--makefile", "-I", "--include-dir"]);
const JUST_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["-f", "--justfile", "--working-directory", "-d", "--set", "--shell", "--shell-arg"]);

function packageManagerScript(invocation: BashInvocation, scripts: ReadonlySet<string>): boolean {
  if (!NPM_RUN_LIKE.has(invocation.executable)) return false;
  const args = invocation.args;
  if (args.length === 0) return false;
  if (invocation.executable === "npm") {
    if (args[0] === "run") return !!args[1] && scripts.has(args[1]);
    return args[0] === "test" && scripts.has("test");
  }
  if (invocation.executable === "bun") {
    if (args[0] === "run") return !!args[1] && scripts.has(args[1]);
    return args[0] === "test" && scripts.has("test");
  }
  if (args[0] === "run") return !!args[1] && scripts.has(args[1]);
  return scripts.has(args[0]);
}

function execTarget(invocation: BashInvocation): string | null {
  const args = invocation.args;
  if (args[0] !== "exec") return null;
  return parseShellOptionArguments(args.slice(1), {
    optionsWithOneValue: EXEC_OPTIONS_WITH_VALUE,
  })[0] ?? null;
}

function npxTarget(invocation: BashInvocation): string | null {
  if (invocation.executable !== "npx" && invocation.executable !== "bunx") return null;
  return parseShellOptionArguments(invocation.args, {
    optionsWithOneValue: NPX_OPTIONS_WITH_VALUE,
  })[0] ?? null;
}

function targetBinary(invocation: BashInvocation): string {
  return npxTarget(invocation) ?? execTarget(invocation) ?? invocation.executable;
}

function matchesTsc(invocation: BashInvocation): boolean {
  const binary = targetBinary(invocation);
  return binary === "tsc";
}

function matchesDirect(invocation: BashInvocation, names: ReadonlySet<string>): boolean {
  return names.has(targetBinary(invocation));
}

function makeJustTargetArg(invocation: BashInvocation, executable: "make" | "just"): string | null {
  if (invocation.executable !== executable) return null;
  const optionsWithValue = executable === "make" ? MAKE_OPTIONS_WITH_VALUE : JUST_OPTIONS_WITH_VALUE;
  return parseShellOptionArguments(invocation.args, {
    optionsWithOneValue: optionsWithValue,
  })[0] ?? null;
}

function makeJustTarget(invocation: BashInvocation, executable: "make" | "just", targets: ReadonlySet<string>): boolean {
  const target = makeJustTargetArg(invocation, executable);
  return target !== null && targets.has(target);
}

const TYPECHECK_SCRIPTS = new Set(["check", "typecheck"]);
const BUILD_SCRIPTS = new Set(["build"]);
const LINT_SCRIPTS = new Set(["lint"]);
const TEST_SCRIPTS = new Set(["test"]);
const FORMAT_SCRIPTS = new Set(["fmt", "format"]);

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type ScriptRunMode = "required" | "optional";

interface PackageManagerPolicySpec {
  pm: PackageManager;
  scripts: ReadonlySet<string>;
  runMode: ScriptRunMode;
  name: string;
  category: CheckRoutedCommandPolicy["category"];
  equivalents: string[];
}

function scriptPattern(pm: PackageManager, scripts: ReadonlySet<string>, runMode: ScriptRunMode): RegExp {
  const scriptAlternation = [...scripts].join("|");
  const runPart = runMode === "required" ? "run\\s+" : "(?:run\\s+)?";
  return new RegExp(`^${pm}\\s+${runPart}(?:${scriptAlternation})\\b`);
}

function packageManagerVariants(pm: PackageManager, scripts: ReadonlySet<string>, runMode: ScriptRunMode): string[] {
  return [...scripts].flatMap((script) =>
    runMode === "required" ? [`${pm} run ${script}`] : [`${pm} ${script}`, `${pm} run ${script}`]
  );
}

function packageManagerPolicy(spec: PackageManagerPolicySpec): CheckRoutedCommandPolicy {
  return {
    pattern: scriptPattern(spec.pm, spec.scripts, spec.runMode),
    invocationMatcher: (i) => i.executable === spec.pm && packageManagerScript(i, spec.scripts),
    name: spec.name,
    category: spec.category,
    variants: packageManagerVariants(spec.pm, spec.scripts, spec.runMode),
    equivalents: spec.equivalents,
    redactPaths: true,
  };
}

function packageManagerPolicies(specs: PackageManagerPolicySpec[]): CheckRoutedCommandPolicy[] {
  return specs.map(packageManagerPolicy);
}

const TYPECHECK_PACKAGE_MANAGER_POLICIES = packageManagerPolicies([
  { pm: "npm", scripts: TYPECHECK_SCRIPTS, runMode: "required", name: "npm check/typecheck", category: "type-check", equivalents: ["tsc", "npx tsc", "typecheck"] },
  { pm: "pnpm", scripts: TYPECHECK_SCRIPTS, runMode: "optional", name: "pnpm check/typecheck", category: "type-check", equivalents: ["tsc", "npx tsc", "typecheck"] },
  { pm: "yarn", scripts: TYPECHECK_SCRIPTS, runMode: "optional", name: "yarn check/typecheck", category: "type-check", equivalents: ["tsc", "npx tsc", "typecheck"] },
  { pm: "bun", scripts: TYPECHECK_SCRIPTS, runMode: "required", name: "bun check/typecheck", category: "type-check", equivalents: ["tsc", "typecheck"] },
]);

const BUILD_PACKAGE_MANAGER_POLICIES = packageManagerPolicies([
  { pm: "npm", scripts: BUILD_SCRIPTS, runMode: "required", name: "npm build", category: "build", equivalents: ["tsc", "npx tsc", "npm run build"] },
  { pm: "pnpm", scripts: BUILD_SCRIPTS, runMode: "optional", name: "pnpm build", category: "build", equivalents: ["tsc", "pnpm build", "pnpm run build"] },
  { pm: "yarn", scripts: BUILD_SCRIPTS, runMode: "optional", name: "yarn build", category: "build", equivalents: ["tsc", "yarn build", "yarn run build"] },
  { pm: "bun", scripts: BUILD_SCRIPTS, runMode: "required", name: "bun build", category: "build", equivalents: ["tsc", "bun run build"] },
]);

const LINT_PACKAGE_MANAGER_POLICIES = packageManagerPolicies([
  { pm: "npm", scripts: LINT_SCRIPTS, runMode: "required", name: "npm lint", category: "lint", equivalents: ["eslint", "lint", "prettier"] },
  { pm: "pnpm", scripts: LINT_SCRIPTS, runMode: "optional", name: "pnpm lint", category: "lint", equivalents: ["eslint", "lint", "prettier"] },
  { pm: "yarn", scripts: LINT_SCRIPTS, runMode: "optional", name: "yarn lint", category: "lint", equivalents: ["eslint", "lint", "prettier"] },
  { pm: "bun", scripts: LINT_SCRIPTS, runMode: "required", name: "bun lint", category: "lint", equivalents: ["eslint", "lint", "prettier"] },
]);

const FORMAT_PACKAGE_MANAGER_POLICIES = packageManagerPolicies([
  { pm: "npm", scripts: FORMAT_SCRIPTS, runMode: "required", name: "npm format", category: "format", equivalents: ["prettier", "format", "fmt", "check"] },
  { pm: "pnpm", scripts: FORMAT_SCRIPTS, runMode: "optional", name: "pnpm format", category: "format", equivalents: ["prettier", "format", "fmt", "check"] },
  { pm: "yarn", scripts: FORMAT_SCRIPTS, runMode: "optional", name: "yarn format", category: "format", equivalents: ["prettier", "format", "fmt", "check"] },
  { pm: "bun", scripts: FORMAT_SCRIPTS, runMode: "required", name: "bun format", category: "format", equivalents: ["prettier", "format", "fmt", "check"] },
]);

export const CHECK_ROUTED_COMMAND_POLICIES: CheckRoutedCommandPolicy[] = [
  { pattern: /^make\s+check\b/, invocationMatcher: (i) => makeJustTarget(i, "make", new Set(["check"])), name: "make check", category: "type-check", variants: ["make check"], equivalents: ["check"], redactPaths: true },
  { pattern: /^just\s+check\b/, invocationMatcher: (i) => makeJustTarget(i, "just", new Set(["check"])), name: "just check", category: "type-check", variants: ["just check"], equivalents: ["check"], redactPaths: true },
  ...TYPECHECK_PACKAGE_MANAGER_POLICIES,
  { pattern: /^cargo\s+check\b/, invocationMatcher: (i) => isCargoSubcommand(i, new Set(["check"])), name: "cargo check", category: "type-check", variants: ["cargo check"], equivalents: ["cargo check", "cargo clippy"], redactPaths: true },
  { pattern: /^(?:npx\s+)?tsc\b/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?(?:npx\s+)?tsc\b|\bnpx\s+tsc\b|\btsc\s+(?:-[\w-]+|<PATH>))/, invocationMatcher: matchesTsc, name: "tsc", category: "type-check", variants: ["tsc", "npx tsc", "npx --yes tsc", "npx -y tsc", "npx --package typescript tsc", "npm exec tsc", "npm exec --package typescript tsc", "pnpm exec tsc", "yarn exec tsc", "bunx tsc", "bunx --yes tsc"], equivalents: ["tsc", "npx tsc"], redactPaths: true },

  { pattern: /^make\s+build\b/, invocationMatcher: (i) => makeJustTarget(i, "make", new Set(["build"])), name: "make build", category: "build", variants: ["make build"], equivalents: ["make build", "cargo check", "tsc"], redactPaths: true },
  { pattern: /^just\s+build\b/, invocationMatcher: (i) => makeJustTarget(i, "just", new Set(["build"])), name: "just build", category: "build", variants: ["just build"], equivalents: ["just build", "cargo check", "tsc"], redactPaths: true },
  ...BUILD_PACKAGE_MANAGER_POLICIES,
  { pattern: /^cargo\s+build\b/, invocationMatcher: (i) => isCargoSubcommand(i, new Set(["build"])), name: "cargo build", category: "build", variants: ["cargo build"], equivalents: ["cargo check", "cargo clippy"], redactPaths: true },

  { pattern: /^cargo\s+clippy\b/, invocationMatcher: (i) => isCargoSubcommand(i, new Set(["clippy"])), name: "cargo clippy", category: "lint", variants: ["cargo clippy"], equivalents: ["cargo clippy"], redactPaths: true },
  ...LINT_PACKAGE_MANAGER_POLICIES,
  { pattern: /^eslint\b/, invocationMatcher: (i) => matchesDirect(i, new Set(["eslint"])), name: "eslint", category: "lint", variants: ["eslint"], equivalents: ["eslint", "lint"], redactPaths: true },

  { pattern: /^(?:(?:npx\s+)?(?:vitest|jest|mocha|ava)|pytest|(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test|(?:npx|cargo)\s+test)\b/, invocationMatcher: (i) => isCargoSubcommand(i, new Set(["test"])) || packageManagerScript(i, TEST_SCRIPTS) || matchesDirect(i, new Set(["vitest", "jest", "mocha", "ava", "pytest", "test"])), name: "test command", category: "test", variants: ["test", "vitest", "npx vitest", "jest", "npx jest", "mocha", "npx mocha", "pytest", "ava", "npx ava", "npm test", "npm run test", "yarn test", "yarn run test", "pnpm test", "pnpm run test", "bun test", "bun run test", "npx test", "cargo test"], equivalents: ["vitest", "jest", "pytest", "cargo test", "test", "mocha", "ava"], bashOnly: true, redactPaths: true },

  { pattern: /^cargo\s+fmt\b/, invocationMatcher: (i) => isCargoSubcommand(i, new Set(["fmt"])), name: "cargo fmt", category: "format", variants: ["cargo fmt"], equivalents: ["cargo fmt", "rustfmt", "fmt", "format", "check"], redactPaths: true },
  { pattern: /^rustfmt\b/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?rustfmt\b|\brustfmt\s+(?:-[\w-]+|<PATH>))/, invocationMatcher: (i) => matchesDirect(i, new Set(["rustfmt"])), name: "rustfmt", category: "format", variants: ["rustfmt"], equivalents: ["rustfmt", "cargo fmt", "fmt", "format", "check"], redactPaths: true },
  { pattern: /^(?:npx\s+)?prettier\b/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?(?:npx\s+)?prettier\b|\bprettier\s+(?:-[\w-]+|<PATH>))/, invocationMatcher: (i) => matchesDirect(i, new Set(["prettier"])), name: "prettier", category: "format", variants: ["prettier", "npx prettier"], equivalents: ["prettier", "format", "fmt", "check"], redactPaths: true },
  ...FORMAT_PACKAGE_MANAGER_POLICIES,
  { pattern: /^(?:make|just)\s+(?:fmt|format)\b/, invocationMatcher: (i) => (i.executable === "make" || i.executable === "just") && makeJustTarget(i, i.executable, FORMAT_SCRIPTS), name: "make/just format", category: "format", variants: ["make fmt", "make format", "just fmt", "just format"], equivalents: ["fmt", "format", "check"], redactPaths: true },
  { pattern: /^(?:npx\s+)?biome\s+(?:format|check)\b/, invocationMatcher: (i) => targetBinary(i) === "biome" && (i.args.includes("format") || i.args.includes("check")), name: "biome format/check", category: "format", variants: ["biome format", "biome check", "npx biome format", "npx biome check"], equivalents: ["biome format", "biome check", "format", "fmt", "check"], redactPaths: true },
  { pattern: /^dprint\b/, invocationMatcher: (i) => matchesDirect(i, new Set(["dprint"])), name: "dprint", category: "format", variants: ["dprint"], equivalents: ["dprint", "format", "fmt", "check"], redactPaths: true },
  { pattern: /^treefmt\b/, invocationMatcher: (i) => matchesDirect(i, new Set(["treefmt"])), name: "treefmt", category: "format", variants: ["treefmt"], equivalents: ["treefmt", "format", "fmt", "check"], redactPaths: true },
  { pattern: /^nix\s+fmt\b/, invocationMatcher: (i) => i.executable === "nix" && i.args[0] === "fmt", name: "nix fmt", category: "format", variants: ["nix fmt"], equivalents: ["nix fmt", "format", "fmt", "check"], redactPaths: true },
  { pattern: /^alejandra\b/, invocationMatcher: (i) => matchesDirect(i, new Set(["alejandra"])), name: "alejandra", category: "format", variants: ["alejandra"], equivalents: ["alejandra", "format", "fmt", "check"], redactPaths: true },
];

export function matchCheckRoutedPolicyInCommand(command: string, policy: CheckRoutedCommandPolicy, analysis?: BashAnalysis): boolean {
  const regexTarget = policyTarget(command, policy.redactPaths);
  const regexMatch = splitShellSegments(regexTarget).segments.some((segment) => policy.pattern.test(segment.trim()));
  if (regexMatch) return true;
  if (policy.commandMatcher?.(regexTarget)) return true;
  if (!policy.invocationMatcher) return false;
  const commandAnalysis = analysis ?? analyzeBashCommand(command);
  return commandAnalysis.invocations.some((invocation) => policy.invocationMatcher?.(invocation) === true);
}

export function matchCheckRoutedPolicyInContent(line: string, policy: CheckRoutedCommandPolicy, redactedLine: string): boolean {
  const rawCandidate = contentCommandCandidate(line);
  const redactedCandidate = contentCommandCandidate(redactedLine);
  const target = policy.redactPaths ? redactedCandidate : rawCandidate;
  const afterRun = target.replace(/^.*?\brun\s+/i, "");
  const re = policy.contentPattern ?? policy.pattern;
  return re.test(target) ||
    re.test(afterRun) ||
    splitShellSegments(target).segments.some((segment) => policy.pattern.test(segment.trim())) ||
    splitShellSegments(afterRun).segments.some((segment) => policy.pattern.test(segment.trim())) ||
    matchCheckRoutedPolicyInCommand(target, policy) ||
    matchCheckRoutedPolicyInCommand(afterRun, policy);
}

export function findCheckRoutedPolicies(command: string, analysis?: BashAnalysis): CheckRoutedCommandPolicy[] {
  return CHECK_ROUTED_COMMAND_POLICIES.filter((policy) => matchCheckRoutedPolicyInCommand(command, policy, analysis));
}

export function checkRoutedPolicyFindings(command: string, analysis?: BashAnalysis): BashPolicyFinding[] {
  return checkRoutedPolicyFindingsFromPolicies(findCheckRoutedPolicies(command, analysis));
}

export function checkRoutedPolicyFindingsFromPolicies(policies: CheckRoutedCommandPolicy[]): BashPolicyFinding[] {
  return policies.map((policy) => ({
    topic: "check-routed",
    role: "terminal-candidate",
    kind: "route-to-check",
    name: policy.name,
    category: policy.category,
    reason: policy.name,
    equivalents: policy.equivalents,
    predictionIdentities: ["Bash", "Bash:high-risk-workaround", `Bash:${policy.category}`],
  }));
}

export const CHECK_EQUIVALENTS: Record<string, string[]> = Object.fromEntries(
  CHECK_ROUTED_COMMAND_POLICIES.map((policy) => [policy.name, policy.equivalents]),
);

export const WORKAROUND_PATTERNS: Record<string, { variants: string[]; redactPaths?: boolean }> = CHECK_ROUTED_COMMAND_POLICIES
  .reduce<Record<string, { variants: string[]; redactPaths?: boolean }>>((acc, policy) => {
    const existing = acc[policy.category] ?? { variants: [], redactPaths: true };
    existing.variants.push(...policy.variants);
    acc[policy.category] = existing;
    return acc;
  }, {
    install: {
      variants: [...INSTALL_WORKAROUND_VARIANTS],
      redactPaths: true,
    },
  });

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsCommandVariant(command: string, variant: string): boolean {
  const trimmed = variant.trim();
  if (!trimmed) return false;
  const escaped = escapeRegExp(trimmed).replace(/\\\s+/g, "\\s+");
  const re = new RegExp(`(?:^|[\\s;&|])${escaped}(?=$|[\\s;&|])`);
  return re.test(command);
}

export function detectWorkaroundCommand(command: string): string | null {
  for (const [category, { variants, redactPaths: shouldRedact }] of Object.entries(WORKAROUND_PATTERNS)) {
    const target = policyTarget(command, shouldRedact);
    if (variants.some((v) => containsCommandVariant(target, v))) return category;
  }
  return null;
}
