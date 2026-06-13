import { describe, it, expect } from "vitest";
import {
  findDeduplicationUserRequirement,
  runConfirmPrefilter,
  formatConfirmPrefilter,
} from "../../src/utils/confirm-prefilter.js";

describe("runConfirmPrefilter — unwantedFiles", () => {
  it("flags untracked node_modules path", () => {
    const status = "?? node_modules/foo/bar.js\n";
    const r = runConfirmPrefilter(status, "");
    expect(r.unwantedFiles).toContain("node_modules/foo/bar.js");
  });

  it("flags modified .env path", () => {
    const status = "M  .env\n";
    const r = runConfirmPrefilter(status, "");
    expect(r.unwantedFiles).toContain(".env");
  });

  it("does NOT flag .env.example", () => {
    const status = "M  .env.example\n";
    const r = runConfirmPrefilter(status, "");
    expect(r.unwantedFiles).toEqual([]);
  });

  it("does NOT flag benign names containing sensitive words", () => {
    const status = "M  src/secretary.ts\nM  docs/passwordless.md\nM  mycredentials.txt\n";
    const r = runConfirmPrefilter(status, "");
    expect(r.unwantedFiles).toEqual([]);
  });

  it("flags files under sensitive directory names", () => {
    const status = "M  secrets/config.json\nA  credentials/api.yaml\n?? passwords/token.txt\n";
    const r = runConfirmPrefilter(status, "");
    expect(r.unwantedFiles).toEqual([
      "secrets/config.json",
      "credentials/api.yaml",
      "passwords/token.txt",
    ]);
  });

  it("flags added .pyc and dist/ paths", () => {
    const status = "A  dist/index.js\n?? src/foo/__pycache__/m.pyc\n";
    const r = runConfirmPrefilter(status, "");
    expect(r.unwantedFiles.some((p) => p.includes("dist/index.js"))).toBe(true);
    expect(r.unwantedFiles.some((p) => p.endsWith(".pyc"))).toBe(true);
  });

  it("flags rename destinations under unwanted paths", () => {
    const status = "R  src/index.js -> dist/index.js\n";
    const r = runConfirmPrefilter(status, "");
    expect(r.unwantedFiles).toContain("dist/index.js");
    expect(r.unwantedFiles).not.toContain("src/index.js -> dist/index.js");
  });

  it("does NOT flag clean source paths", () => {
    const status = "M  src/utils/foo.ts\n";
    const r = runConfirmPrefilter(status, "");
    expect(r.unwantedFiles).toEqual([]);
  });
});

describe("runConfirmPrefilter — debugCode (file-extension scoped)", () => {
  it("flags console.log in .ts files", () => {
    const diff = "+++ b/src/foo.ts\n+console.log('hi')\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.length).toBe(1);
    expect(r.debugCode[0].label).toContain("console.log");
    expect(r.debugCode[0].file).toBe("src/foo.ts");
  });

  it("flags debugger statement in .js files", () => {
    const diff = "+++ b/src/x.js\n+debugger;\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.some((e) => e.label.includes("debugger"))).toBe(true);
  });

  it("flags dbg!() in .rs files", () => {
    const diff = "+++ b/src/lib.rs\n+    dbg!(x);\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.some((e) => e.label.includes("dbg!"))).toBe(true);
  });

  it("flags print() in .py files (Python-only scope)", () => {
    const diff = '+++ b/scripts/foo.py\n+print("debug")\n';
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.some((e) => e.label.includes("print()"))).toBe(true);
  });

  it("does NOT flag print() in .js files (file-ext scoping prevents false positive)", () => {
    const diff = '+++ b/src/foo.js\n+print("legitimate function call")\n';
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.length).toBe(0);
  });

  it("does NOT flag console.log in .py files", () => {
    const diff = "+++ b/scripts/foo.py\n+console.log('hi')\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.length).toBe(0);
  });

  it("does NOT flag the debug-call substring inside a backtick-quoted shell command in a test fixture", () => {
    const diff =
      "+++ b/tests/utils/foo.test.ts\n" +
      "+    const cmd = `node -e 'console" + ".log(\"hi\")'`;\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.length).toBe(0);
  });

  it("does NOT flag the debug-call substring inside a // single-line comment", () => {
    const diff =
      "+++ b/src/x.ts\n" +
      "+// example: console" + ".log(\"foo\")\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.length).toBe(0);
  });

  it("does NOT flag the debug-call substring on a JSDoc continuation (leading-* line)", () => {
    const diff =
      "+++ b/src/x.ts\n" +
      "+ * @example console" + ".log(x)\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.length).toBe(0);
  });

  it("does NOT flag the debug-call substring inside a double-quoted string assignment", () => {
    const diff =
      "+++ b/src/x.ts\n" +
      "+const s = \"console" + ".log(foo)\";\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.length).toBe(0);
  });

  it("STILL flags an un-quoted real debug call at statement position", () => {
    const diff =
      "+++ b/src/x.ts\n" +
      "+console" + ".log(\"real debug\");\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.length).toBe(1);
    expect(r.debugCode[0].label).toContain("console.log");
  });

  it("STILL flags an un-quoted real debug call inside an if-block body", () => {
    const diff =
      "+++ b/src/x.ts\n" +
      "+if (x) { console" + ".log(\"real\"); }\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.debugCode.length).toBe(1);
  });
});

