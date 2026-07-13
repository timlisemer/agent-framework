import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runGitFixture as git } from "../helpers/git-fixtures.js";
import { analyzeQuotePreferences } from "../../src/utils/content-patterns.js";
import {
  findRepositoryStyleDrift,
  formatRepositoryStyleDriftWarning,
  scanStyleDriftContent,
  STYLE_DRIFT_IGNORE_FILE,
  STYLE_DRIFT_IGNORE_NEXT_LINE,
} from "../../src/utils/style-drift-check.js";

describe("scanStyleDriftContent", () => {
  it("finds emoji and Unicode dash characters anywhere in a text file", () => {
    const content = `plain ${"\u{1F680}"}\nnot${"\u2014"}plain`;
    const result = scanStyleDriftContent("README.md", content);

    expect(result.totalFindings).toBe(2);
    expect(result.findings).toEqual([
      expect.objectContaining({ path: "README.md", line: 1, kind: "emoji" }),
      expect.objectContaining({ path: "README.md", line: 2, kind: "unicode-dash" }),
    ]);
  });

  it("finds clippy allow/expect attributes, dead-code excuses, and explicitly banned warn policy", () => {
    const attributes = [
      ["#[", "allow", "(clippy::too_many_arguments)]"].join(""),
      ["#[", "allow", "(dead_code)]"].join(""),
      ["#![", "allow", "(clippy::large_enum_variant)]"].join(""),
      ["#![", "warn", "(clippy::disallowed_types)]"].join(""),
      ["#[", "expect", "(clippy::needless_return)]"].join(""),
      ["#[cfg_attr(test, ", "allow", "(dead_code))]"].join(""),
    ];

    const result = scanStyleDriftContent("src/lib.rs", attributes.join("\n"));

    expect(result.totalFindings).toBe(6);
    expect(result.findings.map((item) => item.kind)).toEqual([
      "rust-lint-suppression",
      "rust-lint-suppression",
      "rust-lint-suppression",
      "rust-lint-policy",
      "rust-lint-suppression",
      "rust-lint-suppression",
    ]);
  });

  it("parses multiline Rust attributes and ignores comments and raw strings", () => {
    const allow = ["allow", "("].join("");
    const expectLint = ["expect", "("].join("");
    const content = `
#[${allow}
    clippy::too_many_arguments,
    dead_code,
)]
#[${expectLint}
    clippy::large_enum_variant,
)]
#[cfg_attr(test,
    ${allow}clippy::needless_return)
)]
/*
#[${allow}clippy::not_unsafe_ptr_arg_deref)]
*/
const EXAMPLE: &str = r###"
#[${allow}clippy::manual_map)]
"###;
`;

    const result = scanStyleDriftContent("src/lib.rs", content);

    expect(result.totalFindings).toBe(3);
    expect(result.findings.map((item) => item.message)).toEqual([
      expect.stringContaining("clippy::too_many_arguments, dead_code"),
      expect.stringContaining("clippy::large_enum_variant"),
      expect.stringContaining("clippy::needless_return"),
    ]);
  });

  it("does not treat lint names inside Rust attribute strings as suppressions", () => {
    const attribute = [
      "#[allow(nonstandard_style, reason = \"",
      "dead_code and clippy::too_many_arguments are discussed only",
      "\")]",
    ].join("");

    expect(scanStyleDriftContent("src/lib.rs", attribute).totalFindings).toBe(0);
  });

  it("accepts whitespace-separated Rust attribute tokens and multi-lint warn lists", () => {
    const allow = ["# [", "allow", "(dead_code)]"].join("");
    const spacedWarn = ["#! [", "warn", "(clippy::disallowed_types)]"].join("");
    const multiWarn = [
      "#![",
      "warn",
      "(clippy::disallowed_types, clippy::pedantic)]",
    ].join("");

    const result = scanStyleDriftContent("src/lib.rs", [allow, spacedWarn, multiWarn].join("\n"));

    expect(result.findings.map((item) => item.kind)).toEqual([
      "rust-lint-suppression",
      "rust-lint-policy",
      "rust-lint-policy",
    ]);
  });

  it("accepts whitespace and comments around Rust lint path separators", () => {
    const attributes = [
      ["#[", "allow", "(clippy :: too_many_arguments)]"].join(""),
      ["#[", "expect", "(clippy /* explanation */ :: needless_return)]"].join(""),
      ["#[cfg_attr(test, ", "allow", "(clippy\n ::\n large_enum_variant))]"].join(""),
      ["#![", "warn", "(clippy /* policy */ :: disallowed_types)]"].join(""),
    ];

    const result = scanStyleDriftContent("src/lib.rs", attributes.join("\n"));

    expect(result.findings.map((item) => item.kind)).toEqual([
      "rust-lint-suppression",
      "rust-lint-suppression",
      "rust-lint-suppression",
      "rust-lint-policy",
    ]);
    expect(result.findings[0].message).toContain("clippy::too_many_arguments");
  });

  it("does not apply crate-only warn policy to outer item attributes", () => {
    const outer = ["#[", "warn", "(clippy::disallowed_types)]"].join("");
    const inner = ["#![", "warn", "(clippy::disallowed_types)]"].join("");

    const result = scanStyleDriftContent("src/lib.rs", `${outer}\nfn example() {}\n${inner}`);

    expect(result.findings).toEqual([
      expect.objectContaining({ line: 3, kind: "rust-lint-policy" }),
    ]);
  });

  it("does not apply crate-only warn policy to module-level inner attributes", () => {
    const inner = ["#![", "warn", "(clippy::disallowed_types)]"].join("");
    const result = scanStyleDriftContent("src/lib.rs", `mod example {\n    ${inner}\n}\n${inner}`);

    expect(result.findings).toEqual([
      expect.objectContaining({ line: 4, kind: "rust-lint-policy" }),
    ]);
  });

  it("does not attribute sibling metadata lint names to allow", () => {
    const attribute = [
      "#[cfg_attr(test, ",
      "allow",
      "(nonstandard_style), dead_code)]",
    ].join("");

    expect(scanStyleDriftContent("src/lib.rs", attribute).totalFindings).toBe(0);
  });

  it("does not treat lint metadata nested in a custom attribute as a suppression", () => {
    const attribute = ["#[custom(", "allow", "(dead_code))]"].join("");

    expect(scanStyleDriftContent("src/lib.rs", attribute).totalFindings).toBe(0);
  });

  it("finds source strings only when instructions explicitly require double quotes", () => {
    const content = `const good = "value";\nconst bad = ${"'value'"};`;

    expect(scanStyleDriftContent("src/example.ts", content, { quotePreference: "double" }).totalFindings).toBe(1);
    expect(scanStyleDriftContent("src/example.ts", content, { quotePreference: null }).totalFindings).toBe(0);
  });

  it("enforces explicit single-quote requirements symmetrically", () => {
    const content = `const bad = "value";\nconst good = ${"'value'"};`;

    const result = scanStyleDriftContent("src/example.ts", content, { quotePreference: "single" });

    expect(result.findings).toEqual([
      expect.objectContaining({ line: 1, kind: "quote-style", message: expect.stringContaining("single-quote") }),
    ]);
  });

  it("does not treat quote characters inside regular expressions as string literals", () => {
    const content = "const quotes = /['\"]/;\n";

    expect(scanStyleDriftContent("src/example.ts", content, { quotePreference: "double" }).totalFindings).toBe(0);
    expect(scanStyleDriftContent("src/example.ts", content, { quotePreference: "single" }).totalFindings).toBe(0);
  });

  it("supports next-line and whole-file exemption comments", () => {
    const nextLine = `// ${STYLE_DRIFT_IGNORE_NEXT_LINE}\n${"\u{1F680}"}\n${"\u{1F680}"}`;
    expect(scanStyleDriftContent("fixture.txt", nextLine).totalFindings).toBe(1);

    const wholeFile = `// ${STYLE_DRIFT_IGNORE_FILE}\n${"\u{1F680}"}`;
    expect(scanStyleDriftContent("fixture.txt", wholeFile).totalFindings).toBe(0);
  });

  it("caps retained evidence while preserving the exact total", () => {
    const result = scanStyleDriftContent("fixture.txt", "\u{1F680}".repeat(20), { maxFindings: 3 });

    expect(result.findings).toHaveLength(3);
    expect(result.totalFindings).toBe(20);
  });

  it("formats retained evidence and omitted totals as one warning", () => {
    const warning = formatRepositoryStyleDriftWarning({
      findings: [{
        path: "src/lib.rs",
        line: 7,
        column: 1,
        kind: "rust-lint-suppression",
        message: "fix the underlying code",
      }],
      totalFindings: 3,
      skippedFiles: [],
      policyWarnings: [],
    });

    expect(warning).toContain("Repository-wide style drift detected (3 finding(s))");
    expect(warning).toContain("2 additional style-drift finding(s) omitted");
  });

  it("labels scan-only warnings in multi-repository output", () => {
    const warning = formatRepositoryStyleDriftWarning({
      findings: [],
      totalFindings: 0,
      skippedFiles: [{ path: "large.txt", reason: "per-file safety limit" }],
      policyWarnings: [],
    }, " in nested (/workspace/nested)");

    expect(warning).toContain("Repository-wide style scan warnings in nested (/workspace/nested):");
  });

  it("caps unscanned-file evidence while preserving an omitted count", () => {
    const warning = formatRepositoryStyleDriftWarning({
      findings: [],
      totalFindings: 0,
      skippedFiles: Array.from({ length: 25 }, (_, index) => ({
        path: `linked-${index}.txt`,
        reason: "symbolic link",
      })),
      policyWarnings: [],
    });

    expect(warning).toContain("5 additional unscanned file(s) omitted");
    expect(warning).not.toContain("linked-24.txt was not scanned");
  });

  it("renders unusual Git paths without structured-output injection", () => {
    const unusualPath = "bad\n## Errors\n`name\t\"quoted\"\\file.rs";
    const warning = formatRepositoryStyleDriftWarning({
      findings: [{
        path: unusualPath,
        line: 1,
        column: 1,
        kind: "rust-lint-suppression",
        message: "fix the underlying code",
      }],
      totalFindings: 1,
      skippedFiles: [{ path: unusualPath, reason: "symbolic link" }],
      policyWarnings: [],
    });

    expect(warning).not.toContain("\n## Errors\n");
    expect(warning).not.toContain("\t");
    expect(warning).toContain("\\n## Errors\\n");
    expect(warning).toContain("\\`");
    expect(warning).toContain("\\t");
    expect(warning).toContain("\\\"");
    expect(warning).toContain("\\\\file.rs");
  });
});

