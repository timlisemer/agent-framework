import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  formatToolDetail,
  readSection,
  updateSection,
  createEmptySummary,
  getSummaryPath,
} from "../../src/utils/summary-cache.js";

vi.mock("../../src/utils/cache-manager.js", () => ({
  getSessionDir: vi.fn(),
  CacheManager: vi.fn(),
  encodeProjectRoot: vi.fn(() => "test-project"),
}));

import { getSessionDir } from "../../src/utils/cache-manager.js";
const mockGetSessionDir = vi.mocked(getSessionDir);

describe("formatToolDetail", () => {
  it("returns 'Edit <path>' for Edit tool", () => {
    expect(formatToolDetail("Edit", { file_path: "/src/main.ts" })).toBe("Edit /src/main.ts");
  });

  it("truncates long Bash commands to 80 chars with '...'", () => {
    const longCommand = "a".repeat(100);
    const result = formatToolDetail("Bash", { command: longCommand });
    expect(result).toHaveLength(83); // 80 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("does not truncate short Bash commands", () => {
    expect(formatToolDetail("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("returns 'Read <path>' for Read tool", () => {
    expect(formatToolDetail("Read", { file_path: "/tmp/file.txt" })).toBe("Read /tmp/file.txt");
  });

  it("returns 'Glob <pattern>' for Glob tool", () => {
    expect(formatToolDetail("Glob", { pattern: "**/*.ts" })).toBe("Glob **/*.ts");
  });

  it("returns 'Grep <pattern>' for Grep tool", () => {
    expect(formatToolDetail("Grep", { pattern: "TODO" })).toBe("Grep TODO");
  });

  it("returns 'Write <path>' for Write tool", () => {
    expect(formatToolDetail("Write", { file_path: "/src/new.ts" })).toBe("Write /src/new.ts");
  });

  it("returns tool name for unknown tool", () => {
    expect(formatToolDetail("CustomTool", { data: "value" })).toBe("CustomTool");
  });

  it("handles missing input fields with 'unknown'", () => {
    expect(formatToolDetail("Edit", {})).toBe("Edit unknown");
    expect(formatToolDetail("Bash", {})).toBe("");
  });
});

describe("readSection (I/O)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty string when file does not exist", async () => {
    const result = await readSection(path.join(tempDir, "missing.md"), "User Intent");
    expect(result).toBe("");
  });

  it("reads existing section content", async () => {
    const filePath = path.join(tempDir, "summary.md");
    fs.writeFileSync(filePath, "## User Intent\n\nFix the auth bug\n\n## AI Actions\n\n(none)");
    const result = await readSection(filePath, "User Intent");
    expect(result).toBe("Fix the auth bug");
  });

  it("returns empty string when section heading not found", async () => {
    const filePath = path.join(tempDir, "summary.md");
    fs.writeFileSync(filePath, "## User Intent\n\nSome content");
    const result = await readSection(filePath, "Missing Section");
    expect(result).toBe("");
  });

  it("handles file with --- artifacts between sections", async () => {
    const filePath = path.join(tempDir, "summary.md");
    fs.writeFileSync(filePath, "## User Intent\n\nContent\n---\n## AI Actions\n\n(none)");
    const result = await readSection(filePath, "User Intent");
    expect(result).toBe("Content\n---");
  });
});

describe("updateSection (I/O)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates file from template if missing, then updates section", async () => {
    const filePath = path.join(tempDir, "summary.md");
    await updateSection(filePath, "User Intent", "Fix auth bug");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("## User Intent");
    expect(content).toContain("Fix auth bug");
    expect(content).toContain("## AI Actions");
  });

  it("preserves other sections when updating one", async () => {
    const filePath = path.join(tempDir, "summary.md");
    fs.writeFileSync(filePath, "## User Intent\n\nOriginal intent\n\n## AI Actions\n\nOriginal actions\n\n## Flagged Misalignments\n\n(none)");
    await updateSection(filePath, "AI Actions", "Updated actions");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("Original intent");
    expect(content).toContain("Updated actions");
    expect(content).toContain("(none)");
  });

  it("replaces section content between ## markers", async () => {
    const filePath = path.join(tempDir, "summary.md");
    fs.writeFileSync(filePath, "## User Intent\n\nOld\n\n## AI Actions\n\nOld actions");
    await updateSection(filePath, "User Intent", "New intent");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("New intent");
    expect(content).not.toContain("Old\n");
  });
});

describe("createEmptySummary (I/O)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates file with all section headers", async () => {
    const filePath = path.join(tempDir, "summary.md");
    await createEmptySummary(filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("## User Intent");
    expect(content).toContain("## User Approvals");
    expect(content).toContain("## AI Actions");
    expect(content).toContain("## Flagged Misalignments");
  });

  it("does not overwrite existing file (idempotent)", async () => {
    const filePath = path.join(tempDir, "summary.md");
    fs.writeFileSync(filePath, "## User Intent\n\nCustom content");
    await createEmptySummary(filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("Custom content");
    expect(content).not.toContain("No intent captured yet");
  });
});

describe("getSummaryPath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-path-test-"));
    mockGetSessionDir.mockReturnValue(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns summary.md in session dir", () => {
    const result = getSummaryPath("/fake/transcript.jsonl");
    expect(result).toBe(path.join(tempDir, "summary.md"));
  });

  it("migrates old slug-named .md file to summary.md", () => {
    fs.writeFileSync(path.join(tempDir, "woolly-swinging-neumann.md"), "## User Intent\n\nOld content");
    const result = getSummaryPath("/fake/transcript.jsonl");
    expect(result).toBe(path.join(tempDir, "summary.md"));
    expect(fs.existsSync(path.join(tempDir, "summary.md"))).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, "summary.md"), "utf-8")).toContain("Old content");
  });

  it("migrates old hash-named .md file to summary.md", () => {
    fs.writeFileSync(path.join(tempDir, "abc123def.md"), "## User Intent\n\nHash content");
    const result = getSummaryPath("/fake/transcript.jsonl");
    expect(result).toBe(path.join(tempDir, "summary.md"));
    expect(fs.readFileSync(path.join(tempDir, "summary.md"), "utf-8")).toContain("Hash content");
  });

  it("does not migrate when summary.md already exists", () => {
    fs.writeFileSync(path.join(tempDir, "summary.md"), "## User Intent\n\nCurrent");
    fs.writeFileSync(path.join(tempDir, "old-slug.md"), "## User Intent\n\nOld");
    getSummaryPath("/fake/transcript.jsonl");
    expect(fs.readFileSync(path.join(tempDir, "summary.md"), "utf-8")).toContain("Current");
    expect(fs.existsSync(path.join(tempDir, "old-slug.md"))).toBe(true);
  });
});