describe("runConfirmPrefilter — unusedCodeWorkarounds", () => {
  it("flags @ts-ignore", () => {
    const diff = "+++ b/src/x.ts\n+// @ts-ignore\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.unusedCodeWorkarounds.some((e) => e.label === "@ts-ignore")).toBe(true);
  });

  it("flags @ts-expect-error", () => {
    const diff = "+++ b/src/x.ts\n+// @ts-expect-error\n";
    const r = runConfirmPrefilter("", diff);
    expect(r.unusedCodeWorkarounds.some((e) => e.label === "@ts-expect-error")).toBe(true);
  });

  it("flags _-prefixed unused let assignment", () => {
    const diff = "+++ b/src/x.ts\n+  let _unused = compute()\n";
    const r = runConfirmPrefilter("", diff);
    expect(
      r.unusedCodeWorkarounds.some((e) => e.label === "_-prefixed unused var"),
    ).toBe(true);
  });

  it("does NOT flag _-prefixed function PARAMETERS (only top-level decls)", () => {
    const diff = "+++ b/src/x.ts\n+  function foo(_arg) {}\n";
    const r = runConfirmPrefilter("", diff);
    // The regex requires let/const/var/fn at the start of a line — function args don't match.
    expect(r.unusedCodeWorkarounds).toEqual([]);
  });

  it("flags #[allow(dead_code)] in Rust", () => {
    const diff = "+++ b/src/lib.rs\n+#[allow(dead_code)]\n";
    const r = runConfirmPrefilter("", diff);
    expect(
      r.unusedCodeWorkarounds.some((e) => e.label === "#[allow(dead_code)]"),
    ).toBe(true);
  });
});

describe("formatConfirmPrefilter", () => {
  it("returns empty string when no violations", () => {
    expect(
      formatConfirmPrefilter({ unwantedFiles: [], debugCode: [], unusedCodeWorkarounds: [] }),
    ).toBe("");
  });

  it("formats unwanted files into the precomputed-violations block", () => {
    const out = formatConfirmPrefilter({
      unwantedFiles: ["node_modules/foo.js"],
      debugCode: [],
      unusedCodeWorkarounds: [],
    });
    expect(out).toContain("PRECOMPUTED VIOLATIONS");
    expect(out).toContain("node_modules/foo.js");
  });

  it("formats debug code violations", () => {
    const out = formatConfirmPrefilter({
      unwantedFiles: [],
      debugCode: [
        { file: "src/x.ts", line: 'console.log("x")', label: "console.log/debug" },
      ],
      unusedCodeWorkarounds: [],
    });
    expect(out).toContain("CATEGORY 2");
    expect(out).toContain("console.log");
  });
});

describe("findDeduplicationUserRequirement", () => {
  it("detects explicit duplicate-code requests", () => {
    expect(
      findDeduplicationUserRequirement("please remove the duplicate code and reuse existing code"),
    ).toBe("please remove the duplicate code and reuse existing code");
  });

  it("detects generic helper requests", () => {
    expect(
      findDeduplicationUserRequirement("make this a generic helper instead of repeating the logic"),
    ).toBe("make this a generic helper instead of repeating the logic");
  });

  it("does not match unrelated generic language", () => {
    expect(findDeduplicationUserRequirement("write a generic summary of the change")).toBeUndefined();
  });
});