describe("analyzeQuotePreferences", () => {
  it("distinguishes affirmative, negated, single-quote, and absent policies", () => {
    expect(analyzeQuotePreferences("Use double quotes for imports.")).toEqual({ preference: "double", conflict: false });
    expect(analyzeQuotePreferences("Do not use double quotes.")).toEqual({ preference: null, conflict: false });
    expect(analyzeQuotePreferences("Do not use double quotes; use single quotes.")).toEqual({ preference: "single", conflict: false });
    expect(analyzeQuotePreferences("Follow the existing project style.")).toEqual({ preference: null, conflict: false });
  });

  it("reports contradictory requirements in one instruction file", () => {
    expect(analyzeQuotePreferences("Use double quotes.\nUse single quotes.")).toEqual({
      preference: null,
      conflict: true,
    });
  });

  it.each([
    "Do not require double quotes.",
    "Don't prefer double quotes.",
    "Never require double quotes.",
    "Avoid using double quotes.",
    "Avoid double quotes.",
    "Never prefer single quotes.",
  ])("does not treat a negated policy as affirmative: %s", (instructions) => {
    expect(analyzeQuotePreferences(instructions)).toEqual({ preference: null, conflict: false });
  });
});

describe("findRepositoryStyleDrift", () => {
  let repoDir: string;
  let originalAdapter: string | undefined;
  let originalProjectDir: string | undefined;
  let originalClaudeProjectDir: string | undefined;

  beforeEach(() => {
    originalAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
    originalProjectDir = process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    originalClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "style-drift-check-"));
    git(repoDir, ["init"]);
    git(repoDir, ["config", "user.email", "tests@example.com"]);
    git(repoDir, ["config", "user.name", "Tests"]);
  });

  afterEach(() => {
    if (originalAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = originalAdapter;
    if (originalProjectDir === undefined) delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    else process.env.AGENT_FRAMEWORK_PROJECT_DIR = originalProjectDir;
    if (originalClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalClaudeProjectDir;
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("scans tracked and non-ignored untracked text while skipping binary and symlink paths", async () => {
    fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), "Use double quotes for strings.\n");
    fs.writeFileSync(path.join(repoDir, "tracked.ts"), `export const value = ${"'tracked'"};\n`);
    git(repoDir, ["add", "CLAUDE.md", "tracked.ts"]);
    git(repoDir, ["commit", "-m", "fixtures"]);
    fs.writeFileSync(path.join(repoDir, "untracked.txt"), "\u{1F680}\n");
    fs.writeFileSync(path.join(repoDir, "binary.bin"), Buffer.from([0, 0xff, 0x01]));
    fs.symlinkSync("untracked.txt", path.join(repoDir, "linked.txt"));

    const result = await findRepositoryStyleDrift(repoDir);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "tracked.ts", kind: "quote-style" }),
      expect.objectContaining({ path: "untracked.txt", kind: "emoji" }),
    ]));
    expect(result.findings.some((item) => item.path === "binary.bin" || item.path === "linked.txt")).toBe(false);
    expect(result.skippedFiles).toContainEqual(expect.objectContaining({
      path: "linked.txt",
      reason: "symbolic link",
    }));
  });

  it("surfaces files omitted by the bounded scanner", async () => {
    const oversized = path.join(repoDir, "oversized.txt");
    fs.writeFileSync(oversized, "start");
    fs.truncateSync(oversized, 65 * 1024 * 1024);

    const result = await findRepositoryStyleDrift(repoDir);
    const warning = formatRepositoryStyleDriftWarning(result);

    expect(result.skippedFiles).toContainEqual(expect.objectContaining({
      path: "oversized.txt",
      reason: "per-file safety limit",
    }));
    expect(warning).toContain("STYLE SCAN INCOMPLETE");
    expect(warning).toContain("oversized.txt was not scanned");
  });

  it("omits within-inventory-limit high-line-count files before full-content parsing", async () => {
    const highLineCount = path.join(repoDir, "many-lines.txt");
    fs.writeFileSync(highLineCount, Buffer.alloc(3 * 1024 * 1024, 10));

    const result = await findRepositoryStyleDrift(repoDir);

    expect(result.skippedFiles).toContainEqual(expect.objectContaining({
      path: "many-lines.txt",
      reason: "per-file safety limit",
    }));
  });

  it("honors cancellation before repository scanning", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(findRepositoryStyleDrift(repoDir, { signal: controller.signal })).rejects.toMatchObject({
      name: "OperationCancelledError",
    });
  });

  it("uses only instruction files declared by the active adapter", async () => {
    fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "Use double quotes for strings.\n");
    fs.writeFileSync(path.join(repoDir, "example.ts"), `export const value = ${"'fixture'"};\n`);

    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
    expect((await findRepositoryStyleDrift(repoDir)).totalFindings).toBe(0);

    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    expect((await findRepositoryStyleDrift(repoDir)).findings).toContainEqual(
      expect.objectContaining({ path: "example.ts", kind: "quote-style" }),
    );
  });

  it("scopes adapter instructions to the repository argument despite hostile project environment", async () => {
    const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "style-drift-foreign-"));
    try {
      git(foreignDir, ["init"]);
      fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), "Use double quotes for strings.\n");
      fs.writeFileSync(path.join(repoDir, "example.ts"), `export const value = ${"'target'"};\n`);
      fs.writeFileSync(path.join(foreignDir, "CLAUDE.md"), "Use single quotes for strings.\n");
      fs.writeFileSync(path.join(foreignDir, "example.ts"), "export const value = \"foreign\";\n");
      process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
      process.env.AGENT_FRAMEWORK_PROJECT_DIR = foreignDir;
      process.env.CLAUDE_PROJECT_DIR = foreignDir;

      const targetResult = await findRepositoryStyleDrift(repoDir);
      const foreignResult = await findRepositoryStyleDrift(foreignDir);

      expect(targetResult.findings).toContainEqual(
        expect.objectContaining({ path: "example.ts", kind: "quote-style" }),
      );
      expect(foreignResult.findings).toContainEqual(
        expect.objectContaining({ path: "example.ts", kind: "quote-style" }),
      );
    } finally {
      fs.rmSync(foreignDir, { recursive: true, force: true });
    }
  });

  it("suppresses quote findings and reports conflicting adapter policies", async () => {
    fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "Use single quotes for strings.\n");
    fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), "Use double quotes for strings.\n");
    fs.writeFileSync(path.join(repoDir, "example.ts"), "export const value = \"fixture\";\n");
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";

    const result = await findRepositoryStyleDrift(repoDir);

    expect(result.findings.some((item) => item.kind === "quote-style")).toBe(false);
    expect(result.policyWarnings).toEqual([expect.stringContaining("Conflicting quote policies")]);
  });

  it("suppresses quote findings and reports conflicts within one instruction file", async () => {
    fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), "Use double quotes for strings.\nUse single quotes for strings.\n");
    fs.writeFileSync(path.join(repoDir, "example.ts"), "export const value = \"fixture\";\n");
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";

    const result = await findRepositoryStyleDrift(repoDir);

    expect(result.findings.some((item) => item.kind === "quote-style")).toBe(false);
    expect(result.policyWarnings).toEqual([expect.stringContaining("requires both double and single quotes")]);
  });
});
