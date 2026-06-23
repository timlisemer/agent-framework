import { describe, it, expect, vi } from "vitest";
import * as os from "os";
import * as path from "path";

vi.mock("../../src/utils/logger.js", () => ({
  logFastPathDeny: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../../src/utils/transcript.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/transcript.js")>(
    "../../src/utils/transcript.js"
  );
  return {
    ...actual,
    readTranscriptExact: vi.fn().mockResolvedValue({ user: [], assistant: [] }),
    formatTranscriptResult: vi.fn().mockReturnValue(""),
  };
});

import { styleDriftRule } from "../../src/rules/style-drift.js";
import { makeRuleContext } from "../helpers/rule-context.js";

const tempDir = os.tmpdir();

function makeCtx(overrides: Parameters<typeof makeRuleContext>[0] = {}) {
  return makeRuleContext({
    toolName: "Edit",
    toolInput: {
      file_path: path.join(tempDir, "src/foo.ts"),
      old_string: "const x = 1",
      new_string: "const x = 1",
    },
    ...overrides,
  });
}

describe("styleDriftRule — deterministic fastDeny paths", () => {
  it("returns fastDeny containing 'emoji added' when emoji is added to new_string", async () => {
    const ctx = makeCtx({
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        old_string: "const x = 'hello'",
        new_string: "const x = 'hello 🎉'",
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toContain("emoji added");
  });

  it("returns fastDeny containing 'emdash detected' when em-dash appears in new_string", async () => {
    const ctx = makeCtx({
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        old_string: "// a comment - note this",
        new_string: "// a comment — note this",
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toContain("emdash detected");
  });

  it("returns fastDeny containing 'backticks added' when only backtick additions", async () => {
    const ctx = makeCtx({
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        old_string: "// use the foo function",
        new_string: "// use the `foo` function",
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toContain("backticks added");
  });

  it("returns fastDeny containing 'quote style' when quote changed away from preference", async () => {
    const ctx = makeCtx({
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        old_string: `import { foo } from "bar"`,
        new_string: `import { foo } from 'bar'`,
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toContain("quote style");
  });

  it("checks style drift when a later multi-file patch path is eligible", async () => {
    const trustedPath = path.join(tempDir, "src/foo.ts");
    const ctx = makeCtx({
      toolInput: {
        file_path: "/etc/passwd",
        file_paths: ["/etc/passwd", trustedPath],
        old_string: "// a comment - note this",
        new_string: "// a comment — note this",
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toContain("emdash detected");
  });

  it("checks emoji additions inside MultiEdit edits", async () => {
    const ctx = makeCtx({
      toolName: "MultiEdit",
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        edits: [
          {
            old_string: "const x = 'hello'",
            new_string: "const x = 'hello 🎉'",
          },
        ],
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toContain("emoji added");
  });

  it("checks em-dash additions inside MultiEdit edits", async () => {
    const ctx = makeCtx({
      toolName: "MultiEdit",
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        edits: [
          {
            old_string: "// a comment - note this",
            new_string: "// a comment — note this",
          },
        ],
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toContain("emdash detected");
  });
});

describe("styleDriftRule — null paths (no action)", () => {
  it("returns null when tool is not Edit", async () => {
    const ctx = makeCtx({ toolName: "Bash" });
    const result = await styleDriftRule.check(ctx);
    expect(result).toBeNull();
  });

  it("returns null for sensitive path", async () => {
    const ctx = makeCtx({
      toolInput: {
        file_path: "/etc/passwd",
        old_string: "root:x:0:0",
        new_string: "root:x:0:0:",
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).toBeNull();
  });

  it("returns null for non-trusted (outside project) path", async () => {
    const ctx = makeCtx({
      projectDir: "/home/user/myproject",
      toolInput: {
        file_path: "/tmp/outside-project.ts",
        old_string: "const x = 1",
        new_string: "const x = 2",
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).toBeNull();
  });

  it("returns null for pure insertion (empty old_string)", async () => {
    const ctx = makeCtx({
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        old_string: "",
        new_string: "const x = 1",
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).toBeNull();
  });

  it("returns null for pure deletion (empty new_string)", async () => {
    const ctx = makeCtx({
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        old_string: "const x = 1",
        new_string: "",
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).toBeNull();
  });

  it("returns null when quote-only changes move toward preference (single→double)", async () => {
    const ctx = makeCtx({
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        old_string: `import { foo } from 'bar'`,
        new_string: `import { foo } from "bar"`,
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).toBeNull();
  });
});

describe("styleDriftRule — ambiguous case returns llmContext", () => {
  it("returns llmContext for semicolon/trailing-comma ambiguous changes", async () => {
    // Semicolon addition is ambiguous (user may have requested style cleanup)
    const ctx = makeCtx({
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        old_string: "const x = 1\nconst y = 2",
        new_string: "const x = 1;\nconst y = 2;",
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("llmContext");
  });

  it("returns llmContext for ambiguous MultiEdit edits", async () => {
    const ctx = makeCtx({
      toolName: "MultiEdit",
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        edits: [
          {
            old_string: "const x = 1\nconst y = 2",
            new_string: "const x = 1;\nconst y = 2;",
          },
        ],
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("llmContext");
  });

  it("includes every ambiguous MultiEdit edit in llmContext", async () => {
    const ctx = makeCtx({
      toolName: "MultiEdit",
      toolInput: {
        file_path: path.join(tempDir, "src/foo.ts"),
        edits: [
          {
            old_string: "const x = 1",
            new_string: "const x = 1;",
          },
          {
            old_string: "const y = 2",
            new_string: "const y = 2;",
          },
        ],
      },
    });
    const result = await styleDriftRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("llmContext");
    const context = (result as { llmContext: string }).llmContext;
    expect(context).toContain("Edit 1:");
    expect(context).toContain("const x = 1;");
    expect(context).toContain("Edit 2:");
    expect(context).toContain("const y = 2;");
  });
});
